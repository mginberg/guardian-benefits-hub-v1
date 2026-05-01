import React, { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../lib/api'

type Summary = {
  total_policies: number
  total_annual_premium: number
  by_agency: Array<{ slug: string; name: string; policies: number; annual_premium: number }>
  by_classification: Array<{ classification: string; policies: number; annual_premium: number }>
}

type PolicyRow = {
  agency_slug: string
  agency_name: string
  policy_number: string
  wa_code: string
  agent_name: string
  issue_date?: string | null
  paid_to_date?: string | null
  annual_premium: number
  classification: string
}

type Policies = { rows: PolicyRow[] }

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 16,
        padding: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 900, letterSpacing: 0.2 }}>{title}</div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  )
}

function money(n: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
  } catch {
    return `$${Math.round(n).toLocaleString()}`
  }
}

export function PolicyBookPage({ token, me }: { token: string; me: { role: string; agency_id: string } }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [policies, setPolicies] = useState<Policies | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const qs = useMemo(() => {
    const params = new URLSearchParams()
    if (start) params.set('start', start)
    if (end) params.set('end', end)
    return params.toString() ? `?${params.toString()}` : ''
  }, [start, end])

  async function load() {
    setError('')
    setLoading(true)
    try {
      const [s, p] = await Promise.all([
        apiGet<Summary>(`/api/policy-book/summary${qs}`, token),
        apiGet<Policies>(`/api/policy-book/policies${qs}&limit=200`.replace('?&', '?'), token),
      ])
      setSummary(s)
      setPolicies(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load policy book')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, qs])

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Policy Book</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            UNL policy book (from nightly SFTP import). {me.role === 'super_admin' ? 'Super admin view.' : 'Scoped to your agency.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, opacity: 0.8 }}>
            Start (issue date)
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="YYYY-MM-DD"
              style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, opacity: 0.8 }}>
            End (issue date)
            <input
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="YYYY-MM-DD"
              style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
            />
          </label>
          <button
            onClick={() => {
              setStart('')
              setEnd('')
            }}
            style={{
              alignSelf: 'end',
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              color: '#e5e7eb',
              fontWeight: 900,
              cursor: 'pointer',
              height: 42,
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: '#fecaca', border: '1px solid rgba(254,202,202,0.35)', background: 'rgba(254,202,202,0.06)', padding: 12, borderRadius: 14 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ opacity: 0.8 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Card title="Total policies">
              <div style={{ fontSize: 20, fontWeight: 950 }}>{summary?.total_policies?.toLocaleString() || '0'}</div>
            </Card>
            <Card title="Total annual premium">
              <div style={{ fontSize: 20, fontWeight: 950 }}>{money(summary?.total_annual_premium || 0)}</div>
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <Card title="By agency (top)">
              <div style={{ display: 'grid', gap: 6 }}>
                {(summary?.by_agency || []).slice(0, 10).map((a) => (
                  <div key={a.slug} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 900 }}>{a.name}</div>
                    <div style={{ opacity: 0.8 }}>
                      {a.policies} · {money(a.annual_premium)}
                    </div>
                  </div>
                ))}
                {!summary?.by_agency?.length && <div style={{ fontSize: 12, opacity: 0.7 }}>No data yet.</div>}
              </div>
            </Card>

            <Card title="By classification">
              <div style={{ display: 'grid', gap: 6 }}>
                {(summary?.by_classification || []).map((c) => (
                  <div key={c.classification} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 900 }}>{c.classification}</div>
                    <div style={{ opacity: 0.8 }}>
                      {c.policies} · {money(c.annual_premium)}
                    </div>
                  </div>
                ))}
                {!summary?.by_classification?.length && <div style={{ fontSize: 12, opacity: 0.7 }}>No data yet.</div>}
              </div>
            </Card>
          </div>

          <Card title="Latest policies (sample)">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ fontSize: 12, opacity: 0.75, textAlign: 'left' }}>
                    <th style={{ padding: '10px 8px' }}>Agency</th>
                    <th style={{ padding: '10px 8px' }}>Policy #</th>
                    <th style={{ padding: '10px 8px' }}>Agent</th>
                    <th style={{ padding: '10px 8px' }}>Issue</th>
                    <th style={{ padding: '10px 8px' }}>Paid-to</th>
                    <th style={{ padding: '10px 8px' }}>Annual prem</th>
                    <th style={{ padding: '10px 8px' }}>Class</th>
                  </tr>
                </thead>
                <tbody>
                  {(policies?.rows || []).slice(0, 200).map((r, idx) => (
                    <tr key={`${r.policy_number}-${idx}`} style={{ fontSize: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 900 }}>{r.agency_name}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.9 }}>{r.policy_number || '—'}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.9 }}>{r.agent_name || '—'}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.85 }}>{r.issue_date || '—'}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.85 }}>{r.paid_to_date || '—'}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.9 }}>{money(r.annual_premium || 0)}</td>
                      <td style={{ padding: '10px 8px', opacity: 0.9 }}>{r.classification || 'unknown'}</td>
                    </tr>
                  ))}
                  {!policies?.rows?.length && (
                    <tr>
                      <td colSpan={7} style={{ padding: 12, fontSize: 12, opacity: 0.7 }}>
                        No policies yet. Run an import or wait for the nightly SFTP pull.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

