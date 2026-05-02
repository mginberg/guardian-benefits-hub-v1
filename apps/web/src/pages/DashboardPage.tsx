import React, { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'

type MeLite = { role: string; agency_id: string }

type UnlStatus = {
  sftp_ok?: boolean
  sftp_error?: string | null
  db_error?: string | null
  last_import_at?: string | null
  last_import_file?: string | null
  unrouted_rows_total?: number
}

type UnroutedResponse = {
  counts: Record<string, number>
  rows: Array<{
    id: string
    source_file: string
    wa_code: string
    extracted_prefix: string
    policy_number: string
    agent_name: string
  }>
}

type JobResponse = {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error?: string | null
}

type DashboardStats = {
  agency_slug: string
  agency_name: string
  total_policies: number
  total_premium: number
  active_count: number
  active_premium: number
  avg_premium: number
  effectuation_rate: number
  cancel_rate: number
  non_effectuated_rate: number
  cancelled_count: number
  cancelled_excl_claims_count: number
  claim_count: number
  terminated_count: number
  non_effectuated_count: number
  lapsed_count: number
  suspended_count: number
  pending_pipeline: number
  pending_new_count: number
  pending_payment_count: number
  pending_cancel_count: number
  future_effective_count: number
  definitive: number
  available_agents: string[]
  agencies: Array<{
    id: string
    code: string
    name: string
    slug: string
    total: number
    active: number
    pending: number
    pending_new: number
    pending_payment: number
    future_effective: number
    terminated: number
    non_effectuated: number
    pending_cancel: number
    lapsed: number
    suspended: number
    active_premium: number
    effectuation_rate: number
    cancel_rate: number
    non_effectuated_rate: number
  }>
  agents: Array<{
    agent_name: string
    wa_code: string
    agency_code: string
    agency_name: string
    total: number
    active: number
    pending: number
    terminated: number
    non_effectuated: number
    pending_cancel: number
    lapsed: number
    suspended: number
    active_premium: number
    effectuation_rate: number
    cancel_rate: number
    non_effectuated_rate: number
  }>
  monthly_trend: Array<{
    month: string
    month_full: string
    total: number
    active: number
    terminated: number
    non_effectuated: number
    lapsed: number
    pending_new: number
    pending_payment: number
    pending_cancel: number
    future_effective: number
    suspended: number
  }>
  states: Record<string, number>
  reason_breakdown?: Array<{ code: string; label: string; count: number }>
  product_mix?: Array<{
    plan_code: string
    plan_name: string
    total: number
    active: number
    pending_new: number
    pending_payment: number
    pending_cancel: number
    future_effective: number
    terminated: number
    non_effectuated: number
    lapsed: number
    suspended: number
    active_premium: number
    effectuation_rate: number
    cancel_rate: number
    non_effectuated_rate: number
    claim_count: number
  }>
  underwriting_speed?: {
    avg_days: number
    sample_size: number
    distribution: Record<string, number>
    monthly: Array<{ month: string; month_full: string; avg_days: number; count: number }>
  }
  reinstatement?: { count: number; pool: number; rate: number }
  cancellation?: {
    never_started: number
    paid_then_cancelled: number
    avg_days_on_books: number
    days_buckets: Record<string, number>
    detail: Array<{
      agent_name: string
      policy_number: string
      issue_date: string | null
      paid_to_date: string | null
      days_on_books: number
      months: number
      classification: string
      classification_label: string
      annual_premium: number
      issue_state: string
      wa_code: string
    }>
  }
  last_import_at?: string | null
  last_import_file?: string | null
  report_date?: string
  source?: string
}

type DrillPolicy = {
  id: string
  policy_number: string
  first_name: string
  last_name: string
  agent_name: string
  wa_code: string
  plan_code: string
  issue_date: string | null
  paid_to_date: string | null
  annual_premium: number
  issue_state: string
  classification: string
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0)
}

