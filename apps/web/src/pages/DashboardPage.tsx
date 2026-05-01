import React, { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'

export function DashboardPage({ token }: { token: string }) {
  const [health, setHealth] = useState<{ ok: boolean; env: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiGet<{ ok: boolean; env: string }>('/api/health', token)
        if (!cancelled) setHealth(res)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token])

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
      </div>
    </div>
  )
}

