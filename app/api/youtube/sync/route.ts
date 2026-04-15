import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { sql } from '@/lib/neon'
import { inngest } from '@/inngest/client'

/**
 * POST /api/youtube/sync
 * Body: { projectId: string }
 *
 * Creates an ingestion_job record, sets project status to 'ingesting',
 * then fires the youtube/sync.requested Inngest event (non-blocking).
 * Returns immediately with the job ID — client polls for status via GET.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const projectId = body?.projectId as string | undefined

  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }

  // Verify project belongs to the authenticated user
  const rows = (await sql`
    SELECT id FROM projects
    WHERE id = ${projectId} AND user_id = ${session.user.id}
  `) as { id: string }[]
  if (!rows[0]) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Bail if a job is already running for this project
  const running = (await sql`
    SELECT id FROM ingestion_jobs
    WHERE project_id = ${projectId}
      AND platform    = 'youtube'
      AND status IN ('pending', 'running')
    LIMIT 1
  `) as { id: string }[]
  if (running[0]) {
    return NextResponse.json(
      { error: 'Ingestion already in progress', jobId: running[0].id },
      { status: 409 }
    )
  }

  // Create ingestion job
  const jobs = (await sql`
    INSERT INTO ingestion_jobs (project_id, platform, status)
    VALUES (${projectId}, 'youtube', 'pending')
    RETURNING id
  `) as { id: string }[]
  const job = jobs[0]

  // Advance project status
  await sql`
    UPDATE projects SET status = 'ingesting' WHERE id = ${projectId}
  `

  // Fire Inngest event — Inngest picks it up asynchronously
  await inngest.send({
    name: 'youtube/sync.requested',
    data: {
      projectId,
      userId: session.user.id,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      ingestionJobId: job.id,
    },
  })

  return NextResponse.json({ jobId: job.id }, { status: 202 })
}

/**
 * GET /api/youtube/sync?projectId=...
 * Poll ingestion job status for a project.
 */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const projectId = req.nextUrl.searchParams.get('projectId')
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }

  const jobRows = (await sql`
    SELECT id, status, started_at, finished_at, error
    FROM ingestion_jobs
    WHERE project_id = ${projectId} AND platform = 'youtube'
    ORDER BY created_at DESC
    LIMIT 1
  `) as {
    id: string
    status: string
    started_at: string | null
    finished_at: string | null
    error: string | null
  }[]
  const job = jobRows[0]

  if (!job) {
    return NextResponse.json({ status: 'none' })
  }

  // Count transcript progress
  const countRows = (await sql`
    SELECT
      COUNT(s.id)::int AS total,
      COUNT(t.id)::int AS transcribed
    FROM sources s
    LEFT JOIN transcripts t ON t.source_id = s.id
    WHERE s.project_id = ${projectId} AND s.platform = 'youtube'
  `) as { total: number; transcribed: number }[]
  const counts = countRows[0]

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    error: job.error,
    progress: counts ?? { total: 0, transcribed: 0 },
  })
}
