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
  agencies: Array<{
    id: string; code: string; name: string; slug: string
    total: number; active: number; pending: number
    pending_new: number; pending_payment: number; future_effective: number
    terminated: number; non_effectuated: number; pending_cancel: number
    lapsed: number; suspended: number; active_premium: number
    effectuation_rate: number; cancel_rate: number; non_effectuated_rate: number
  }>
  agents: Array<{
    agent_name: string; wa_code: string; agency_code: string; agency_name: string
    total: number; active: number; pending: number; terminated: number
    non_effectuated: number; pending_cancel: number; lapsed: number; suspended: number
    active_premium: number; effectuation_rate: number; cancel_rate: number; non_effectuated_rate: number
  }>
  monthly_trend: Array<{ month: string; month_full: string; total: number; active: number }>
  states: Record<string, number>
  reinstatement?: { count: number; pool: number; rate: number }
  last_import_at?: string | null
  last_import_file?: string | null
  report_date?: string
}

type Extras = {
  reason_breakdown?: Array<{ code: string; label: string; count: number }>
  product_mix?: Array<{
    plan_code: string; plan_name: string; total: number; active: number
    active_premium: number; effectuation_rate: number; cancel_rate: number; non_effectuated_rate: number
  }>
  underwriting_speed?: { avg_days: number; sample_size: number; distribution: Record<string, number> }
  cancellation?: {
    never_started: number; paid_then_cancelled: number
    avg_days_on_books: number; days_buckets: Record<string, number>
  }
}

type DrillPolicy = {
  id: string; policy_number: string; first_name: string; last_name: string
  agent_name: string; wa_code: string; plan_code: string
  issue_date: string | null; paid_to_date: string | null
  annual_premium: number; issue_state: string; classification: string
}

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
const fmtPct = (n: number) => `${(n || 0).toFixed(1)}%`
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return iso }
}
const fmtDt = (iso: string | null | undefined) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

// ── Metric tooltips ───────────────────────────────────────────────────────────
const TIPS: Record<string, string> = {
  'Total Policies':    'Every policy row in the UNL file assigned to this agency, across all statuses.',
  'Active':            'Policies with an active contract code (AC) and a paid-to date in the future. Effectuation rate = Active ÷ Definitive.',
  'Cancelled':         'Terminated + Lapsed policies. Excludes DC-reason (claim) cancellations from the cancel rate.',
  'Non-Effectuated':   'Policies that were written but payment was never collected — they never became active.',
  'Active Premium':    'Sum of annual premiums for all currently Active policies. Avg is per active policy.',
  'Pending New':       'Application submitted, awaiting underwriting decision. Not yet issued.',
  'Pending Payment':   'Policy issued but first payment not yet received. At risk of becoming Non-Effectuated.',
  'Pending/Cancel':    'Active policy with a pending cancellation request in progress.',
  'Future Effective':  'Approved policy with an issue date in the future — not yet active.',
  'Lapsed':            'Previously active policy that lapsed due to non-payment after the grace period.',
  'Suspended':         'Policy temporarily suspended — usually awaiting billing resolution.',
  'Reinstatement Rate':'% of lapsed/terminated policies successfully reinstated (RS or RE reason code).',
  'Definitive':        'Total minus Pending and Suspended. The "real" policy base used for rate calculations.',
  'Claims (DC)':       'Policies cancelled because the insured passed away (Death Claim — reason code DC). These are excluded from the cancel rate since they are not a retention failure.',
}

// ── Tooltip component ─────────────────────────────────────────────────────────
function Tip({ text }: { text?: string }) {
  const [show, setShow] = useState(false)
  if (!text) return null
  return (
    <span
      style={{ position: 'relative', display: 'inline-block', marginLeft: 5 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{ fontSize: 11, color: 'rgba(231,234,240,.40)', cursor: 'default', userSelect: 'none' }}>ⓘ</span>
      {show && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          background: 'rgba(8,14,26,.98)', border: '1px solid rgba(255,255,255,.14)',
          borderRadius: 10, padding: '10px 13px', fontSize: 12,
          color: 'rgba(231,234,240,.88)', width: 240, zIndex: 200,
          boxShadow: '0 12px 32px rgba(0,0,0,.55)', lineHeight: 1.55,
          pointerEvents: 'none', whiteSpace: 'normal',
        }}>
          {text}
        </div>
      )}
    </span>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────