function formatPct(n: number): string {
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

function KpiCard({
  title,
  value,
  hint,
  onClick,
}: {
  title: string
  value: string
  hint?: string
  onClick?: () => void
}) {
  return (
    <div className="card" style={onClick ? { cursor: 'pointer' } : undefined} onClick={onClick}>
      <div className="cardInner">
        <div className="cardTitle">{title}</div>
        <div className="kpi">
          <div className="kpiValue">{value}</div>
          {hint ? <div className="kpiHint">{hint}</div> : <div />}
        </div>
      </div>
    </div>
  )
}

export function DashboardPage({ token, me }: { token: string; me: MeLite }) {
  const [health, setHealth] = useState<{ ok: boolean; env: string } | null>(null)
  const [healthError, setHealthError] = useState('')

  const [unlStatus, setUnlStatus] = useState<UnlStatus | null>(null)
  const [unlError, setUnlError] = useState('')
  const [unrouted, setUnrouted] = useState<UnroutedResponse | null>(null)
  const [unroutedLoading, setUnroutedLoading] = useState(false)
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<JobResponse | null>(null)

  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [statsLoading, setStatsLoading] = useState(true)

  const [selectedAgencyScope, setSelectedAgencyScope] = useState('') // super_admin only

  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [appliedDateFrom, setAppliedDateFrom] = useState('')
  const [appliedDateTo, setAppliedDateTo] = useState('')
  const [appliedAgent, setAppliedAgent] = useState('')

  const [activeTab, setActiveTab] = useState<'overview' | 'agencies' | 'agents'>('overview')

  const [drillTitle, setDrillTitle] = useState('')
  const [drillClassifications, setDrillClassifications] = useState<string[]>([])
  const [drillRows, setDrillRows] = useState<DrillPolicy[]>([])
  const [drillTotal, setDrillTotal] = useState(0)
  const [drillPage, setDrillPage] = useState(1)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError] = useState('')

  const drillTotalPages = Math.max(1, Math.ceil(drillTotal / 25))

  const fetchHealthAndUnl = async () => {
    setHealthError('')
    setUnlError('')
    try {
      const res = await apiGet<{ ok: boolean; env: string }>('/api/health')
      setHealth(res)
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Failed to load health')
    }

    try {
      const s = await apiGet<UnlStatus>('/api/unl/status', token)
      setUnlStatus(s)
    } catch (err) {
      setUnlError(err instanceof Error ? err.message : 'Failed to load UNL status')
    }

    try {
      setUnroutedLoading(true)
      const res = await apiGet<UnroutedResponse>('/api/unl/unrouted?limit=15', token)
      setUnrouted(res)
    } catch {
      // ignore
    } finally {
      setUnroutedLoading(false)
    }
  }

  const fetchStats = async () => {
    setStatsLoading(true)
    setStatsError('')
    try {
      const qs = new URLSearchParams()
      if (me.role === 'super_admin' && selectedAgencyScope) qs.set('agency_id', selectedAgencyScope)
      if (appliedDateFrom) qs.set('date_from', appliedDateFrom)
      if (appliedDateTo) qs.set('date_to', appliedDateTo)
      if (appliedAgent) qs.set('agent_name', appliedAgent)
      const q = qs.toString() ? `?${qs.toString()}` : ''
      const res = await apiGet<DashboardStats>(`/api/policy-reports/guardian/dashboard-stats${q}`, token)
      setStats(res)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load dashboard stats')
      setStats(null)
    } finally {
      setStatsLoading(false)
    }
  }

  const fetchDrill = async (classifications: string[], title: string, page: number) => {
    setDrillLoading(true)
    setDrillError('')
    try {
      const qs = new URLSearchParams()
      if (me.role === 'super_admin' && selectedAgencyScope) qs.set('agency_id', selectedAgencyScope)
      if (appliedDateFrom) qs.set('date_from', appliedDateFrom)
      if (appliedDateTo) qs.set('date_to', appliedDateTo)
      if (appliedAgent) qs.set('agent_name', appliedAgent)
      qs.set('page', String(page))
      qs.set('page_size', '25')
      for (const c of classifications) qs.append('classification', c)
      const res = await apiGet<{ policies: DrillPolicy[]; total: number }>(
        `/api/policy-reports/guardian/policies?${qs.toString()}`,
        token,
      )
      setDrillTitle(title)
      setDrillClassifications(classifications)
      setDrillRows(res?.policies || [])
      setDrillTotal(res?.total || 0)
      setDrillPage(page)
    } catch (err) {
      setDrillError(err instanceof Error ? err.message : 'Failed to load policy details')
      setDrillRows([])
      setDrillTotal(0)
    } finally {
      setDrillLoading(false)
    }
  }

  useEffect(() => {
    fetchHealthAndUnl()
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgencyScope, appliedDateFrom, appliedDateTo, appliedAgent])

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const j = await apiGet<JobResponse>(`/api/jobs/${jobId}`, token)
        if (!cancelled) setJob(j)
        if (j?.status === 'succeeded' || j?.status === 'failed') {
          clearInterval(interval)
          await fetchHealthAndUnl()
          await fetchStats()
        }
      } catch {
        // ignore transient
      }
    }, 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const trendMax = useMemo(() => {
    const arr = stats?.monthly_trend || []
    return Math.max(...arr.map((m) => m.total), 1)
  }, [stats?.monthly_trend])

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div>
        <div className="pageTitle">Dashboard</div>
        <div className="pageSub">UNL policy book insights + import health.</div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="cardInner">
            <div className="cardTitle">API Health</div>
            <div className="kpi">
              <div className="kpiValue">
                {health ? (health.ok ? 'OK' : 'Down') : healthError ? 'Error' : 'Loading…'}
              </div>
              <div className="kpiHint">env: {health?.env || '—'}</div>
            </div>
            {healthError && <div className="alert" style={{ marginTop: 10 }}>{healthError}</div>}
          </div>
        </div>

        <div className="card">
          <div className="cardInner">
            <div className="cardTitle">UNL SFTP</div>
            <div className="kpi">
              <div className="kpiValue">{unlStatus?.last_import_at ? 'Imported' : 'No imports yet'}</div>
              <div className="kpiHint">{unlStatus?.unrouted_rows_total ?? '—'} unrouted</div>
            </div>
            <div className="pageSub" style={{ marginTop: 8 }}>
              last file: {unlStatus?.last_import_file || '—'}
            </div>
            {unlError && <div className="alert" style={{ marginTop: 10 }}>{unlError}</div>}
            {unlStatus?.sftp_error && <div className="alert" style={{ marginTop: 10 }}>SFTP error: {String(unlStatus.sftp_error)}</div>}
            {unlStatus?.db_error && <div className="alert" style={{ marginTop: 10 }}>DB error: {String(unlStatus.db_error)}</div>}

            {!!unlStatus?.unrouted_rows_total && unlStatus.unrouted_rows_total > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="cardTitle">Unrouted details</div>
                <div className="pageSub" style={{ marginTop: 6 }}>
                  {unroutedLoading ? 'Loading…' : unrouted?.rows?.length ? 'Top prefixes:' : 'No unrouted details yet.'}
                </div>
                {!!unrouted?.counts && (
                  <div className="pillRow" style={{ marginTop: 8 }}>
                    {Object.entries(unrouted.counts)
                      .slice(0, 8)
                      .map(([p, c]) => (
                        <div key={p || 'blank'} className="pill" style={{ cursor: 'default' }}>
                          {p || '(blank)'}: {c}
                        </div>
                      ))}
                  </div>
                )}
                {!!unrouted?.rows?.length && (
                  <div className="grid" style={{ marginTop: 10 }}>
                    {unrouted.rows.slice(0, 6).map((r) => (
                      <div key={r.id} className="card" style={{ boxShadow: 'none' }}>
                        <div className="cardInner">
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div className="tdStrong">
                              {r.extracted_prefix || '(blank)'} · {r.policy_number || '—'}
                            </div>
                            <div className="kpiHint">{r.wa_code || '—'}</div>
                          </div>
                          {r.agent_name && <div className="pageSub" style={{ marginTop: 6 }}>{r.agent_name}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                  <button
                    className="btn btnGhost"
                    onClick={async () => {
                      await apiPost('/api/unl/reroute-unrouted', { limit: 5000 }, token)
                      await fetchHealthAndUnl()
                      await fetchStats()
                    }}
                  >
                    Re-route unrouted now
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <button
                className="btn btnGold"
                onClick={async () => {
                  const res = await apiPost<{ job_id: string }>('/api/jobs/unl-import-latest', {}, token)
                  setJobId(res.job_id)
                  setJob(null)
                }}
              >
                Queue UNL Import
              </button>
              <button
                className="btn btnGhost"
                onClick={async () => {
                  await fetchHealthAndUnl()
                  await fetchStats()
                }}
              >
                Refresh
              </button>
            </div>
            {jobId && (
              <div className="pageSub" style={{ marginTop: 8 }}>
                Job: {jobId.slice(0, 8)}… · {job?.status || 'queued'}
              </div>
            )}
            {job?.error && <div className="alert" style={{ marginTop: 10 }}>{job.error}</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardInner">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="pageTitle" style={{ fontSize: 18 }}>Policy Book Insights</div>
              <div className="pageSub">
                {stats?.source || 'UNL SFTP'} · report as of {stats?.report_date || '—'} · last import{' '}
                {stats?.last_import_at ? new Date(stats.last_import_at).toLocaleString() : '—'}
              </div>
            </div>

            {me.role === 'super_admin' && (
              <div className="field">
                <div>Scope</div>
                <select
                  className="select"
                  value={selectedAgencyScope}
                  onChange={(e) => setSelectedAgencyScope(e.target.value)}
                >
                  <option value="">All agencies</option>
                  {(stats?.agencies || []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="filters" style={{ marginTop: 12 }}>
            <div className="field">
              <div>Issue date from</div>
              <input className="input" type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} />
            </div>
            <div className="field">
              <div>Issue date to</div>
              <input className="input" type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} />
            </div>
            <div className="field" style={{ minWidth: 220 }}>
              <div>Agent</div>
              <select className="select" value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}>
                <option value="">All agents</option>
                {(stats?.available_agents || []).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="btn btnGold"
              onClick={() => {
                setAppliedDateFrom(filterDateFrom)
                setAppliedDateTo(filterDateTo)
                setAppliedAgent(filterAgent)
              }}
            >
              Apply filters
            </button>
            <button
              className="btn btnGhost"
              onClick={() => {
                setFilterDateFrom('')
                setFilterDateTo('')
                setFilterAgent('')
                setAppliedDateFrom('')
                setAppliedDateTo('')
                setAppliedAgent('')
              }}
            >
              Clear
            </button>
          </div>

          {statsLoading ? (
            <div className="grid2" style={{ marginTop: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card">
                  <div className="cardInner">
                    <div className="skeleton" style={{ height: 12, width: 120 }} />
                    <div className="skeleton" style={{ height: 26, width: 140, marginTop: 10 }} />
                  </div>
                </div>
              ))}
            </div>
          ) : statsError ? (
            <div className="alert" style={{ marginTop: 12 }}>{statsError}</div>
          ) : !stats ? (
            <div className="alert" style={{ marginTop: 12 }}>No policy book data yet. Run a UNL import.</div>
          ) : (
            <>
              <div className="grid2" style={{ marginTop: 12 }}>
                <KpiCard
                  title="Total Policies"
                  value={stats.total_policies.toLocaleString()}
                  hint={formatCurrency(stats.total_premium)}
                  onClick={() => fetchDrill([], 'All Policies', 1)}
                />
                <KpiCard
                  title="Active"
                  value={stats.active_count.toLocaleString()}
                  hint={`${formatPct(stats.effectuation_rate)} eff`}
                  onClick={() => fetchDrill(['active'], 'Active Policies', 1)}
                />
                <KpiCard
                  title="Cancelled"
                  value={stats.cancelled_count.toLocaleString()}
                  hint={`${formatPct(stats.cancel_rate)} cancel`}
                  onClick={() => fetchDrill(['terminated', 'lapsed'], 'Cancelled (Terminated + Lapsed)', 1)}
                />
                <KpiCard
                  title="Non-Effectuated"
                  value={stats.non_effectuated_count.toLocaleString()}
                  hint={`${formatPct(stats.non_effectuated_rate)} non-eff`}
                  onClick={() => fetchDrill(['non_effectuated'], 'Non-Effectuated', 1)}
                />
                <KpiCard
                  title="Pending Pipeline"
                  value={stats.pending_pipeline.toLocaleString()}
                  hint={`${stats.pending_new_count} new · ${stats.pending_payment_count} pay`}
                  onClick={() => fetchDrill(['pending_new', 'pending_payment', 'future_effective'], 'Pending Pipeline', 1)}
                />
                <KpiCard
                  title="Active Premium"
                  value={formatCurrency(stats.active_premium)}
                  hint={`avg ${formatCurrency(stats.avg_premium)}`}
                  onClick={() => fetchDrill(['active'], 'Active Policies', 1)}
                />
              </div>

              <div className="pillRow" style={{ marginTop: 12 }}>
                {(['overview', 'agencies', 'agents'] as const).map((t) => (
                  <button
                    key={t}
                    className={`pill ${activeTab === t ? 'pillActive' : ''}`}
                    onClick={() => setActiveTab(t)}
                  >
                    {t === 'overview' ? 'Overview' : t === 'agencies' ? 'Agencies' : 'Agents'}
                  </button>
                ))}
              </div>

              {activeTab === 'overview' && (
                <div className="grid3" style={{ marginTop: 12 }}>
                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Rates</div>
                      <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                        {[
                          { label: 'Effectuation', v: stats.effectuation_rate },
                          { label: 'Cancel (excl. claims)', v: stats.cancel_rate },
                          { label: 'Non-effectuation', v: stats.non_effectuated_rate },
                        ].map((r) => (
                          <div key={r.label}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                              <div className="kpiHint">{r.label}</div>
                              <div className="tdStrong">{formatPct(r.v)}</div>
                            </div>
                            <div className="bar" style={{ marginTop: 6 }}>
                              <div className="barFill" style={{ width: `${Math.min(100, Math.max(0, r.v))}%` }} />
                            </div>
                          </div>
                        ))}
                        <div className="pageSub">Definitive policies: {stats.definitive.toLocaleString()}</div>
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Monthly trend (issue date)</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 120, marginTop: 10 }}>
                        {(stats.monthly_trend || []).slice(-14).map((m) => {
                          const h = Math.max(2, Math.round((m.total / trendMax) * 100))
                          return (
                            <div key={m.month} style={{ flex: 1, minWidth: 10 }} title={`${m.month_full}: ${m.total}`}>
                              <div
                                style={{
                                  height: `${h}%`,
                                  borderRadius: 8,
                                  background: 'linear-gradient(180deg, rgba(201,168,76,.55), rgba(201,168,76,.08))',
                                  border: '1px solid rgba(255,255,255,.10)',
                                }}
                              />
                              <div className="kpiHint" style={{ fontSize: 10, textAlign: 'center', marginTop: 6 }}>
                                {m.month.split('-')[1]}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Top states</div>
                      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                        {Object.entries(stats.states || {})
                          .slice(0, 10)
                          .map(([s, c]) => (
                            <div key={s} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                              <div className="kpiHint">{s}</div>
                              <div className="tdStrong">{c.toLocaleString()}</div>
                            </div>
                          ))}
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Reinstatement</div>
                      <div className="kpi">
                        <div className="kpiValue">{formatPct(stats.reinstatement?.rate ?? 0)}</div>
                        <div className="kpiHint">
                          {(stats.reinstatement?.count ?? 0).toLocaleString()} / {(stats.reinstatement?.pool ?? 0).toLocaleString()}
                        </div>
                      </div>
                      <div className="pageSub" style={{ marginTop: 8 }}>
                        Policies won back (RS/RE).
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'agencies' && (
                <div className="tableWrap" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="th">Agency</th>
                        <th className="th">Active</th>
                        <th className="th">Active Premium</th>
                        <th className="th">Eff %</th>
                        <th className="th">Cancel %</th>
                        <th className="th">Non-eff %</th>
                        <th className="th">Pending</th>
                        <th className="th">Cancelled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.agencies.map((a) => (
                        <tr key={a.id}>
                          <td className="td tdStrong">{a.name}</td>
                          <td className="td">{a.active.toLocaleString()}</td>
                          <td className="td tdStrong">{formatCurrency(a.active_premium)}</td>
                          <td className="td">{formatPct(a.effectuation_rate)}</td>
                          <td className="td">{formatPct(a.cancel_rate)}</td>
                          <td className="td">{formatPct(a.non_effectuated_rate)}</td>
                          <td className="td">{a.pending.toLocaleString()}</td>
                          <td className="td">{(a.terminated + a.lapsed).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === 'agents' && (
                <div className="tableWrap" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="th">Agent</th>
                        <th className="th">Agency</th>
                        <th className="th">Active</th>
                        <th className="th">Active Premium</th>
                        <th className="th">Eff %</th>
                        <th className="th">Cancel %</th>
                        <th className="th">Non-eff %</th>
                        <th className="th">Pending</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.agents.slice(0, 200).map((a) => (
                        <tr key={`${a.agent_name}-${a.wa_code}-${a.agency_code}`}>
                          <td className="td tdStrong">{a.agent_name || '—'}</td>
                          <td className="td">{a.agency_name || a.agency_code || '—'}</td>
                          <td className="td">{a.active.toLocaleString()}</td>
                          <td className="td tdStrong">{formatCurrency(a.active_premium)}</td>
                          <td className="td">{formatPct(a.effectuation_rate)}</td>
                          <td className="td">{formatPct(a.cancel_rate)}</td>
                          <td className="td">{formatPct(a.non_effectuated_rate)}</td>
                          <td className="td">{a.pending.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="pageSub" style={{ marginTop: 10 }}>Showing top 200 agents by active premium.</div>
                </div>
              )}

              {(drillTitle || drillClassifications.length > 0) && (
                <div className="card" style={{ marginTop: 12 }}>
                  <div className="cardInner">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div>
                        <div className="pageTitle" style={{ fontSize: 16 }}>{drillTitle || 'Details'}</div>
                        <div className="pageSub">{drillTotal.toLocaleString()} policies</div>
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <button
                          className="btn btnGhost"
                          onClick={() => {
                            setDrillTitle('')
                            setDrillClassifications([])
                            setDrillRows([])
                            setDrillTotal(0)
                            setDrillPage(1)
                            setDrillError('')
                          }}
                        >
                          Close
                        </button>
                        <button
                          className="btn"
                          disabled={drillLoading || drillPage <= 1}
                          onClick={() => fetchDrill(drillClassifications, drillTitle, Math.max(1, drillPage - 1))}
                        >
                          Prev
                        </button>
                        <button
                          className="btn"
                          disabled={drillLoading || drillPage >= drillTotalPages}
                          onClick={() => fetchDrill(drillClassifications, drillTitle, Math.min(drillTotalPages, drillPage + 1))}
                        >
                          Next
                        </button>
                      </div>
                    </div>

                    {drillError && <div className="alert" style={{ marginTop: 12 }}>{drillError}</div>}
                    {drillLoading ? (
                      <div className="pageSub" style={{ marginTop: 12 }}>Loading…</div>
                    ) : (
                      <div className="tableWrap" style={{ marginTop: 12 }}>
                        <table className="table">
                          <thead>
                            <tr>
                              <th className="th">Policy #</th>
                              <th className="th">Name</th>
                              <th className="th">Agent</th>
                              <th className="th">State</th>
                              <th className="th">Issue</th>
                              <th className="th">Paid-to</th>
                              <th className="th">Premium</th>
                              <th className="th">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {drillRows.map((p) => (
                              <tr key={p.id}>
                                <td className="td tdStrong">{p.policy_number}</td>
                                <td className="td">{`${p.first_name || ''} ${p.last_name || ''}`.trim() || '—'}</td>
                                <td className="td">{p.agent_name || '—'}</td>
                                <td className="td">{p.issue_state || '—'}</td>
                                <td className="td">{formatDate(p.issue_date)}</td>
                                <td className="td">{formatDate(p.paid_to_date)}</td>
                                <td className="td tdStrong">{formatCurrency(p.annual_premium)}</td>
                                <td className="td">{p.classification}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="pageSub" style={{ marginTop: 10 }}>
                          Page {drillPage} of {drillTotalPages}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(stats.reason_breakdown?.length || stats.product_mix?.length || stats.underwriting_speed?.sample_size || stats.cancellation?.detail?.length) ? (
                <div className="grid3" style={{ marginTop: 12 }}>
                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Contract reasons (top)</div>
                      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                        {(stats.reason_breakdown || []).slice(0, 10).map((r) => (
                          <div key={r.code} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div className="kpiHint" title={`${r.code} — ${r.label}`}>
                              {r.code} · {r.label}
                            </div>
                            <div className="tdStrong">{r.count.toLocaleString()}</div>
                          </div>
                        ))}
                        {(!stats.reason_breakdown || stats.reason_breakdown.length === 0) && (
                          <div className="pageSub">No reason codes found.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Underwriting speed (app → issue)</div>
                      <div className="kpi">
                        <div className="kpiValue">{(stats.underwriting_speed?.avg_days ?? 0).toFixed(1)}d</div>
                        <div className="kpiHint">n={(stats.underwriting_speed?.sample_size ?? 0).toLocaleString()}</div>
                      </div>
                      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                        {Object.entries(stats.underwriting_speed?.distribution || {}).map(([k, v]) => (
                          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div className="kpiHint">{k}</div>
                            <div className="tdStrong">{Number(v).toLocaleString()}</div>
                          </div>
                        ))}
                        {(!stats.underwriting_speed || stats.underwriting_speed.sample_size === 0) && (
                          <div className="pageSub">No underwriting speed data yet.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="cardInner">
                      <div className="cardTitle">Cancellation deep-dive</div>
                      <div className="kpi">
                        <div className="kpiValue">{(stats.cancellation?.avg_days_on_books ?? 0).toFixed(1)}d</div>
                        <div className="kpiHint">avg days on books</div>
                      </div>
                      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                        {Object.entries(stats.cancellation?.days_buckets || {}).map(([k, v]) => (
                          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <div className="kpiHint">{k}</div>
                            <div className="tdStrong">{Number(v).toLocaleString()}</div>
                          </div>
                        ))}
                        {(!stats.cancellation || !stats.cancellation.detail?.length) && (
                          <div className="pageSub">No cancellation sample available.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {stats.product_mix && stats.product_mix.length > 0 && (
                <div className="card" style={{ marginTop: 12 }}>
                  <div className="cardInner">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div>
                        <div className="pageTitle" style={{ fontSize: 16 }}>Product mix</div>
                        <div className="pageSub">Effectuation + cancel + non-eff rates per plan.</div>
                      </div>
                    </div>
                    <div className="tableWrap" style={{ marginTop: 12 }}>
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="th">Plan</th>
                            <th className="th">Total</th>
                            <th className="th">Active</th>
                            <th className="th">Active Premium</th>
                            <th className="th">Eff %</th>
                            <th className="th">Cancel %</th>
                            <th className="th">Non-eff %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.product_mix.slice(0, 30).map((p) => (
                            <tr key={p.plan_code}>
                              <td className="td tdStrong" title={p.plan_code}>
                                {p.plan_name}
                              </td>
                              <td className="td">{p.total.toLocaleString()}</td>
                              <td className="td">{p.active.toLocaleString()}</td>
                              <td className="td tdStrong">{formatCurrency(p.active_premium)}</td>
                              <td className="td">{formatPct(p.effectuation_rate)}</td>
                              <td className="td">{formatPct(p.cancel_rate)}</td>
                              <td className="td">{formatPct(p.non_effectuated_rate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="pageSub" style={{ marginTop: 10 }}>
                        Showing top 30 products by volume.
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

