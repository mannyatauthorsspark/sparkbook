/**
 * Embeddings via OpenRouter → openai/text-embedding-3-small
 * Same API shape as OpenAI — just different base URL and key.
 */

const OPENROUTER_API = 'https://openrouter.ai/api/v1'
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Embed a batch of texts. Returns embeddings in the same order as input.
 * Max ~20 texts per call to stay well under rate limits.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${OPENROUTER_API}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Embeddings API failed (${res.status}): ${body}`)
  }

  const data = await res.json()
  return (data.data as { index: number; embedding: number[] }[])
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding)
}

/** Embed a single text. */
export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text])
  return embedding
}

/** Format a float array as a pgvector literal: '[0.1,0.2,...]' */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}
