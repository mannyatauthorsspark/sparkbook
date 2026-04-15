import http from 'http'
import { serve } from 'inngest/node'
import { inngest } from '../inngest/client'
import { ingestYoutube } from '../inngest/ingest-youtube'
import { embedChunks } from '../inngest/embed-chunks'

const PORT = 3001

const handler = serve({
  client: inngest,
  functions: [ingestYoutube, embedChunks],
})

http.createServer(handler).listen(PORT, () => {
  console.log(`Inngest worker → http://localhost:${PORT}/api/inngest`)
})
