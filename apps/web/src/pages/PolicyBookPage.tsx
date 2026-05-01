import React, { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../lib/api'

type Summary = {
  total_policies: number
  total_annual_premium: number
  by_agency: Array<{ slug: string; name: string; policies: number; annual_premium: number }>
  by_classification: Array<{ classification: string; policies: number; annual_premium: number }>
}

type Agency = {
  id: string
  slug: string
  name: string
  is_active: boolean
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

function iso(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function PillButton({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 10px',
        borderRadius: 999,
        border: active ? '1px solid rgba(201,168,76,0.35)' : '1px solid rgba(255,255,255,0.14)',
        background: active ? 'rgba(201,168,76,0.10)' : 'rgba(255,255,255,0.06)',
        color: '#e5e7eb',
        fontWeight: 900,
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      {children}
    </button>
  )
}

export function PolicyBookPage({ token, me }: { token: string; me: { role: string; agency_id: string } }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [policies, setPolicies] = useState<Policies | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const [agencies, setAgencies] = useState<Agency[]>([])
  const [agencyId, setAgencyId] = useState('')

  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const qs = useMemo(() => {
    const params = new URLSearchParams()
    if (start) params.set('start', start)
    if (end) params.set('end', end)
    if (agencyId) params.set('agency_id', agencyId)
    return params
  }, [start, end, agencyId])

  async function load() {
    setError('')
    setLoading(true)
    try {
      const summaryParams = new URLSearchParams(qs)
      const policiesParams = new URLSearchParams(qs)
      policiesParams.set('limit', '200')

      const summaryQs = summaryParams.toString()
      const policiesQs = policiesParams.toString()

      const [s, p] = await Promise.all([
        apiGet<Summary>(`/api/policy-book/summary${summaryQs ? `?${summaryQs}` : ''}`, token),
        apiGet<Policies>(`/api/policy-book/policies${policiesQs ? `?${policiesQs}` : ''}`, token),
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
    let cancelled = false
    async function loadAgencies() {
      if (me.role !== 'super_admin') {
        setAgencyId('')
        return
      }
      try {
        const res = await apiGet<{ agencies: Agency[] }>('/api/agencies', token)
        if (cancelled) return
        const actives = (res.agencies || []).filter((a) => a.is_active).sort((a, b) => a.slug.localeCompare(b.slug))
        setAgencies(actives)
      } catch {
        // ignore; selector just won't populate
      }
    }
    loadAgencies()
    return () => {
      cancelled = true
    }
  }, [me.role, token])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, qs])

  const chart = useMemo(() => {
    const items = (summary?.by_agency || []).slice(0, 8)
    const max = Math.max(1, ...items.map((x) => x.annual_premium || 0))
    return { items, max }
  }, [summary?.by_agency])

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Policy Book</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            UNL policy book (from nightly SFTP import). {me.role === 'super_admin' ? 'Super admin view.' : 'Scoped to your agency.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {me.role === 'super_admin' && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12, opacity: 0.8, minWidth: 220 }}>
              Agency
              <select
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
                style={{
                  padding: 10,
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(0,0,0,0.18)',
                  color: '#e5e7eb',
                  height: 42,
                }}
              >
                <option value="">All agencies</option>
                {agencies.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.slug})
                  </option>
                ))}
              </select>
            </label>
          )}
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
              setAgencyId('')
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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <PillButton
          onClick={() => {
            const d = new Date()
            setStart(iso(d))
            setEnd(iso(d))
          }}
          active={!!start && start === end}
        >
          Today
        </PillButton>
        <PillButton
          onClick={() => {
            const endD = new Date()
            const startD = new Date()
            startD.setDate(endD.getDate() - 6)
            setStart(iso(startD))
            setEnd(iso(endD))
          }}
        >
          Last 7 days
        </PillButton>
        <PillButton
          onClick={() => {
            const endD = new Date()
            const startD = new Date(endD.getFullYear(), endD.getMonth(), 1)
            setStart(iso(startD))
            setEnd(iso(endD))
          }}
        >
          MTD
        </PillButton>
        <PillButton
          onClick={() => {
            const endD = new Date()
            const startD = new Date(endD.getFullYear(), 0, 1)
            setStart(iso(startD))
            setEnd(iso(endD))
          }}
        >
          YTD
        </PillButton>
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
            <Card title="Premium by agency (top)">
              <div style={{ display: 'grid', gap: 10 }}>
                {chart.items.map((a) => {
                  const pct = Math.round(((a.annual_premium || 0) / chart.max) * 100)
                  return (
                    <div key={a.slug} style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                        <div style={{ fontWeight: 950 }}>{a.name}</div>
                        <div style={{ opacity: 0.8 }}>
                          {money(a.annual_premium)} · {a.policies}
                        </div>
                      </div>
                      <div style={{ height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${pct}%`,
                            height: '100%',
                            background: 'linear-gradient(90deg, rgba(201,168,76,0.55), rgba(201,168,76,0.15))',
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
                {!chart.items.length && <div style={{ fontSize: 12, opacity: 0.7 }}>No data yet.</div>}
              </div>
            </Card>

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

