/**
 * Inngest function: chunking + embedding pipeline
 *
 * Triggered by: chunks/embed.requested
 * Flow per transcript:
 *   1. Read raw text from R2
 *   2. Split into ~512-token chunks (2000 chars) with 64-token overlap (256 chars)
 *      — breaks at sentence boundaries where possible
 *   3. Batch embed chunks via OpenRouter (text-embedding-3-small, 20 per call)
 *   4. Insert chunk rows + vector embeddings into Neon
 * On completion: set project status = 'ready'
 */

import { inngest } from './client'
import { getFromR2, BUCKETS } from '@/lib/r2'
import { embedTexts, toVectorLiteral } from '@/lib/embeddings'
import { sql } from '@/lib/neon'

const CHUNK_CHARS = 2000    // ≈ 512 tokens (1 token ≈ 4 chars)
const OVERLAP_CHARS = 256   // ≈ 64 tokens overlap
const EMBED_BATCH = 20      // texts per OpenRouter embeddings call

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

    // ── 2. Chunk + embed each transcript ────────────────────────────────────
    let totalChunks = 0

    for (const transcript of transcripts) {
      const count = await step.run(`chunk-embed-${transcript.id}`, async () => {
        const text = await getFromR2(BUCKETS.transcripts, transcript.r2_key)
        const chunks = chunkText(text)

        // Embed in batches of EMBED_BATCH
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          const batch = chunks.slice(i, i + EMBED_BATCH)
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
        }

        return chunks.length
      })

      totalChunks += count
    }

    // ── 3. Advance project to 'ready' ────────────────────────────────────────
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

/**
 * Split text into overlapping chunks, preferring sentence boundaries.
 * Rough token estimate: 1 token ≈ 4 characters.
 */
function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length)
    let chunkEnd = end

    // Prefer to break at a sentence boundary (. or newline) in the back half
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
