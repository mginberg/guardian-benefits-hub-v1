import React, { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'

type MeLite = { role: string; agency_id: string }

type Agent = {
  rank: number
  wa_code: string
  agent_name: string
  agency_id: string
  agency_name: string
  total: number
  active: number
  active_premium: number
  cancelled: number
  pending: number
  effectuation_rate: number
  cancel_rate: number
}

type LeaderboardData = {
  agents: Agent[]
  last_sync: string | null
  last_file: string | null
  agency_list: Array<{ id: string; name: string }>
}

const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
const fmtPct = (n: number) => `${(n || 0).toFixed(1)}%`
const fmtDt = (iso: string | null | undefined) => {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function dateStr(d: Date) { return d.toISOString().slice(0, 10) }

const DATE_PRESETS = [
  { label: 'MTD', getRange: () => { const n = new Date(); return { from: dateStr(new Date(n.getFullYear(), n.getMonth(), 1)), to: dateStr(n) } } },
  { label: 'YTD', getRange: () => { const n = new Date(); return { from: dateStr(new Date(n.getFullYear(), 0, 1)), to: dateStr(n) } } },
  { label: 'L30', getRange: () => { const t = new Date(), f = new Date(); f.setDate(f.getDate() - 30); return { from: dateStr(f), to: dateStr(t) } } },
  { label: 'L90', getRange: () => { const t = new Date(), f = new Date(); f.setDate(f.getDate() - 90); return { from: dateStr(f), to: dateStr(t) } } },
  { label: 'All', getRange: () => ({ from: '', to: '' }) },
]

const RANK_COLORS = ['#fbbf24', '#9ca3af', '#c2855a']  // gold, silver, bronze

function RankBadge({ rank }: { rank: number }) {
  const color = rank <= 3 ? RANK_COLORS[rank - 1] : 'rgba(255,255,255,.20)'
  const size = rank <= 3 ? 32 : 28
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: rank <= 3
        ? `radial-gradient(circle at 35% 35%, ${color}, ${color}aa)`
        : 'rgba(255,255,255,.06)',
      border: `1.5px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: rank <= 3 ? 13 : 11,
      fontWeight: 900,
      color: rank <= 3 ? (rank === 1 ? '#422006' : '#fff') : 'rgba(255,255,255,.55)',
      flexShrink: 0,
      boxShadow: rank <= 3 ? `0 0 10px ${color}55` : 'none',
    }}>
      {rank}
    </div>
  )
}

export function LeaderboardPage({ token, me }: { token: string; me: MeLite }) {
  const [data, setData] = useState<LeaderboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [metric, setMetric] = useState<'premium' | 'active' | 'total'>('premium')
  const [agencyFilter, setAgencyFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [activePreset, setActivePreset] = useState('')

  const [appliedAgency, setAppliedAgency] = useState('')
  const [appliedFrom, setAppliedFrom] = useState('')
  const [appliedTo, setAppliedTo] = useState('')

  const fetchData = async (ag = appliedAgency, df = appliedFrom, dt = appliedTo, m = metric) => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams()
      if (ag) qs.set('agency_id', ag)
      if (df) qs.set('date_from', df)
      if (dt) qs.set('date_to', dt)
      qs.set('metric', m)
      qs.set('limit', '50')
      const res = await apiGet<LeaderboardData>(`/api/leaderboard?${qs}`, token)
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load leaderboard')
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = (p: typeof DATE_PRESETS[0]) => {
    const { from, to } = p.getRange()
    setDateFrom(from); setDateTo(to)
    setAppliedFrom(from); setAppliedTo(to)
    setActivePreset(p.label)
    fetchData(appliedAgency, from, to, metric)
  }

  const apply = () => {
    setAppliedAgency(agencyFilter); setAppliedFrom(dateFrom); setAppliedTo(dateTo)
    setActivePreset('')
    fetchData(agencyFilter, dateFrom, dateTo, metric)
  }

  const switchMetric = (m: typeof metric) => {
    setMetric(m)
    fetchData(appliedAgency, appliedFrom, appliedTo, m)
  }

  const peak = data?.agents?.length
    ? Math.max(...data.agents.map(a =>
        metric === 'premium' ? a.active_premium : metric === 'active' ? a.active : a.total
      ), 1)
    : 1

  return (
    <div>
      {/* Header + sync badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 'var(--sp-5)' }}>
        <div>
          <div className="pageTitle">Leaderboard</div>
          <div className="pageSub">
            Agent production rankings — synced from UNL · {data?.agents?.length ?? '—'} agents
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {data?.last_sync && (
            <span className="badge badgeGreen" style={{ fontSize: 11 }}>
              ✓ Synced {fmtDt(data.last_sync)}
            </span>
          )}
          {data?.last_file && (
            <span className="badge badgeBlue" style={{ fontSize: 10 }}>{data.last_file}</span>
          )}
          <button className="btn btnGhost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => fetchData()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Metric toggle */}
      <div className="pillRow" style={{ marginBottom: 'var(--sp-4)' }}>
        {([
          { key: 'premium', label: '💰 Active Premium' },
          { key: 'active',  label: '✅ Active Policies' },
          { key: 'total',   label: '📋 Total Written' },
        ] as const).map(m => (
          <button key={m.key} className={`pill${metric === m.key ? ' pillActive' : ''}`}
            onClick={() => switchMetric(m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--sp-4)' }}>
        {/* Date presets */}
        {DATE_PRESETS.map(p => (
          <button key={p.label} className={`pill${activePreset === p.label ? ' pillActive' : ''}`}
            style={{ fontSize: 12, padding: '5px 11px' }} onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
        <div style={{ width: 1, height: 28, background: 'var(--border)', margin: '0 4px' }} />
        <div className="field">
          <label className="fieldLabel">From</label>
          <input className="input" type="date" value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setActivePreset('') }} />
        </div>
        <div className="field">
          <label className="fieldLabel">To</label>
          <input className="input" type="date" value={dateTo}
            onChange={e => { setDateTo(e.target.value); setActivePreset('') }} />
        </div>
        {me.role === 'super_admin' && data?.agency_list?.length ? (
          <div className="field">
            <label className="fieldLabel">Agency</label>
            <select className="select" value={agencyFilter} onChange={e => setAgencyFilter(e.target.value)}>
              <option value="">All agencies</option>
              {data.agency_list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        ) : null}
        <button className="btn btnGold" onClick={apply} style={{ alignSelf: 'flex-end' }}>Apply</button>
        {(appliedFrom || appliedTo || appliedAgency) && (
          <button className="btn btnGhost" style={{ alignSelf: 'flex-end' }} onClick={() => {
            setDateFrom(''); setDateTo(''); setAgencyFilter('')
            setAppliedFrom(''); setAppliedTo(''); setAppliedAgency('')
            setActivePreset('')
            fetchData('', '', '', metric)
          }}>Clear</button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: 'grid', gap: 'var(--sp-2)' }}>
          {[0,1,2,3,4,5].map(i => (
            <div key={i} className="card">
              <div className="cardInner" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)', padding: '14px 16px' }}>
                <div className="skeleton" style={{ width: 32, height: 32, borderRadius: '50%' }} />
                <div style={{ flex: 1 }}>
                  <div className="skeleton" style={{ height: 13, width: 160, marginBottom: 6 }} />
                  <div className="skeleton" style={{ height: 10, width: 100 }} />
                </div>
                <div className="skeleton" style={{ height: 24, width: 90 }} />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="alert">{error}</div>
      ) : !data?.agents?.length ? (
        <div className="card"><div className="cardInner" style={{ color: 'var(--text-muted)' }}>No data yet — run a UNL import first.</div></div>
      ) : (
        <>
          {/* Top 3 podium cards */}
          {data.agents.slice(0, 3).length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--sp-4)', marginBottom: 'var(--sp-5)' }}>
              {data.agents.slice(0, 3).map(agent => {
                const metricVal = metric === 'premium' ? fmt$(agent.active_premium)
                  : metric === 'active' ? agent.active.toLocaleString()
                  : agent.total.toLocaleString()
                const metricLabel = metric === 'premium' ? 'Active Premium'
                  : metric === 'active' ? 'Active Policies' : 'Total Written'
                const color = RANK_COLORS[agent.rank - 1]
                return (
                  <div key={agent.wa_code} className="card" style={{
                    borderTop: `3px solid ${color}`,
                    background: `linear-gradient(160deg, ${color}14, rgba(255,255,255,.02))`,
                    position: 'relative',
                  }}>
                    <div className="cardInner" style={{ padding: '18px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                        <RankBadge rank={agent.rank} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, fontSize: 'var(--text-md)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {agent.agent_name}
                          </div>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {agent.wa_code} · {agent.agency_name}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: 28, fontWeight: 900, color, letterSpacing: '-.5px', lineHeight: 1 }}>
                        {metricVal}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 4 }}>{metricLabel}</div>
                      <div style={{ display: 'flex', gap: 16, marginTop: 14 }}>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Eff %</div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--green)' }}>{fmtPct(agent.effectuation_rate)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Cancel %</div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{fmtPct(agent.cancel_rate)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Pending</div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{agent.pending}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Full ranked list */}
          <div className="card">
            <div className="cardInner" style={{ padding: '0 0 4px' }}>
              <div style={{ overflowX: 'auto' }}>
                <table className="table tableZebra" style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th className="th" style={{ width: 48 }}>#</th>
                      <th className="th">Agent</th>
                      <th className="th">WA Code</th>
                      {me.role === 'super_admin' && <th className="th">Agency</th>}
                      <th className="th">Active Premium</th>
                      <th className="th">Active</th>
                      <th className="th">Total Written</th>
                      <th className="th">Pending</th>
                      <th className="th">Eff %</th>
                      <th className="th">Cancel %</th>
                      <th className="th" style={{ minWidth: 120 }}>Bar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map(agent => {
                      const metricNum = metric === 'premium' ? agent.active_premium
                        : metric === 'active' ? agent.active : agent.total
                      const barPct = Math.max(4, Math.round((metricNum / peak) * 100))
                      return (
                        <tr key={`${agent.wa_code}-${agent.agent_name}`}>
                          <td className="td" style={{ paddingLeft: 14 }}>
                            <RankBadge rank={agent.rank} />
                          </td>
                          <td className="td tdStrong">{agent.agent_name || '—'}</td>
                          <td className="td" style={{ color: 'var(--text-muted)' }}>{agent.wa_code || '—'}</td>
                          {me.role === 'super_admin' && <td className="td" style={{ color: 'var(--text-muted)' }}>{agent.agency_name}</td>}
                          <td className="td tdStrong">{fmt$(agent.active_premium)}</td>
                          <td className="td">{agent.active.toLocaleString()}</td>
                          <td className="td">{agent.total.toLocaleString()}</td>
                          <td className="td">{agent.pending.toLocaleString()}</td>
                          <td className="td" style={{ color: 'var(--green)' }}>{fmtPct(agent.effectuation_rate)}</td>
                          <td className="td" style={{ color: 'var(--red)' }}>{fmtPct(agent.cancel_rate)}</td>
                          <td className="td">
                            <div className="bar">
                              <div className="barFill" style={{ width: `${barPct}%` }} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