const ACCENT_COLORS: Record<string, string> = {
  green: 'var(--green)', red: 'var(--red)', orange: 'var(--orange)',
  blue: 'var(--blue)', teal: 'var(--teal)', gold: 'var(--gold)', purple: 'var(--purple)',
}

function StatCard({
  label, value, sub, accent, onClick,
}: {
  label: string; value: string; sub?: string
  accent?: keyof typeof ACCENT_COLORS
  onClick?: () => void
}) {
  const accentClass = accent ? ` card${accent.charAt(0).toUpperCase() + accent.slice(1)}` : ''
  const valueColor = accent ? ACCENT_COLORS[accent] : 'var(--text)'
  return (
    <div
      className={`card${accentClass}`}
      style={{ cursor: onClick ? 'pointer' : 'default', height: '100%' }}
      onClick={onClick}
    >
      <div className="cardInner" style={{ padding: '14px 16px', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div className="cardTitle" style={{ flex: 1 }}>{label}</div>
          <Tip text={TIPS[label]} />
        </div>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-.5px', marginTop: 8, color: valueColor }}>
            {value}
          </div>
          {sub && <div className="kpiHint" style={{ marginTop: 5 }}>{sub}</div>}
        </div>
      </div>
    </div>
  )
}

// ── RateBar ───────────────────────────────────────────────────────────────────
function RateBar({ label, value, color }: { label: string; value: number; color?: string }) {
  const fillClass = color ? `barFill barFill${color.charAt(0).toUpperCase() + color.slice(1)}` : 'barFill'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <div className="kpiHint">{label}</div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtPct(value)}</div>
      </div>
      <div className="bar"><div className={fillClass} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
    </div>
  )
}

