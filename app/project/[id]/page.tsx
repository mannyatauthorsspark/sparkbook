'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

interface JobStatus {
  status: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  progress: { total: number; transcribed: number }
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const [syncing, setSyncing] = useState(false)
  const [job, setJob] = useState<JobStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Poll job status while ingestion is running
  useEffect(() => {
    if (!job || ['done', 'failed', 'none'].includes(job.status)) return
    const interval = setInterval(async () => {
      const res = await fetch(`${window.location.origin}/api/youtube/sync?projectId=${id}`)
      const data = await res.json()
      setJob(data)
    }, 3000)
    return () => clearInterval(interval)
  }, [id, job])

  async function startSync() {
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch(`${window.location.origin}/api/youtube/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Sync failed')
      } else {
        // Start polling
        setJob({ status: 'pending', startedAt: null, finishedAt: null, error: null, progress: { total: 0, transcribed: 0 } })
      }
    } catch (e) {
      setError('Network error')
    } finally {
      setSyncing(false)
    }
  }

  const isRunning = job && ['pending', 'running'].includes(job.status)

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8">
      <div className="max-w-2xl mx-auto">
        <a href="/dashboard" className="text-neutral-500 text-sm hover:text-white mb-6 inline-block">
          ← Dashboard
        </a>

        <h1 className="text-2xl font-bold mb-2">My Book</h1>
        <p className="text-neutral-500 text-sm mb-8 font-mono">{id}</p>

        {/* YouTube Sync */}
        <div className="bg-neutral-900 rounded-xl p-6 mb-6">
          <h2 className="font-medium mb-1">YouTube Sync</h2>
          <p className="text-neutral-500 text-sm mb-4">
            Pull transcripts from your entire YouTube channel.
          </p>

          <button
            onClick={startSync}
            disabled={syncing || !!isRunning}
            className="px-4 py-2 bg-white text-neutral-900 rounded-lg text-sm font-medium hover:bg-neutral-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isRunning ? 'Syncing…' : 'Sync YouTube'}
          </button>

          {error && (
            <p className="mt-3 text-red-400 text-sm">{error}</p>
          )}

          {job && job.status !== 'none' && (
            <div className="mt-4 space-y-1 text-sm">
              <p className="text-neutral-400">
                Status: <span className="text-white capitalize">{job.status}</span>
              </p>
              {job.progress.total > 0 && (
                <p className="text-neutral-400">
                  Transcripts:{' '}
                  <span className="text-white">
                    {job.progress.transcribed} / {job.progress.total}
                  </span>
                </p>
              )}
              {job.error && (
                <p className="text-red-400">Error: {job.error}</p>
              )}
              {job.status === 'done' && (
                <p className="text-green-400">✓ Sync complete</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
