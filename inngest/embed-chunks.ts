/**
 * Inngest function: chunking + embedding pipeline
 *
 * Triggered by: chunks/embed.requested
 * Flow:
 *   1. For each transcript: read R2, chunk, INSERT all rows with embedding = NULL
 *   2. Loop: SELECT 10 unembedded chunks → embed → UPDATE — repeat until done
 *   3. Set project status = 'ready'
 *
 * No large arrays passed through Inngest state — each step is small and safe on Hobby plan.
 */

import { inngest } from './client'
import { getFromR2, BUCKETS } from '@/lib/r2'
import { embedTexts, toVectorLiteral } from '@/lib/embeddings'
import { sql } from '@/lib/neon'

const CHUNK_CHARS = 2000
const OVERLAP_CHARS = 256
const EMBED_BATCH = 10

export const embedChunks = inngest.createFunction(
  {
    id: 'embed-chunks',
    triggers: [{ event: 'chunks/embed.requested' }],
    concurrency: { limit: 3 },
  },
  async ({ event, step }) => {
    const { projectId } = event.data as { projectId: string }

    // ── 1. Find transcripts not yet chunked ──────────────────────────────────
    const transcripts = await step.run('get-unchunked-transcripts', async () => {
      return (await sql`
        SELECT t.id, t.r2_key, t.source_type, t.source_confidence
        FROM transcripts t
        JOIN sources s ON s.id = t.source_id
        WHERE s.project_id = ${projectId}
          AND NOT EXISTS (
            SELECT 1 FROM chunks c WHERE c.transcript_id = t.id LIMIT 1
          )
      `) as {
        id: string
        r2_key: string
        source_type: string
        source_confidence: number
      }[]
    })

    if (transcripts.length === 0) {
      return { transcripts: 0, chunks: 0 }
    }

    // ── 2. Chunk each transcript → write to DB without embeddings ────────────
    for (const transcript of transcripts) {
      await step.run(`chunk-${transcript.id}`, async () => {
        const text = await getFromR2(BUCKETS.transcripts, transcript.r2_key)
        const chunks = chunkText(text)

        for (const chunk of chunks) {
          await sql`
            INSERT INTO chunks (
              transcript_id, project_id, content,
              token_count, chunk_offset,
              source_type, source_confidence
            ) VALUES (
              ${transcript.id}, ${projectId}, ${chunk.text},
              ${chunk.tokenCount}, ${chunk.offset},
              ${transcript.source_type}, ${transcript.source_confidence}
            )
          `
        }

        return chunks.length
      })
    }

    // ── 3. Embed in DB-driven batches (no large arrays in Inngest state) ─────
    let batchIndex = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const done = await step.run(`embed-batch-${batchIndex}`, async () => {
        const rows = (await sql`
          SELECT id, content
          FROM chunks
          WHERE project_id = ${projectId}
            AND embedding IS NULL
          LIMIT ${EMBED_BATCH}
        `) as { id: string; content: string }[]

        if (rows.length === 0) return true

        const embeddings = await embedTexts(rows.map((r) => r.content))

        for (let i = 0; i < rows.length; i++) {
          const vector = toVectorLiteral(embeddings[i])
          await sql`
            UPDATE chunks SET embedding = ${vector}::vector
            WHERE id = ${rows[i].id}
          `
        }

        return false
      })

      if (done) break
      batchIndex++
    }

    // ── 4. Mark project ready ────────────────────────────────────────────────
    await step.run('mark-project-ready', async () => {
      await sql`UPDATE projects SET status = 'ready' WHERE id = ${projectId}`
    })

    return { transcripts: transcripts.length }
  }
)

// ── Text chunking ─────────────────────────────────────────────────────────────

interface TextChunk {
  text: string
  offset: number
  tokenCount: number
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length)
    let chunkEnd = end

    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end)
      const lastNewline = text.lastIndexOf('\n', end)
      const boundary = Math.max(lastPeriod, lastNewline)
      if (boundary > start + CHUNK_CHARS * 0.5) {
        chunkEnd = boundary + 1
      }
    }

    const content = text.slice(start, chunkEnd).trim()
    if (content.length > 0) {
      chunks.push({
        text: content,
        offset: start,
        tokenCount: Math.ceil(content.length / 4),
      })
    }

    start = chunkEnd - OVERLAP_CHARS
    if (start >= text.length) break
  }

  return chunks
}
