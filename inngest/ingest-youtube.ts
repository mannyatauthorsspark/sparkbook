/**
 * Inngest function: YouTube transcript ingestion pipeline
 *
 * Triggered by: youtube/sync.requested
 * Flow per video:
 *   1. Native captions (trackKind=standard) → source_type: native_captions, confidence: 1.0
 *   2. Auto-generated captions (trackKind=asr) → source_type: downloaded,    confidence: 0.85
 *   3. Neither available → emits youtube/whisper.requested (handled in Phase 3)
 *
 * Each video is its own step so Inngest can retry them independently.
 */

import { inngest } from './client'
import {
  fetchAllVideos,
  listCaptionTracks,
  downloadCaption,
  refreshAccessToken,
  type YTVideo,
} from '@/lib/youtube'
import { uploadToR2, BUCKETS } from '@/lib/r2'
import { sql } from '@/lib/neon'

export const ingestYoutube = inngest.createFunction(
  {
    id: 'ingest-youtube',
    triggers: [{ event: 'youtube/sync.requested' }],
    concurrency: { limit: 3 }, // max 3 concurrent ingestion jobs globally
  },
  async ({ event, step }) => {
    const { projectId, userId, ingestionJobId } =
      event.data as {
        projectId: string
        userId: string
        accessToken: string
        refreshToken: string
        ingestionJobId: string
      }

    // ── 1. Refresh access token (always refresh — event token may be stale) ─
    const accessToken = await step.run('refresh-access-token', async () => {
      return refreshAccessToken(event.data.refreshToken as string)
    })

    // ── 2. Mark job running ─────────────────────────────────────────────────
    await step.run('mark-job-running', async () => {
      await sql`
        UPDATE ingestion_jobs
        SET status = 'running', started_at = NOW()
        WHERE id = ${ingestionJobId}
      `
    })

    // ── 2. Fetch full video catalog ──────────────────────────────────────────
    const videos = await step.run('fetch-video-catalog', async () => {
      return fetchAllVideos(accessToken)
    })

    // ── 3. Upsert source rows ────────────────────────────────────────────────
    await step.run('upsert-sources', async () => {
      for (const video of videos) {
        await sql`
          INSERT INTO sources
            (project_id, ingestion_job_id, platform, external_id, title, url, duration_s)
          VALUES
            (${projectId}, ${ingestionJobId}, 'youtube',
             ${video.id}, ${video.title}, ${video.url}, ${video.duration_s})
          ON CONFLICT (project_id, platform, external_id) DO UPDATE
            SET title      = EXCLUDED.title,
                url        = EXCLUDED.url,
                duration_s = EXCLUDED.duration_s
        `
      }
    })

    // ── 4. Process each video (one step per video for granular retries) ──────
    let captioned = 0
    let needsWhisper = 0
    let skipped = 0

    for (const video of videos) {
      const result = await step.run(
        `transcript-${video.id}`,
        async () => transcriptForVideo({ projectId, userId, accessToken, video })
      )

      if (result.status === 'ok') {
        captioned++
      } else if (result.status === 'needs-whisper') {
        needsWhisper++
        // Queue Whisper fallback — handled in Phase 3 (inngest/whisper-fallback.ts)
        await step.sendEvent(`whisper-${video.id}`, {
          name: 'youtube/whisper.requested',
          data: {
            projectId,
            userId,
            sourceExternalId: video.id,
            videoTitle: video.title,
            ingestionJobId,
          },
        })
      } else {
        skipped++
      }
    }

    // ── 5. Mark job done, update project status ──────────────────────────────
    await step.run('mark-job-done', async () => {
      await sql`
        UPDATE ingestion_jobs
        SET status = 'done', finished_at = NOW()
        WHERE id = ${ingestionJobId}
      `
      const nextStatus = needsWhisper > 0 ? 'ingesting' : 'embedding'
      await sql`
        UPDATE projects SET status = ${nextStatus} WHERE id = ${projectId}
      `
    })

    // ── 6. Kick off chunking + embedding for all downloaded transcripts ──────
    await step.sendEvent('trigger-embed', {
      name: 'chunks/embed.requested',
      data: { projectId },
    })

    return { total: videos.length, captioned, needsWhisper, skipped }
  }
)

// ── Per-video transcript logic ────────────────────────────────────────────────

type TranscriptResult =
  | { status: 'ok'; sourceType: string }
  | { status: 'needs-whisper' }
  | { status: 'skipped'; reason: string }

async function transcriptForVideo({
  projectId,
  userId,
  accessToken,
  video,
}: {
  projectId: string
  userId: string
  accessToken: string
  video: YTVideo
}): Promise<TranscriptResult> {
  // Look up the source row (just upserted)
  const [source] = (await sql`
    SELECT id FROM sources
    WHERE project_id = ${projectId}
      AND platform    = 'youtube'
      AND external_id = ${video.id}
  `) as { id: string }[]
  if (!source) return { status: 'skipped', reason: 'source row not found' }

  // Skip if already transcribed (idempotent re-runs)
  const [existing] = (await sql`
    SELECT id FROM transcripts WHERE source_id = ${source.id}
  `) as { id: string }[]
  if (existing) return { status: 'ok', sourceType: 'cached' }

  // List available caption tracks
  let tracks
  try {
    tracks = await listCaptionTracks(accessToken, video.id)
  } catch {
    return { status: 'needs-whisper' }
  }

  if (tracks.length === 0) return { status: 'needs-whisper' }

  // Try tracks in priority order (standard English → asr English → anything else)
  let text: string | null = null
  let usedTrack = tracks[0]

  for (const track of tracks) {
    try {
      const raw = await downloadCaption(accessToken, track.id)
      if (raw && raw.length >= 50) {
        text = raw
        usedTrack = track
        break
      }
    } catch {
      // try next track
    }
  }

  if (!text) return { status: 'needs-whisper' }

  // Upload transcript text to R2
  const r2Key = `transcripts/${userId}/${source.id}.txt`
  await uploadToR2(BUCKETS.transcripts, r2Key, text, 'text/plain')

  // Determine confidence by track kind
  const sourceType =
    usedTrack.kind === 'standard' ? 'native_captions' : 'downloaded'
  const sourceConfidence = usedTrack.kind === 'standard' ? 1.0 : 0.85

  // Record in Neon
  await sql`
    INSERT INTO transcripts (source_id, r2_key, source_type, source_confidence)
    VALUES (${source.id}, ${r2Key}, ${sourceType}, ${sourceConfidence})
    ON CONFLICT DO NOTHING
  `

  return { status: 'ok', sourceType }
}