// ── StatList ──────────────────────────────────────────────────────────────────
function StatList({
  items, color = 'rgba(201,168,76,.75)', emptyMsg = 'No data.',
}: {
  items: Array<{ label: string; value: number }>
  color?: string; emptyMsg?: string
}) {
  if (!items.length) return <div className="pageSub" style={{ marginTop: 8 }}>{emptyMsg}</div>
  const peak = Math.max(...items.map(i => i.value), 1)
  return (
    <div style={{ marginTop: 10 }}>
      {items.map((item, idx) => (
        <div key={item.label} style={{
          padding: '7px 8px', borderRadius: 8,
          background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.03)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.label}>
              {item.label}
            </div>
            <div style={{ fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{item.value.toLocaleString()}</div>
          </div>
          <div style={{ height: 3, borderRadius: 999, background: 'rgba(255,255,255,.07)', marginTop: 5 }}>
            <div style={{ height: '100%', borderRadius: 999, width: `${Math.round((item.value / peak) * 100)}%`, background: color, transition: 'width .3s ease' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── CSV export ────────────────────────────────────────────────────────────────
function downloadCsv(rows: DrillPolicy[], title: string) {
  const headers = ['Policy #', 'First Name', 'Last Name', 'Agent', 'WA Code', 'State', 'Plan', 'Issue Date', 'Paid To', 'Annual Premium', 'Status']
  const lines = [
    headers.join(','),
    ...rows.map(p => [
      p.policy_number, p.first_name, p.last_name, p.agent_name, p.wa_code,
      p.issue_state, p.plan_code,
      p.issue_date || '', p.paid_to_date || '',
      p.annual_premium.toFixed(2), p.classification,
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[^a-z0-9]/gi, '_')}_export.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Date presets ──────────────────────────────────────────────────────────────
function dateStr(d: Date) {
  return d.toISOString().slice(0, 10)
}
const DATE_PRESETS = [
  {
    label: 'MTD', getRange: () => {
      const now = new Date(); const f = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from: dateStr(f), to: dateStr(now) }
    },
  },
  {
    label: 'YTD', getRange: () => {
      const now = new Date(); const f = new Date(now.getFullYear(), 0, 1)
      return { from: dateStr(f), to: dateStr(now) }
    },
  },
  {
    label: 'L30', getRange: () => {
      const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 30)
      return { from: dateStr(from), to: dateStr(to) }
    },
  },
  {
    label: 'L90', getRange: () => {
      const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 90)
      return { from: dateStr(from), to: dateStr(to) }
    },
  },
  { label: 'All', getRange: () => ({ from: '', to: '' }) },
]

// ── Main component ────────────────────────────────────────────────────────────
export function DashboardPage({ token, me }: { token: string; me: MeLite }) {
  const [unlStatus, setUnlStatus] = useState<UnlStatus | null>(null)
  const [jobId, setJobId] = useState('')
  const [job, setJob] = useState<JobResponse | null>(null)
  const [importing, setImporting] = useState(false)

  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [statsLoading, setStatsLoading] = useState(true)
  const [allAgencies, setAllAgencies] = useState<DashboardStats['agencies']>([])

  const [extras, setExtras] = useState<Extras | null>(null)
  const [extrasLoading, setExtrasLoading] = useState(false)

  const [selectedAgencyScope, setSelectedAgencyScope] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [appliedDateFrom, setAppliedDateFrom] = useState('')
  const [appliedDateTo, setAppliedDateTo] = useState('')
  const [appliedAgent, setAppliedAgent] = useState('')
  const [activePreset, setActivePreset] = useState('')

  const [availableAgents, setAvailableAgents] = useState<string[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)

  const [activeTab, setActiveTab] = useState<'overview' | 'agencies' | 'agents'>('overview')

  const [drillTitle, setDrillTitle] = useState('')
  const [drillClassifications, setDrillClassifications] = useState<string[]>([])
  const [drillRows, setDrillRows] = useState<DrillPolicy[]>([])
  const [drillAllRows, setDrillAllRows] = useState<DrillPolicy[]>([])
  const [drillTotal, setDrillTotal] = useState(0)
  const [drillPage, setDrillPage] = useState(1)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillExporting, setDrillExporting] = useState(false)
  const [drillError, setDrillError] = useState('')

  const drillTotalPages = Math.max(1, Math.ceil(drillTotal / 25))

  const buildQs = (extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams()
    if (me.role === 'super_admin' && selectedAgencyScope) qs.set('agency_id', selectedAgencyScope)
    if (appliedDateFrom) qs.set('date_from', appliedDateFrom)
    if (appliedDateTo) qs.set('date_to', appliedDateTo)
    if (appliedAgent) qs.set('agent_name', appliedAgent)
    Object.entries(extra).forEach(([k, v]) => qs.set(k, v))
    const s = qs.toString()
    return s ? `?${s}` : ''
  }

  const fetchStats = async () => {
    setStatsLoading(true)
    setStatsError('')
    setExtras(null)
    try {
      const res = await apiGet<DashboardStats>(`/api/policy-reports/guardian/dashboard-stats${buildQs()}`, token)
      setStats(res)
      if (!selectedAgencyScope && res.agencies?.length) setAllAgencies(res.agencies)
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Failed to load stats')
      setStats(null)
    } finally {
      setStatsLoading(false)
    }
  }

  const fetchExtras = async () => {
    setExtrasLoading(true)
    try {
      const res = await apiGet<Extras>(`/api/policy-reports/guardian/dashboard-extras${buildQs()}`, token)
      setExtras(res)
    } catch { /* non-critical */ } finally {
      setExtrasLoading(false)
    }
  }

  const fetchUnl = async () => {
    try { setUnlStatus(await apiGet<UnlStatus>('/api/unl/status', token)) } catch { /* ignore */ }
  }

  const fetchAgents = async () => {
    if (availableAgents.length > 0) return
    setAgentsLoading(true)
    try {
      const res = await apiGet<{ agents: string[] }>(`/api/policy-reports/guardian/available-agents${buildQs()}`, token)
      setAvailableAgents(res.agents || [])
    } catch { /* ignore */ } finally { setAgentsLoading(false) }
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
      qs.set('page', String(page)); qs.set('page_size', '25')
      for (const c of classifications) qs.append('classification', c)
      const res = await apiGet<{ policies: DrillPolicy[]; total: number }>(
        `/api/policy-reports/guardian/policies?${qs.toString()}`, token,
      )
      setDrillTitle(title)
      setDrillClassifications(classifications)
      setDrillRows(res?.policies || [])
      setDrillTotal(res?.total || 0)
      setDrillPage(page)
    } catch (err) {
      setDrillError(err instanceof Error ? err.message : 'Failed to load policies')
      setDrillRows([]); setDrillTotal(0)
    } finally { setDrillLoading(false) }
  }

  const exportDrill = async () => {
    setDrillExporting(true)
    try {
      const qs = new URLSearchParams()
      if (me.role === 'super_admin' && selectedAgencyScope) qs.set('agency_id', selectedAgencyScope)
      if (appliedDateFrom) qs.set('date_from', appliedDateFrom)
      if (appliedDateTo) qs.set('date_to', appliedDateTo)
      if (appliedAgent) qs.set('agent_name', appliedAgent)
      qs.set('page', '1'); qs.set('page_size', '5000')
      for (const c of drillClassifications) qs.append('classification', c)
      const res = await apiGet<{ policies: DrillPolicy[] }>(
        `/api/policy-reports/guardian/policies?${qs.toString()}`, token,
      )
      downloadCsv(res.policies || [], drillTitle)
    } catch { /* ignore */ } finally { setDrillExporting(false) }
  }

  useEffect(() => { fetchUnl() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchStats() }, [token, selectedAgencyScope, appliedDateFrom, appliedDateTo, appliedAgent]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!statsLoading && stats) fetchExtras() }, [statsLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const j = await apiGet<JobResponse>(`/api/jobs/${jobId}`, token)
        if (!cancelled) setJob(j)
        if (j?.status === 'succeeded' || j?.status === 'failed') {
          clearInterval(interval); setImporting(false); fetchUnl(); fetchStats()
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => { cancelled = true; clearInterval(interval) }
  }, [jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  const trendMax = useMemo(() =>
    Math.max(...(stats?.monthly_trend || []).map(m => m.total), 1),
    [stats?.monthly_trend]
  )

  const applyPreset = (preset: typeof DATE_PRESETS[0]) => {
    const { from, to } = preset.getRange()
    setFilterDateFrom(from); setFilterDateTo(to)
    setAppliedDateFrom(from); setAppliedDateTo(to)
    setActivePreset(preset.label)
  }

  const applyFilters = () => {
    setAppliedDateFrom(filterDateFrom); setAppliedDateTo(filterDateTo); setAppliedAgent(filterAgent)
    setActivePreset('')
  }

  const clearFilters = () => {
    setFilterDateFrom(''); setFilterDateTo(''); setFilterAgent('')
    setAppliedDateFrom(''); setAppliedDateTo(''); setAppliedAgent('')
    setActivePreset('')
  }

  const queueImport = async () => {
    setImporting(true)
    try {
      const res = await apiPost<{ job_id: string }>('/api/jobs/unl-import-latest', {}, token)
      setJobId(res.job_id); setJob(null)
    } catch { setImporting(false) }
  }

  // ── Sync bar ───────────────────────────────────────────────────────────────
  const syncBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 0', marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <div className={`badge ${unlStatus?.last_import_at ? 'badgeGreen' : 'badgeOrange'}`}>
          {unlStatus?.last_import_at ? 'SFTP Synced' : 'Not Synced'}
        </div>
        {unlStatus?.last_import_file && <span className="kpiHint" style={{ fontSize: 11 }}>{unlStatus.last_import_file}</span>}
        {unlStatus?.last_import_at && <span className="kpiHint" style={{ fontSize: 11 }}>· {fmtDt(unlStatus.last_import_at)}</span>}
        {!!unlStatus?.unrouted_rows_total && <div className="badge badgeOrange">{unlStatus.unrouted_rows_total} unrouted</div>}
        {(unlStatus?.sftp_error || unlStatus?.db_error) && (
          <div className="badge badgeRed">{unlStatus.sftp_error || unlStatus.db_error}</div>
        )}
        {jobId && job && <div className="badge badgeBlue">Import: {job.status}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btnGold" style={{ fontSize: 12, padding: '6px 12px' }} onClick={queueImport} disabled={importing}>
          {importing ? 'Importing…' : 'Import Now'}
        </button>
        <button className="btn btnGhost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => { fetchUnl(); fetchStats() }}>
          ↻ Refresh
        </button>
      </div>
    </div>
  )

  // ── Filters ────────────────────────────────────────────────────────────────
  const filtersSection = (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="pageTitle">Policy Book Overview</div>
          <div className="pageSub">
            UNL · {stats ? `${stats.total_policies.toLocaleString()} policies` : '—'}
            {stats?.report_date ? ` · as of ${stats.report_date}` : ''}
            {stats?.last_import_at ? ` · last import ${fmtDate(stats.last_import_at)}` : ''}
          </div>
        </div>
        {me.role === 'super_admin' && (allAgencies.length > 0 || stats?.agencies) && (
          <select className="select" style={{ fontSize: 12, height: 36 }}
            value={selectedAgencyScope} onChange={e => setSelectedAgencyScope(e.target.value)}>
            <option value="">All agencies</option>
            {(allAgencies.length > 0 ? allAgencies : stats?.agencies || []).map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Date presets */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 14, marginBottom: 10 }}>
        {DATE_PRESETS.map(p => (
          <button key={p.label} className={`pill${activePreset === p.label ? ' pillActive' : ''}`}
            style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Manual date + agent filters */}
      <div className="filters">
        <div className="field">
          <div>Issue date from</div>
          <input className="input" type="date" value={filterDateFrom} onChange={e => { setFilterDateFrom(e.target.value); setActivePreset('') }} />
        </div>
        <div className="field">
          <div>Issue date to</div>
          <input className="input" type="date" value={filterDateTo} onChange={e => { setFilterDateTo(e.target.value); setActivePreset('') }} />
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <div>Agent</div>
          <select className="select" value={filterAgent}
            onFocus={() => fetchAgents()}
            onChange={e => setFilterAgent(e.target.value)}>
            <option value="">All agents{agentsLoading ? ' (loading…)' : ''}</option>
            {availableAgents.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn btnGold" onClick={applyFilters}>Apply</button>
        {(appliedDateFrom || appliedDateTo || appliedAgent) && (
          <button className="btn btnGhost" onClick={clearFilters}>Clear</button>
        )}
      </div>
    </div>
  )

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const kpiSection = stats ? (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Row 1: 4 primary colored cards — equal height */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <StatCard label="Total Policies" value={stats.total_policies.toLocaleString()}
          sub={fmt$(stats.total_premium)} accent="blue" onClick={() => fetchDrill([], 'All Policies', 1)} />
        <StatCard label="Active" value={stats.active_count.toLocaleString()}
          sub={`${fmtPct(stats.effectuation_rate)} effectuation`} accent="green"
          onClick={() => fetchDrill(['active'], 'Active', 1)} />
        <StatCard label="Cancelled" value={stats.cancelled_count.toLocaleString()}
          sub={`${fmtPct(stats.cancel_rate)} cancel rate`} accent="red"
          onClick={() => fetchDrill(['terminated', 'lapsed'], 'Cancelled', 1)} />
        <StatCard label="Non-Effectuated" value={stats.non_effectuated_count.toLocaleString()}
          sub={`${fmtPct(stats.non_effectuated_rate)} non-eff`} accent="orange"
          onClick={() => fetchDrill(['non_effectuated'], 'Non-Effectuated', 1)} />
      </div>

      {/* Row 2: 4 pipeline colored cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <StatCard label="Active Premium" value={fmt$(stats.active_premium)}
          sub={`avg ${fmt$(stats.avg_premium)}`} accent="teal"
          onClick={() => fetchDrill(['active'], 'Active', 1)} />
        <StatCard label="Pending New" value={stats.pending_new_count.toLocaleString()}
          sub="awaiting underwriting" accent="gold"
          onClick={() => fetchDrill(['pending_new'], 'Pending New', 1)} />
        <StatCard label="Pending Payment" value={stats.pending_payment_count.toLocaleString()}
          sub="issued, no payment" accent="purple"
          onClick={() => fetchDrill(['pending_payment'], 'Pending Payment', 1)} />
        <StatCard label="Pending/Cancel" value={stats.pending_cancel_count.toLocaleString()}
          sub="cancellation in progress" accent="orange"
          onClick={() => fetchDrill(['pending_cancel'], 'Pending/Cancel', 1)} />
      </div>

      {/* Row 3: plain secondary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
        <StatCard label="Future Effective" value={stats.future_effective_count.toLocaleString()}
          sub="starts in future" onClick={() => fetchDrill(['future_effective'], 'Future Effective', 1)} />
        <StatCard label="Lapsed" value={stats.lapsed_count.toLocaleString()}
          sub="non-payment" onClick={() => fetchDrill(['lapsed'], 'Lapsed', 1)} />
        <StatCard label="Suspended" value={stats.suspended_count.toLocaleString()}
          onClick={() => fetchDrill(['suspended'], 'Suspended', 1)} />
        <StatCard label="Reinstatement Rate" value={fmtPct(stats.reinstatement?.rate ?? 0)}
          sub={`${(stats.reinstatement?.count ?? 0).toLocaleString()} won back`} />
        <StatCard label="Definitive" value={stats.definitive.toLocaleString()}
          sub="excl. pending + suspended" />
        <StatCard label="Claims (DC)" value={stats.claim_count.toLocaleString()}
          sub="excl. from cancel rate" />
      </div>
    </div>
  ) : null

  // ── Overview tab ───────────────────────────────────────────────────────────
  const overviewTab = stats ? (
    <div className="grid3" style={{ marginTop: 14 }}>
      <div className="card">
        <div className="cardInner">
          <div className="cardTitle">Key Rates</div>
          <div style={{ marginTop: 12, display: 'grid', gap: 14 }}>
            <RateBar label="Effectuation rate" value={stats.effectuation_rate} color="Green" />
            <RateBar label="Cancel rate (excl. claims)" value={stats.cancel_rate} color="Red" />
            <RateBar label="Non-effectuation rate" value={stats.non_effectuated_rate} color="Orange" />
          </div>
          <div className="pageSub" style={{ marginTop: 12 }}>Definitive: {stats.definitive.toLocaleString()}</div>
        </div>
      </div>

      {/* Monthly trend — fixed bar chart */}
      <div className="card">
        <div className="cardInner">
          <div className="cardTitle">Monthly issued (last 14 mo)</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 110, marginTop: 14 }}>
            {(stats.monthly_trend || []).slice(-14).map(m => {
              const pct = Math.max(6, Math.round((m.total / trendMax) * 100))
              return (
                <div key={m.month} title={`${m.month_full}: ${m.total}`}
                  style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                  <div style={{
                    height: `${pct}%`, borderRadius: '4px 4px 0 0',
                    background: 'linear-gradient(180deg, rgba(52,211,153,.75) 0%, rgba(52,211,153,.20) 100%)',
                  }} />
                  <div style={{ fontSize: 9, textAlign: 'center', marginTop: 4, color: 'var(--text-faint)' }}>
                    {m.month.slice(5)}
                  </div>
                </div>
              )
            })}
          </div>
          {!stats.monthly_trend?.length && <div className="pageSub" style={{ marginTop: 12 }}>No trend data yet.</div>}
        </div>
      </div>

      <div className="card">
        <div className="cardInner">
          <div className="cardTitle">Top states (active)</div>
          <StatList
            items={Object.entries(stats.states || {}).slice(0, 12).map(([s, c]) => ({ label: s, value: c }))}
            color="rgba(52,211,153,.80)" emptyMsg="No state data." />
        </div>
      </div>

      {extrasLoading && (
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="cardInner">
            <div className="skeleton" style={{ height: 11, width: 180 }} />
            <div className="skeleton" style={{ height: 60, marginTop: 10 }} />
          </div>
        </div>
      )}

      {extras && (
        <>
          <div className="card">
            <div className="cardInner">
              <div className="cardTitle">Contract reasons</div>
              <StatList
                items={(extras.reason_breakdown || []).slice(0, 12).map(r => ({ label: `${r.code} · ${r.label}`, value: r.count }))}
                color="rgba(99,102,241,.80)" emptyMsg="No reason codes." />
            </div>
          </div>

          <div className="card">
            <div className="cardInner">
              <div className="cardTitle">Underwriting speed (app → issue)</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--teal)' }}>
                  {(extras.underwriting_speed?.avg_days ?? 0).toFixed(1)}d
                </div>
                <div className="kpiHint">avg · n={(extras.underwriting_speed?.sample_size ?? 0).toLocaleString()}</div>
              </div>
              <StatList
                items={Object.entries(extras.underwriting_speed?.distribution || {}).map(([k, v]) => ({ label: k, value: Number(v) }))}
                color="rgba(34,211,238,.80)" emptyMsg="No data." />
            </div>
          </div>

          <div className="card">
            <div className="cardInner">
              <div className="cardTitle">Cancellation deep-dive</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8 }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--orange)' }}>
                  {(extras.cancellation?.avg_days_on_books ?? 0).toFixed(1)}d
                </div>
                <div className="kpiHint">avg days on books</div>
              </div>
              <StatList
                items={Object.entries(extras.cancellation?.days_buckets || {}).map(([k, v]) => ({ label: k, value: Number(v) }))}
                color="rgba(248,113,113,.80)" emptyMsg="No data." />
            </div>
          </div>
        </>
      )}

      {/* Product mix table with zebra striping */}
      {extras?.product_mix && extras.product_mix.length > 0 && (
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="cardInner">
            <div className="cardTitle">Product mix</div>
            <div className="pageSub">Effectuation + cancel + non-eff rates per plan</div>
            <div className="tableWrap" style={{ marginTop: 12 }}>
              <table className="table tableZebra">
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
                  {extras.product_mix.slice(0, 30).map(p => (
                    <tr key={p.plan_code}>
                      <td className="td tdStrong" title={p.plan_code}>{p.plan_name}</td>
                      <td className="td">{p.total.toLocaleString()}</td>
                      <td className="td">{p.active.toLocaleString()}</td>
                      <td className="td tdStrong">{fmt$(p.active_premium)}</td>
                      <td className="td" style={{ color: 'var(--green)' }}>{fmtPct(p.effectuation_rate)}</td>
                      <td className="td" style={{ color: 'var(--red)' }}>{fmtPct(p.cancel_rate)}</td>
                      <td className="td" style={{ color: 'var(--orange)' }}>{fmtPct(p.non_effectuated_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null

  // ── Agencies tab ───────────────────────────────────────────────────────────
  const agenciesTab = stats ? (
    <div className="tableWrap" style={{ marginTop: 14 }}>
      <table className="table tableZebra">
        <thead>
          <tr>
            <th className="th">Agency</th>
            <th className="th">Total</th>
            <th className="th">Active</th>
            <th className="th">Active Premium</th>
            <th className="th">Eff %</th>
            <th className="th">Cancel %</th>
            <th className="th">Non-eff %</th>
            <th className="th">Pending</th>
            <th className="th">Lapsed</th>
          </tr>
        </thead>
        <tbody>
          {stats.agencies.map(a => (
            <tr key={a.id}>
              <td className="td tdStrong">{a.name}</td>
              <td className="td">{a.total.toLocaleString()}</td>
              <td className="td">{a.active.toLocaleString()}</td>
              <td className="td tdStrong">{fmt$(a.active_premium)}</td>
              <td className="td" style={{ color: 'var(--green)' }}>{fmtPct(a.effectuation_rate)}</td>
              <td className="td" style={{ color: 'var(--red)' }}>{fmtPct(a.cancel_rate)}</td>
              <td className="td" style={{ color: 'var(--orange)' }}>{fmtPct(a.non_effectuated_rate)}</td>
              <td className="td">{a.pending.toLocaleString()}</td>
              <td className="td">{a.lapsed.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null

  // ── Agents tab ─────────────────────────────────────────────────────────────
  const agentsTab = stats ? (
    <div className="tableWrap" style={{ marginTop: 14 }}>
      <table className="table tableZebra">
        <thead>
          <tr>
            <th className="th">Agent</th>
            <th className="th">WA Code</th>
            <th className="th">Agency</th>
            <th className="th">Active</th>
            <th className="th">Active Premium</th>
            <th className="th">Eff %</th>
            <th className="th">Cancel %</th>
            <th className="th">Pending</th>
          </tr>
        </thead>
        <tbody>
          {stats.agents.slice(0, 200).map(a => (
            <tr key={`${a.agent_name}-${a.wa_code}-${a.agency_code}`}>
              <td className="td tdStrong">{a.agent_name || '—'}</td>
              <td className="td">{a.wa_code || '—'}</td>
              <td className="td">{a.agency_name || a.agency_code || '—'}</td>
              <td className="td">{a.active.toLocaleString()}</td>
              <td className="td tdStrong">{fmt$(a.active_premium)}</td>
              <td className="td" style={{ color: 'var(--green)' }}>{fmtPct(a.effectuation_rate)}</td>
              <td className="td" style={{ color: 'var(--red)' }}>{fmtPct(a.cancel_rate)}</td>
              <td className="td">{a.pending.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pageSub" style={{ marginTop: 8 }}>Top 200 agents by active premium.</div>
    </div>
  ) : null

  // ── Drill-down panel ───────────────────────────────────────────────────────
  const drillPanel = drillTitle ? (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="cardInner">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{drillTitle}</div>
            <div className="pageSub">{drillTotal.toLocaleString()} policies</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btnGold" style={{ fontSize: 12 }} onClick={exportDrill} disabled={drillExporting}>
              {drillExporting ? 'Exporting…' : '⬇ Export CSV'}
            </button>
            <button className="btn" disabled={drillLoading || drillPage <= 1}
              onClick={() => fetchDrill(drillClassifications, drillTitle, drillPage - 1)}>← Prev</button>
            <button className="btn" disabled={drillLoading || drillPage >= drillTotalPages}
              onClick={() => fetchDrill(drillClassifications, drillTitle, drillPage + 1)}>Next →</button>
            <button className="btn btnGhost" onClick={() => { setDrillTitle(''); setDrillRows([]); setDrillTotal(0) }}>✕</button>
          </div>
        </div>
        {drillError && <div className="alert" style={{ marginTop: 10 }}>{drillError}</div>}
        <div className="tableWrap" style={{ marginTop: 10 }}>
          <table className="table tableZebra">
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
              {drillRows.map(p => (
                <tr key={p.id}>
                  <td className="td tdStrong">{p.policy_number}</td>
                  <td className="td">{`${p.first_name || ''} ${p.last_name || ''}`.trim() || '—'}</td>
                  <td className="td">{p.agent_name || '—'}</td>
                  <td className="td">{p.issue_state || '—'}</td>
                  <td className="td">{fmtDate(p.issue_date)}</td>
                  <td className="td">{fmtDate(p.paid_to_date)}</td>
                  <td className="td tdStrong">{fmt$(p.annual_premium)}</td>
                  <td className="td">{p.classification}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pageSub" style={{ marginTop: 8 }}>Page {drillPage} of {drillTotalPages}</div>
        </div>
      </div>
    </div>
  ) : null

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {syncBar}

      {statsLoading ? (
        <>
          <div className="skeleton" style={{ height: 26, width: 240, marginBottom: 8 }} />
          <div className="skeleton" style={{ height: 14, width: 380, marginBottom: 20 }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {[0,1,2,3].map(i => (
              <div key={i} className="card">
                <div className="cardInner">
                  <div className="skeleton" style={{ height: 11, width: 100 }} />
                  <div className="skeleton" style={{ height: 28, width: 120, marginTop: 10 }} />
                  <div className="skeleton" style={{ height: 11, width: 80, marginTop: 8 }} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : statsError ? (
        <div className="alert">{statsError}</div>
      ) : !stats ? (
        <div className="alert">No policy data yet. Run a UNL import first.</div>
      ) : (
        <>
          {filtersSection}
          {kpiSection}

          <div style={{ marginTop: 22 }}>
            <div className="pillRow">
              {(['overview', 'agencies', 'agents'] as const).map(t => (
                <button key={t} className={`pill${activeTab === t ? ' pillActive' : ''}`} onClick={() => setActiveTab(t)}>
                  {t === 'overview' ? 'Overview' : t === 'agencies' ? 'Agencies' : 'Agents'}
                </button>
              ))}
            </div>

            {activeTab === 'overview' && overviewTab}
            {activeTab === 'agencies' && agenciesTab}
            {activeTab === 'agents' && agentsTab}
          </div>

          {drillPanel}
        </>
      )}
    </div>
  )
}
