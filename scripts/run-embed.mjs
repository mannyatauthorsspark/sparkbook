/**
 * Phase 3 test script — run chunking + embedding directly without Inngest.
 * Usage: node scripts/run-embed.mjs
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'

const require = createRequire(import.meta.url)

// Load env vars from .env.local
const env = readFileSync('.env.local', 'utf8')
for (const line of env.split('\n')) {
  const [key, ...rest] = line.split('=')
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim()
}

const { neon } = require('@neondatabase/serverless')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')

const PROJECT_ID = 'd8534828-4354-4955-8d9c-d693e8c1140c'
const CHUNK_CHARS = 2000
const OVERLAP_CHARS = 256
const EMBED_BATCH = 20

const sql = neon(process.env.DATABASE_URL)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

async function getFromR2(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return res.Body.transformToString()
}

async function embedTexts(texts) {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: texts }),
  })
  if (!res.ok) throw new Error(`Embeddings failed (${res.status}): ${await res.text()}`)
  const data = await res.json()
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

function chunkText(text) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + CHUNK_CHARS, text.length)
    let chunkEnd = end
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end)
      const lastNewline = text.lastIndexOf('\n', end)
      const boundary = Math.max(lastPeriod, lastNewline)
      if (boundary > start + CHUNK_CHARS * 0.5) chunkEnd = boundary + 1
    }
    const content = text.slice(start, chunkEnd).trim()
    if (content.length > 0) {
      chunks.push({ text: content, offset: start, tokenCount: Math.ceil(content.length / 4) })
    }
    start = chunkEnd - OVERLAP_CHARS
    if (start >= text.length) break
  }
  return chunks
}

async function main() {
  console.log('Fetching unchunked transcripts...')
  const transcripts = await sql`
    SELECT t.id, t.r2_key, t.source_type, t.source_confidence
    FROM transcripts t
    JOIN sources s ON s.id = t.source_id
    WHERE s.project_id = ${PROJECT_ID}
      AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.transcript_id = t.id LIMIT 1)
  `
  console.log(`Found ${transcripts.length} transcript(s) to process`)

  let totalChunks = 0

  for (const transcript of transcripts) {
    console.log(`\nProcessing transcript ${transcript.id}`)
    const text = await getFromR2(process.env.R2_BUCKET_TRANSCRIPTS, transcript.r2_key)
    console.log(`  Text length: ${text.length} chars`)

    const chunks = chunkText(text)
    console.log(`  Chunks: ${chunks.length}`)

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      console.log(`  Embedding batch ${Math.floor(i / EMBED_BATCH) + 1}/${Math.ceil(chunks.length / EMBED_BATCH)}...`)
      const embeddings = await embedTexts(batch.map(c => c.text))

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]
        const vector = `[${embeddings[j].join(',')}]`
        await sql`
          INSERT INTO chunks (
            transcript_id, project_id, content,
            token_count, chunk_offset,
            source_type, source_confidence,
            embedding
          ) VALUES (
            ${transcript.id}, ${PROJECT_ID}, ${chunk.text},
            ${chunk.tokenCount}, ${chunk.offset},
            ${transcript.source_type}, ${transcript.source_confidence},
            ${vector}::vector
          )
        `
      }
      console.log(`    Inserted ${batch.length} chunks`)
    }

    totalChunks += chunks.length
  }

  await sql`UPDATE projects SET status = 'ready' WHERE id = ${PROJECT_ID}`

  console.log(`\nDone! ${totalChunks} total chunks embedded.`)

  // Quick similarity test
  console.log('\nRunning cosine similarity test...')
  const testQuery = await embedTexts(['What is this content about?'])
  const vector = `[${testQuery[0].join(',')}]`
  const results = await sql`
    SELECT content, source_confidence,
           1 - (embedding <=> ${vector}::vector) AS similarity
    FROM chunks
    WHERE project_id = ${PROJECT_ID}
    ORDER BY embedding <=> ${vector}::vector
    LIMIT 3
  `
  console.log('\nTop 3 similar chunks:')
  for (const r of results) {
    console.log(`  [${r.similarity.toFixed(4)}] ${r.content.slice(0, 100)}...`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
