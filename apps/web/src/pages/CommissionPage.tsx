import React, { useState, useEffect, useCallback } from 'react'
import { Upload, RefreshCw, AlertTriangle, CheckCircle, FileText, ChevronDown, Download } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

interface Analytics {
  total_records: number
  active_count: number
  chargeback_count: number
  active_premium: number
  chargeback_amount: number
  earned_commission: number
  by_source: Record<string, { count: number; chargebacks: number }>
}

interface CommRecord {
  id: string
  policy_number: string
  agent: string
  insured: string
  monthly_premium: number
  advance_amount: number
  earned_commission: number
  status: string
  source: string
  effective_date: string
  chargeback_amount: number
  chargeback_date: string
  plan_status: string
  trans_type: string
  paid_to_agent: boolean
}

interface SyncLog {
  id: string
  statement_type: string
  file_name: string
  total_rows: number
  matched_rows: number
  unmatched_rows: number
  chargeback_rows: number
  created_at: string
}

interface Unmatched {
  id: string
  policy_number: string
  raw_data: Record<string, string>
  created_at: string
}

const fmt$ = (n: number) => '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const fmtDt = (s: string) => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent: string }) {
  const accentMap: Record<string, { bg: string; border: string; color: string }> = {
    purple: { bg: 'rgba(167,139,250,.14)', border: '#a78bfa', color: '#a78bfa' },
    green:  { bg: 'rgba(52,211,153,.14)',  border: '#34d399', color: '#34d399' },
    red:    { bg: 'rgba(248,113,113,.14)', border: '#f87171', color: '#f87171' },
    teal:   { bg: 'rgba(34,211,238,.14)',  border: '#22d3ee', color: '#22d3ee' },
    orange: { bg: 'rgba(251,146,60,.14)',  border: '#fb923c', color: '#fb923c' },
    blue:   { bg: 'rgba(96,165,250,.14)',  border: '#60a5fa', color: '#60a5fa' },
  }
  const a = accentMap[accent] || accentMap.purple
  return (
    <div style={{ borderRadius: 14, padding: '18px 20px', background: a.bg,
      border: `1px solid rgba(255,255,255,.07)`, borderTop: `3px solid ${a.border}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(238,241,248,.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 900, lineHeight: 1, color: a.color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'rgba(238,241,248,.4)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export function CommissionPage({ me }: { me: { role: string; agency_id: string; agency_slug?: string } | null }) {
  const [agencies, setAgencies] = useState<{ id: string; slug: string; name: string }[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string>('')
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [records, setRecords] = useState<CommRecord[]>([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [logs, setLogs] = useState<SyncLog[]>([])
  const [unmatched, setUnmatched] = useState<Unmatched[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadResults, setUploadResults] = useState<any[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [activeTab, setActiveTab] = useState<'records' | 'logs' | 'unmatched'>('records')
  const [showUnmatched, setShowUnmatched] = useState(false)

  const isSuperAdmin = me?.role === 'super_admin'
  const PAGE_SIZE = 100

  useEffect(() => {
    if (isSuperAdmin) {
      apiGet<any[]>('/api/agencies').then(d => setAgencies(Array.isArray(d) ? d : []))
    }
  }, [isSuperAdmin])

  useEffect(() => {
    if (!isSuperAdmin && me?.agency_slug) {
      setSelectedSlug(me.agency_slug)
    }
  }, [isSuperAdmin, me])

  const effectiveSlug = isSuperAdmin ? selectedSlug : (me?.agency_slug || '')

  const loadData = useCallback(async () => {
    if (!effectiveSlug) return
    setLoading(true)
    try {
      const [a, r, l, u] = await Promise.all([
        apiGet<Analytics>(`/api/commission-sync/${effectiveSlug}/analytics`),
        apiGet<any>(`/api/commission-sync/${effectiveSlug}/records?status=${statusFilter}&source=${sourceFilter}&search=${encodeURIComponent(search)}&offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`),
        apiGet<SyncLog[]>(`/api/commission-sync/${effectiveSlug}/logs?limit=20`),
        apiGet<Unmatched[]>(`/api/commission-sync/${effectiveSlug}/unmatched?limit=200`),
      ])
      setAnalytics(a)
      setRecords(r.records || [])
      setTotalRecords(r.total || 0)
      setLogs(Array.isArray(l) ? l : [])
      setUnmatched(Array.isArray(u) ? u : [])
    } finally {
      setLoading(false)
    }
  }, [effectiveSlug, statusFilter, sourceFilter, search, page])

  useEffect(() => { loadData() }, [loadData])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>, isMaster = false) => {
    if (!e.target.files?.length) return
    setUploading(true)
    setUploadResults([])
    const form = new FormData()
    Array.from(e.target.files).forEach(f => form.append('files', f))
    const url = isMaster
      ? '/api/commission-sync/master-upload'
      : `/api/commission-sync/${effectiveSlug}/upload`
    try {
      const token = localStorage.getItem('token') || ''
      const resp = await fetch((import.meta.env.VITE_API_BASE || '') + url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      })
      const data = await resp.json()
      setUploadResults(data.results || [])
      await loadData()
    } catch (err: any) {
      setUploadResults([{ error: err.message }])
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const exportCsv = () => {
    if (!records.length) return
    const headers = ['Policy #', 'Agent', 'Insured', 'Monthly Premium', 'Advance', 'Earned', 'Status', 'Source', 'Effective Date', 'CB Amount', 'CB Date']
    const rows = records.map(r => [
      r.policy_number, r.agent, r.insured, r.monthly_premium, r.advance_amount,
      r.earned_commission, r.status, r.source, r.effective_date, r.chargeback_amount, r.chargeback_date,
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv]))
    a.download = `commission_records_${effectiveSlug}.csv`; a.click()
  }

  const sourceTag = (src: string) => {
    const colors: Record<string, string> = { WA: '#a78bfa', WC: '#34d399', MC: '#22d3ee' }
    const c = colors[src] || '#94a3b8'
    return (
      <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
        background: `${c}22`, color: c, border: `1px solid ${c}44` }}>{src}</span>
    )
  }

  return (
    <div style={{ padding: '24px 28px', background: '#0d0920', minHeight: '100vh', color: '#eef1f8', fontFamily: 'Geist,system-ui,sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, margin: '0 0 4px', letterSpacing: '-.02em' }}>Commission Sync</h1>
          <p style={{ margin: 0, color: 'rgba(238,241,248,.45)', fontSize: 13 }}>Upload WA · WC · MC statements → auto-syncs to GHL</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {isSuperAdmin && (
            <select value={selectedSlug} onChange={e => { setSelectedSlug(e.target.value); setPage(0) }}
              style={{ background: '#1a0d42', border: '1px solid rgba(255,255,255,.12)', color: '#eef1f8',
                borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>
              <option value="">— Select agency —</option>
              {agencies.map(a => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
          )}
          <button onClick={loadData} disabled={loading}
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,.12)',
              background: 'transparent', color: 'rgba(255,255,255,.5)', cursor: 'pointer' }}>
            <RefreshCw style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>

      {!effectiveSlug && isSuperAdmin && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(238,241,248,.3)', fontSize: 15 }}>
          Select an agency above to view commission records
        </div>
      )}

      {effectiveSlug && (
        <>
          {/* Upload section */}
          <div style={{ display: 'grid', gridTemplateColumns: isSuperAdmin ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 24 }}>
            <div style={{ borderRadius: 14, padding: '20px 22px', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.07)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
                <FileText style={{ width: 14, height: 14, marginRight: 6, verticalAlign: 'middle', color: '#a78bfa' }} />
                Upload Agency Statement
              </div>
              <p style={{ fontSize: 12, color: 'rgba(238,241,248,.4)', margin: '0 0 12px' }}>
                WA / WC / MC — detected automatically from filename. Writes to GHL immediately.
              </p>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10,
                background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                <Upload style={{ width: 14, height: 14 }} />
                {uploading ? 'Uploading…' : 'Choose Files'}
                <input type="file" accept=".csv" multiple style={{ display: 'none' }} onChange={e => handleUpload(e, false)} disabled={uploading} />
              </label>
            </div>

            {isSuperAdmin && (
              <div style={{ borderRadius: 14, padding: '20px 22px', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(167,139,250,.2)', borderTop: '3px solid #a78bfa' }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
                  <FileText style={{ width: 14, height: 14, marginRight: 6, verticalAlign: 'middle', color: '#a78bfa' }} />
                  Guardian Master Upload
                </div>
                <p style={{ fontSize: 12, color: 'rgba(238,241,248,.4)', margin: '0 0 12px' }}>
                  Splits rows by agent number prefix → routes to each agency automatically. Unmatched rows are saved for review.
                </p>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10,
                  background: 'rgba(167,139,250,.2)', color: '#a78bfa', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  border: '1.5px solid rgba(167,139,250,.4)' }}>
                  <Upload style={{ width: 14, height: 14 }} />
                  {uploading ? 'Uploading…' : 'Master Upload'}
                  <input type="file" accept=".csv" multiple style={{ display: 'none' }} onChange={e => handleUpload(e, true)} disabled={uploading} />
                </label>
              </div>
            )}
          </div>

          {/* Upload results */}
          {uploadResults.length > 0 && (
            <div style={{ borderRadius: 14, padding: '16px 20px', background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.2)', marginBottom: 20 }}>
              {uploadResults.map((r: any, i) => (
                <div key={i} style={{ marginBottom: i < uploadResults.length - 1 ? 10 : 0 }}>
                  {r.error ? (
                    <div style={{ color: '#f87171', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangle style={{ width: 14, height: 14 }} /> {r.error}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <CheckCircle style={{ width: 14, height: 14, color: '#34d399' }} />
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{r.file}</span>
                      {sourceTag(r.type)}
                      <span style={{ fontSize: 12, color: 'rgba(238,241,248,.5)' }}>
                        {r.matched} matched · {r.unmatched} unmatched · {r.chargebacks} chargebacks
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Analytics cards */}
          {analytics && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 24 }}>
              <StatCard label="Total Records" value={analytics.total_records.toLocaleString()} accent="purple" />
              <StatCard label="Active" value={analytics.active_count.toLocaleString()} sub={fmt$(analytics.active_premium) + ' premium'} accent="green" />
              <StatCard label="Chargebacks" value={analytics.chargeback_count.toLocaleString()} sub={fmt$(analytics.chargeback_amount)} accent="red" />
              <StatCard label="Earned Commission" value={fmt$(analytics.earned_commission)} accent="teal" />
              <StatCard label="WA Records" value={analytics.by_source?.WA?.count ?? 0} sub={`${analytics.by_source?.WA?.chargebacks ?? 0} chargebacks`} accent="purple" />
              <StatCard label="WC Records" value={analytics.by_source?.WC?.count ?? 0} sub={`${analytics.by_source?.WC?.chargebacks ?? 0} chargebacks`} accent="blue" />
              <StatCard label="MC Records" value={analytics.by_source?.MC?.count ?? 0} sub={`${analytics.by_source?.MC?.chargebacks ?? 0} chargebacks`} accent="orange" />
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,.07)', paddingBottom: 0 }}>
            {(['records', 'logs', 'unmatched'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                style={{ padding: '8px 18px', borderRadius: '10px 10px 0 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: activeTab === t ? 'rgba(167,139,250,.15)' : 'transparent',
                  color: activeTab === t ? '#a78bfa' : 'rgba(238,241,248,.45)',
                  borderBottom: activeTab === t ? '2px solid #a78bfa' : '2px solid transparent' }}>
                {t === 'records' ? `Records (${totalRecords.toLocaleString()})` : t === 'logs' ? `Upload History` : `Unmatched (${unmatched.length})`}
              </button>
            ))}
          </div>

          {/* Records tab */}
          {activeTab === 'records' && (
            <div style={{ borderRadius: 14, background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.07)', overflow: 'hidden' }}>
              {/* Filters */}
              <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,.06)', flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={search} onChange={e => { setSearch(e.target.value); setPage(0) }}
                  placeholder="Search policy, agent, insured…"
                  style={{ flex: 1, minWidth: 200, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.1)', color: '#eef1f8',
                    borderRadius: 8, padding: '7px 12px', fontSize: 13 }} />
                <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }}
                  style={{ background: '#1a0d42', border: '1px solid rgba(255,255,255,.1)', color: '#eef1f8', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}>
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="chargeback">Chargeback</option>
                </select>
                <select value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setPage(0) }}
                  style={{ background: '#1a0d42', border: '1px solid rgba(255,255,255,.1)', color: '#eef1f8', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}>
                  <option value="">All sources</option>
                  <option value="WA">WA</option>
                  <option value="WC">WC</option>
                  <option value="MC">MC</option>
                </select>
                <button onClick={exportCsv} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,.12)',
                  background: 'transparent', color: 'rgba(238,241,248,.6)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Download style={{ width: 13, height: 13 }} /> Export
                </button>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
                      {['Policy #', 'Source', 'Agent', 'Insured', 'Premium', 'Advance', 'Status', 'Eff. Date', 'CB Amount'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, fontSize: 11,
                          color: 'rgba(238,241,248,.45)', letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'rgba(238,241,248,.3)' }}>Loading…</td></tr>
                    ) : records.length === 0 ? (
                      <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'rgba(238,241,248,.3)' }}>No records found</td></tr>
                    ) : records.map((r, i) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,.04)',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.018)' }}>
                        <td style={{ padding: '10px 14px', fontWeight: 700, color: '#a78bfa', fontFamily: 'monospace' }}>{r.policy_number}</td>
                        <td style={{ padding: '10px 14px' }}>{sourceTag(r.source)}</td>
                        <td style={{ padding: '10px 14px', color: 'rgba(238,241,248,.8)' }}>{r.agent || '—'}</td>
                        <td style={{ padding: '10px 14px', color: 'rgba(238,241,248,.7)' }}>{r.insured || '—'}</td>
                        <td style={{ padding: '10px 14px', fontWeight: 700 }}>{fmt$(r.monthly_premium)}</td>
                        <td style={{ padding: '10px 14px' }}>{fmt$(r.advance_amount)}</td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                            background: r.status === 'chargeback' ? 'rgba(248,113,113,.18)' : 'rgba(52,211,153,.15)',
                            color: r.status === 'chargeback' ? '#f87171' : '#34d399',
                            border: `1px solid ${r.status === 'chargeback' ? 'rgba(248,113,113,.3)' : 'rgba(52,211,153,.25)'}` }}>
                            {r.status}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px', color: 'rgba(238,241,248,.5)', fontSize: 12 }}>{r.effective_date || '—'}</td>
                        <td style={{ padding: '10px 14px', color: r.chargeback_amount > 0 ? '#f87171' : 'rgba(238,241,248,.3)', fontWeight: r.chargeback_amount > 0 ? 700 : 400 }}>
                          {r.chargeback_amount > 0 ? fmt$(r.chargeback_amount) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalRecords > PAGE_SIZE && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,.06)', fontSize: 12 }}>
                  <span style={{ color: 'rgba(238,241,248,.4)' }}>
                    Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalRecords)} of {totalRecords.toLocaleString()}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                      style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid rgba(255,255,255,.1)',
                        background: 'transparent', color: 'rgba(238,241,248,.6)', cursor: page === 0 ? 'not-allowed' : 'pointer' }}>Prev</button>
                    <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE_SIZE >= totalRecords}
                      style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid rgba(255,255,255,.1)',
                        background: 'transparent', color: 'rgba(238,241,248,.6)', cursor: (page + 1) * PAGE_SIZE >= totalRecords ? 'not-allowed' : 'pointer' }}>Next</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Upload history tab */}
          {activeTab === 'logs' && (
            <div style={{ borderRadius: 14, background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.07)', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
                    {['File', 'Type', 'Total', 'Matched', 'Unmatched', 'Chargebacks', 'Date'].map(h => (
                      <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 700, fontSize: 11,
                        color: 'rgba(238,241,248,.4)', letterSpacing: '.06em', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'rgba(238,241,248,.3)' }}>No uploads yet</td></tr>
                  ) : logs.map((l, i) => (
                    <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,.04)', background: i % 2 ? 'rgba(255,255,255,.018)' : 'transparent' }}>
                      <td style={{ padding: '10px 16px', fontFamily: 'monospace', fontSize: 12, color: 'rgba(238,241,248,.7)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.file_name}</td>
                      <td style={{ padding: '10px 16px' }}>{sourceTag(l.statement_type.replace('master_', ''))}{l.statement_type.startsWith('master') && <span style={{ fontSize: 10, color: '#a78bfa', marginLeft: 4 }}>master</span>}</td>
                      <td style={{ padding: '10px 16px', fontWeight: 700 }}>{l.total_rows}</td>
                      <td style={{ padding: '10px 16px', color: '#34d399' }}>{l.matched_rows}</td>
                      <td style={{ padding: '10px 16px', color: l.unmatched_rows > 0 ? '#fb923c' : 'rgba(238,241,248,.4)' }}>{l.unmatched_rows}</td>
                      <td style={{ padding: '10px 16px', color: l.chargeback_rows > 0 ? '#f87171' : 'rgba(238,241,248,.4)' }}>{l.chargeback_rows}</td>
                      <td style={{ padding: '10px 16px', fontSize: 12, color: 'rgba(238,241,248,.4)' }}>{fmtDt(l.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Unmatched tab */}
          {activeTab === 'unmatched' && (
            <div style={{ borderRadius: 14, background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.07)', overflow: 'hidden' }}>
              {unmatched.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: 'rgba(238,241,248,.3)', fontSize: 14 }}>
                  <CheckCircle style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: .4 }} />
                  No unmatched rows
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,.07)' }}>
                      {['Policy #', 'Agent Nbr', 'Details', 'Added'].map(h => (
                        <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 700, fontSize: 11,
                          color: 'rgba(238,241,248,.4)', letterSpacing: '.06em', textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {unmatched.map((u, i) => (
                      <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,.04)', background: i % 2 ? 'rgba(255,255,255,.018)' : 'transparent' }}>
                        <td style={{ padding: '10px 16px', fontWeight: 700, color: '#fb923c', fontFamily: 'monospace' }}>{u.policy_number}</td>
                        <td style={{ padding: '10px 16px', color: 'rgba(238,241,248,.6)' }}>{u.raw_data?.agent_nbr || '—'}</td>
                        <td style={{ padding: '10px 16px', fontSize: 11, color: 'rgba(238,241,248,.4)' }}>
                          {u.raw_data?.first_name} {u.raw_data?.last_name} · {u.raw_data?.plan_code || u.raw_data?.mc_trans_type || ''}
                        </td>
                        <td style={{ padding: '10px 16px', fontSize: 12, color: 'rgba(238,241,248,.35)' }}>{fmtDt(u.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
