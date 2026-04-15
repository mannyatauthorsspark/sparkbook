import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { ingestYoutube } from '@/inngest/ingest-youtube'
import { embedChunks } from '@/inngest/embed-chunks'

export const runtime = 'nodejs'
export const maxDuration = 300

// Inngest requires GET + POST + PUT on this route
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [ingestYoutube, embedChunks],
})
