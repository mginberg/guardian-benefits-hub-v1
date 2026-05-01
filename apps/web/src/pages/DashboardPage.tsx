import React, { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'

type UnlStatus = {
  sftp_ok?: boolean
  sftp_error?: string | null
  last_import_at?: string | null
  last_import_file?: string | null
  unrouted_rows_total?: number
}

type JobResponse = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error?: string | null
}

export function DashboardPage({ token }: { token: string }) {
  const [health, setHealth] = useState<{ ok: boolean; env: string } | null>(null)
  const [error, setError] = useState('')
  const [unlStatus, setUnlStatus] = useState<UnlStatus | null>(null)
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<JobResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiGet<{ ok: boolean; env: string }>('/api/health', token)
        if (!cancelled) setHealth(res)
        const s = await apiGet<UnlStatus>('/api/unl/status', token)
        if (!cancelled) setUnlStatus(s)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const j = await apiGet<JobResponse>(`/api/jobs/${jobId}`, token)
        if (!cancelled) setJob(j)
        if (j?.status === 'succeeded' || j?.status === 'failed') {
          clearInterval(interval)
          const s = await apiGet<UnlStatus>('/api/unl/status', token)
          if (!cancelled) setUnlStatus(s)
        }
      } catch {
        // ignore transient
      }
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [jobId, token])

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>V1 Dashboard</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            This is the clean-slate V1 scaffold. Next we’ll add UNL book reporting + instant leaderboard + reconciliation.
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div style={{ borderRadius: 16, padding: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800, letterSpacing: 0.2 }}>API Health</div>
          <div style={{ marginTop: 8, fontSize: 16, fontWeight: 950 }}>
            {health ? (health.ok ? 'OK' : 'Down') : error ? 'Error' : 'Loading…'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>env: {health?.env || '—'}</div>
          {error && <div style={{ marginTop: 10, fontSize: 12, color: '#fecaca' }}>{error}</div>}
        </div>

        <div style={{ borderRadius: 16, padding: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800, letterSpacing: 0.2 }}>UNL SFTP</div>
          <div style={{ marginTop: 8, fontSize: 14, fontWeight: 900 }}>
            {unlStatus?.last_import_at ? 'Imported' : 'No imports yet'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            last file: {unlStatus?.last_import_file || '—'}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            unrouted rows: {unlStatus?.unrouted_rows_total ?? '—'}
          </div>
          {unlStatus?.sftp_error && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#fecaca' }}>
              SFTP error: {String(unlStatus.sftp_error)}
            </div>
          )}
          <button
            onClick={async () => {
              const res = await apiPost<{ job_id: string }>('/api/jobs/unl-import-latest', {}, token)
              setJobId(res.job_id)
              setJob(null)
            }}
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 12,
              border: '1px solid rgba(201,168,76,0.35)',
              background: 'rgba(201,168,76,0.12)',
              color: '#f5f3e6',
              fontWeight: 900,
              cursor: 'pointer',
            }}
          >
            Queue UNL Import
          </button>
          {jobId && (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
              Job: {jobId.slice(0, 8)}… · {job?.status || 'queued'}
            </div>
          )}
          {job?.error && <div style={{ marginTop: 6, fontSize: 12, color: '#fecaca' }}>{job.error}</div>}
        </div>
      </div>
    </div>
  )
}

