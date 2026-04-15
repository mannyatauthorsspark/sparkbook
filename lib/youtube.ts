/**
 * YouTube Data API v3 helpers
 *
 * Uses the authenticated user's OAuth access token (stored in session).
 * Required scopes: youtube.readonly, youtube.force-ssl
 *
 * The user must OWN the videos — captions download requires channel ownership.
 */

const YT_API = 'https://www.googleapis.com/youtube/v3'

/** Exchange a refresh token for a fresh access token */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${body}`)
  }
  const data = await res.json()
  return data.access_token as string
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface YTVideo {
  id: string
  title: string
  url: string
  duration_s: number | null
}

export type CaptionTrackKind = 'standard' | 'asr' | 'forced'

export interface CaptionTrack {
  id: string
  kind: CaptionTrackKind
  language: string
}

// ── Video catalog ─────────────────────────────────────────────────────────────

/**
 * Fetch every video in the authenticated user's channel.
 * Paginates through the full uploads playlist — no 10-video cap.
 */
export async function fetchAllVideos(accessToken: string): Promise<YTVideo[]> {
  // 1. Get the uploads playlist ID for the authenticated channel
  const channelRes = await ytGet('/channels', accessToken, {
    part: 'contentDetails',
    mine: 'true',
  })

  const uploadsId =
    channelRes.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsId) return [] // account has no YouTube channel — return empty

  // 2. Page through the playlist to collect all video IDs
  const videos: YTVideo[] = []
  let pageToken: string | undefined

  do {
    const params: Record<string, string> = {
      part: 'snippet',
      playlistId: uploadsId,
      maxResults: '50',
    }
    if (pageToken) params.pageToken = pageToken

    const page = await ytGet('/playlistItems', accessToken, params)

    const videoIds: string[] = (page.items ?? []).map(
      (item: any) => item.snippet.resourceId.videoId as string
    )

    // 3. Batch-fetch duration + full snippet for this page
    if (videoIds.length > 0) {
      const details = await ytGet('/videos', accessToken, {
        part: 'snippet,contentDetails',
        id: videoIds.join(','),
      })
      for (const v of details.items ?? []) {
        videos.push({
          id: v.id,
          title: v.snippet.title,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          duration_s: iso8601ToSeconds(v.contentDetails.duration),
        })
      }
    }

    pageToken = page.nextPageToken
  } while (pageToken)

  return videos
}

// ── Captions ──────────────────────────────────────────────────────────────────

/**
 * List caption tracks for a video owned by the authenticated user.
 * Sorted: standard English first, asr English second, others last.
 */
export async function listCaptionTracks(
  accessToken: string,
  videoId: string
): Promise<CaptionTrack[]> {
  const res = await ytGet('/captions', accessToken, {
    part: 'snippet',
    videoId,
  })

  return (res.items ?? [])
    .filter((item: any) =>
      ['standard', 'asr'].includes(item.snippet.trackKind)
    )
    .map((item: any) => ({
      id: item.id,
      kind: item.snippet.trackKind as CaptionTrackKind,
      language: item.snippet.language as string,
    }))
    .sort((a: CaptionTrack, b: CaptionTrack) => {
      const kindPriority = (k: CaptionTrackKind) => (k === 'standard' ? 0 : 1)
      const langPriority = (l: string) => (l.startsWith('en') ? 0 : 1)
      return (
        kindPriority(a.kind) - kindPriority(b.kind) ||
        langPriority(a.language) - langPriority(b.language)
      )
    })
}

/**
 * Download a caption track and return clean prose text (no timestamps).
 * Uses SRT format — strips sequence numbers and timestamp lines.
 */
export async function downloadCaption(
  accessToken: string,
  captionId: string
): Promise<string> {
  const res = await fetch(`${YT_API}/captions/${captionId}?tfmt=srt`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Caption download failed (${res.status}): ${body}`)
  }

  const srt = await res.text()
  return stripSrt(srt)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ytGet(
  path: string,
  accessToken: string,
  params: Record<string, string>
): Promise<any> {
  const url = new URL(`${YT_API}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`YouTube API ${path} error (${res.status}): ${body}`)
  }

  return res.json()
}

/** Strip SRT sequence numbers and timestamp lines, return clean prose */
function stripSrt(srt: string): string {
  return srt
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (/^\d+$/.test(t)) return false // sequence number
      if (/^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*/.test(t)) return false // timestamp
      return true
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Convert ISO 8601 duration string (e.g. PT4M13S) to total seconds */
function iso8601ToSeconds(duration: string): number | null {
  if (!duration) return null
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return null
  return (
    parseInt(match[1] ?? '0') * 3600 +
    parseInt(match[2] ?? '0') * 60 +
    parseInt(match[3] ?? '0')
  )
}
