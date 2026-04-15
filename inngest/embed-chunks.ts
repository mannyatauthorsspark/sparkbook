/**
 * Inngest function: chunking + embedding pipeline
 *
 * Triggered by: chunks/embed.requested
 * Flow per transcript:
 *   1. Read raw text from R2 + split into chunks (one step)
 *   2. Embed + insert each batch of 20 chunks (one step per batch)
 *      — keeps each Vercel invocation small, avoids OOM on Hobby plan
 *   3. Set project status = 'ready'
 */

import { inngest } from './client'
import { getFromR2, BUCKETS } from '@/lib/r2'
import { embedTexts, toVectorLiteral } from '@/lib/embeddings'
import { sql } from '@/lib/neon'

const CHUNK_CHARS = 2000    // ≈ 512 tokens (1 token ≈ 4 chars)
const OVERLAP_CHARS = 256   // ≈ 64 tokens overlap
const EMBED_BATCH = 10      // reduced from 20 to keep memory low per step

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

    let totalChunks = 0

    for (const transcript of transcripts) {
      // ── 2. Read + chunk the transcript (one small step) ───────────────────
      const chunks = await step.run(`chunk-${transcript.id}`, async () => {
        const text = await getFromR2(BUCKETS.transcripts, transcript.r2_key)
        return chunkText(text)
      })

      totalChunks += chunks.length

      // ── 3. Embed + insert one batch per step ─────────────────────────────
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH)
        const batchIndex = Math.floor(i / EMBED_BATCH)

        await step.run(`embed-insert-${transcript.id}-batch-${batchIndex}`, async () => {
          const embeddings = await embedTexts(batch.map((c) => c.text))

          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j]
            const vector = toVectorLiteral(embeddings[j])

            await sql`
              INSERT INTO chunks (
                transcript_id, project_id, content,
                token_count, chunk_offset,
                source_type, source_confidence,
                embedding
              ) VALUES (
                ${transcript.id}, ${projectId}, ${chunk.text},
                ${chunk.tokenCount}, ${chunk.offset},
                ${transcript.source_type}, ${transcript.source_confidence},
                ${vector}::vector
              )
            `
          }
        })
      }
    }

    // ── 4. Advance project to 'ready' ────────────────────────────────────────
    await step.run('mark-project-ready', async () => {
      await sql`UPDATE projects SET status = 'ready' WHERE id = ${projectId}`
    })

    return { transcripts: transcripts.length, chunks: totalChunks }
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
