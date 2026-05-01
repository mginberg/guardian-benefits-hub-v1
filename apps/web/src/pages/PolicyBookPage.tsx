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
    <div className="card">
      <div className="cardInner">
        <div className="cardTitle">{title}</div>
        <div style={{ marginTop: 10 }}>{children}</div>
      </div>
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

function PillButton({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} className={active ? 'pill pillActive' : 'pill'}>
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
    <div className="grid">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="pageTitle">Policy Book</div>
          <div className="pageSub">
            UNL policy book (from nightly SFTP import). {me.role === 'super_admin' ? 'Super admin view.' : 'Scoped to your agency.'}
          </div>
        </div>
        <div className="filters">
          {me.role === 'super_admin' && (
            <label className="field" style={{ minWidth: 240 }}>
              Agency
              <select
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
                className="select"
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
          <label className="field">
            Start (issue date)
            <input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="YYYY-MM-DD"
              className="input"
            />
          </label>
          <label className="field">
            End (issue date)
            <input
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="YYYY-MM-DD"
              className="input"
            />
          </label>
          <button
            onClick={() => {
              setStart('')
              setEnd('')
              setAgencyId('')
            }}
            className="btn"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="pillRow">
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
        <div className="alert">{error}</div>
      )}

      {loading ? (
        <div className="grid2">
          <div className="card">
            <div className="cardInner">
              <div className="cardTitle">Total policies</div>
              <div style={{ marginTop: 10, height: 30, width: 180 }} className="skeleton" />
            </div>
          </div>
          <div className="card">
            <div className="cardInner">
              <div className="cardTitle">Total annual premium</div>
              <div style={{ marginTop: 10, height: 30, width: 220 }} className="skeleton" />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="grid2">
            <Card title="Total policies">
              <div className="kpi">
                <div className="kpiValue">{summary?.total_policies?.toLocaleString() || '0'}</div>
                <div className="kpiHint">policies</div>
              </div>
            </Card>
            <Card title="Total annual premium">
              <div className="kpi">
                <div className="kpiValue">{money(summary?.total_annual_premium || 0)}</div>
                <div className="kpiHint">annual</div>
              </div>
            </Card>
          </div>

          <div className="grid3">
            <Card title="Premium by agency (top)">
              <div className="grid" style={{ gap: 10 }}>
                {chart.items.map((a) => {
                  const pct = Math.round(((a.annual_premium || 0) / chart.max) * 100)
                  return (
                    <div key={a.slug} className="grid" style={{ gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                        <div style={{ fontWeight: 950 }}>{a.name}</div>
                        <div style={{ color: 'var(--muted)' }}>
                          {money(a.annual_premium)} · {a.policies}
                        </div>
                      </div>
                      <div className="bar">
                        <div className="barFill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
                {!chart.items.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data yet.</div>}
              </div>
            </Card>

            <Card title="By agency (top)">
              <div className="grid" style={{ gap: 6 }}>
                {(summary?.by_agency || []).slice(0, 10).map((a) => (
                  <div key={a.slug} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 900 }}>{a.name}</div>
                    <div style={{ color: 'var(--muted)' }}>
                      {a.policies} · {money(a.annual_premium)}
                    </div>
                  </div>
                ))}
                {!summary?.by_agency?.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data yet.</div>}
              </div>
            </Card>

            <Card title="By classification">
              <div className="grid" style={{ gap: 6 }}>
                {(summary?.by_classification || []).map((c) => (
                  <div key={c.classification} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 900 }}>{c.classification}</div>
                    <div style={{ color: 'var(--muted)' }}>
                      {c.policies} · {money(c.annual_premium)}
                    </div>
                  </div>
                ))}
                {!summary?.by_classification?.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data yet.</div>}
              </div>
            </Card>
          </div>

          <Card title="Latest policies (sample)">
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="th">Agency</th>
                    <th className="th">Policy #</th>
                    <th className="th">Agent</th>
                    <th className="th">Issue</th>
                    <th className="th">Paid-to</th>
                    <th className="th">Annual prem</th>
                    <th className="th">Class</th>
                  </tr>
                </thead>
                <tbody>
                  {(policies?.rows || []).slice(0, 200).map((r, idx) => (
                    <tr key={`${r.policy_number}-${idx}`}>
                      <td className="td tdStrong">{r.agency_name}</td>
                      <td className="td">{r.policy_number || '—'}</td>
                      <td className="td">{r.agent_name || '—'}</td>
                      <td className="td">{r.issue_date || '—'}</td>
                      <td className="td">{r.paid_to_date || '—'}</td>
                      <td className="td">{money(r.annual_premium || 0)}</td>
                      <td className="td">{r.classification || 'unknown'}</td>
                    </tr>
                  ))}
                  {!policies?.rows?.length && (
                    <tr>
                      <td colSpan={7} className="td" style={{ color: 'var(--muted)' }}>
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

