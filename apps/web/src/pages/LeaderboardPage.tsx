import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  Trophy, RefreshCw, MapPin, Briefcase,
  BarChart3, AlertCircle, ChevronLeft,
} from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'

type MeLite = { role: string; agency_id: string } | null

/* ─── helpers ─── */
const fmt$ = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)

const getInitials = (name: string) => {
  const p = name.split(' ')
  return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase()
}

const getAvatarGradient = (name: string) => {
  const colors = [
    'linear-gradient(135deg,#7c3aed,#a78bfa)',
    'linear-gradient(135deg,#0d9488,#14b8a6)',
    'linear-gradient(135deg,#3b82f6,#60a5fa)',
    'linear-gradient(135deg,#8b5cf6,#a78bfa)',
    'linear-gradient(135deg,#f97316,#fb923c)',
    'linear-gradient(135deg,#ec4899,#f472b6)',
    'linear-gradient(135deg,#06b6d4,#22d3ee)',
    'linear-gradient(135deg,#10b981,#34d399)',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

const getRankStyle = (rank: number): React.CSSProperties => {
  if (rank === 1) return { background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', color: '#fff', boxShadow: '0 3px 12px rgba(139,92,246,0.5)' }
  if (rank === 2) return { background: 'linear-gradient(135deg,#38bdf8,#60a5fa)', color: '#0c2d4a', boxShadow: '0 3px 10px rgba(56,189,248,0.35)' }
  if (rank === 3) return { background: 'linear-gradient(135deg,#f97316,#fb923c)', color: '#fff', boxShadow: '0 3px 10px rgba(249,115,22,0.35)' }
  return { background: 'linear-gradient(135deg,#a78bfa,#c4b5fd)', color: '#2e1065', boxShadow: '0 2px 8px rgba(167,139,250,0.3)' }
}

const getSideRankStyle = (rank: number): React.CSSProperties => {
  if (rank === 1) return { background: 'linear-gradient(135deg,#7c3aed,#a78bfa)', color: '#fff' }
  if (rank === 2) return { background: 'linear-gradient(135deg,#38bdf8,#60a5fa)', color: '#0c2d4a' }
  if (rank === 3) return { background: 'linear-gradient(135deg,#f97316,#fb923c)', color: '#fff' }
  return { background: 'linear-gradient(135deg,#a78bfa,#c4b5fd)', color: '#2e1065' }
}

const getBarFill = (rank: number) => {
  if (rank === 1) return 'linear-gradient(90deg,#7c3aed,#a78bfa)'
  if (rank === 2) return 'linear-gradient(90deg,#14b8a6,#5eead4)'
  if (rank === 3) return 'linear-gradient(90deg,#3b82f6,#60a5fa)'
  return 'linear-gradient(90deg,#8b5cf6,#a78bfa)'
}

/* ─── types ─── */
interface Leader { name: string; deals: number; premium: number }
interface BreakdownItem { label: string; count: number; premium: number }
interface PeriodData {
  period: string; start_date: string; end_date: string; period_label: string
  leaders: Leader[]; total_deals: number; total_premium: number
}
interface LBResponse {
  daily: PeriodData; weekly: PeriodData; monthly: PeriodData
  agency_name: string; agency_slug: string; last_sync: string | null
  daily_breakdown: { states: BreakdownItem[]; plan_types: BreakdownItem[] }
  weekly_breakdown: { states: BreakdownItem[]; plan_types: BreakdownItem[] }
  monthly_breakdown: { states: BreakdownItem[]; plan_types: BreakdownItem[] }
}

/* ─── CSS animations injected once ─── */
const STYLE_ID = 'lb-animations-v1'
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = `
    @keyframes lb-flame   { 0%,100%{transform:scale(1) rotate(0deg)} 25%{transform:scale(1.15) rotate(-3deg)} 75%{transform:scale(1.2) rotate(-2deg)} }
    @keyframes lb-zap     { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.7;transform:scale(1.15)} }
    @keyframes lb-star    { 0%,100%{opacity:1;transform:rotate(0deg)} 50%{opacity:.7;transform:rotate(15deg)} }
    @keyframes lb-glow    { 0%,100%{box-shadow:0 0 8px rgba(139,92,246,.3)} 50%{box-shadow:0 0 20px rgba(139,92,246,.6)} }
    @keyframes lb-float   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
    @keyframes lb-rainbow { 0%{filter:hue-rotate(0deg) brightness(1.1)} 50%{filter:hue-rotate(90deg) brightness(1.3)} 100%{filter:hue-rotate(0deg) brightness(1.1)} }
    @keyframes lb-pop-in  { 0%{opacity:0;transform:scale(0.5) translateY(4px)} 30%{opacity:1;transform:scale(1.1) translateY(-2px)} 100%{opacity:1;transform:scale(1) translateY(0)} }
    @keyframes lb-pop-out { 0%{opacity:1;transform:scale(1)} 100%{opacity:0;transform:scale(0.6) translateY(4px)} }
    .lb-flame  { animation: lb-flame 0.6s ease-in-out infinite }
    .lb-zap    { animation: lb-zap 0.8s ease-in-out infinite }
    .lb-star   { animation: lb-star 1.2s ease-in-out infinite }
    .lb-glow   { animation: lb-glow 2s ease-in-out infinite }
    .lb-float  { animation: lb-float 1.5s ease-in-out infinite }
    .lb-rainbow{ animation: lb-rainbow 3s linear infinite }
    .lb-badge-in  { animation: lb-pop-in 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards }
    .lb-badge-out { animation: lb-pop-out 0.3s ease-in forwards }
    .lb-milestone { display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-weight:800;letter-spacing:.03em;white-space:nowrap }
    @keyframes tierup-backdrop { 0%{opacity:0} 10%{opacity:1} 85%{opacity:1} 100%{opacity:0} }
    @keyframes tierup-zoom { 0%{opacity:0;transform:scale(0.3) rotate(-8deg)} 40%{opacity:1;transform:scale(1.15) rotate(2deg)} 70%{transform:scale(1.05)} 100%{transform:scale(1) rotate(0deg)} }
    @keyframes tierup-name { 0%{opacity:0;transform:translateY(20px)} 100%{opacity:1;transform:translateY(0)} }
    @keyframes tierup-ring { 0%{transform:scale(0.5);opacity:.8} 100%{transform:scale(3);opacity:0} }
    @keyframes tierup-particle { 0%{opacity:1;transform:translate(0,0) scale(1)} 100%{opacity:0;transform:translate(var(--px),var(--py)) scale(0.3)} }
    .tierup-backdrop { animation: tierup-backdrop 4.5s ease-in-out forwards }
    .tierup-card     { animation: tierup-zoom 0.8s cubic-bezier(0.34,1.56,0.64,1) forwards }
    .tierup-name     { animation: tierup-name 0.5s ease-out 0.5s both }
    .tierup-ring     { animation: tierup-ring 1.2s ease-out forwards; position:absolute;border-radius:50%;border:3px solid currentColor;pointer-events:none }
    .tierup-particle { animation: tierup-particle 1.5s ease-out forwards; position:absolute;border-radius:50%;pointer-events:none }
  `
  document.head.appendChild(s)
}

/* ─── Milestone tiers ─── */
const MILESTONES = [
  { min: 20, emoji: '🏆', label: 'GOAT',      anim: 'lb-rainbow', bg: 'rgba(139,92,246,.20)', glow: '0 0 12px rgba(139,92,246,.5)' },
  { min: 15, emoji: '👑', label: 'Legend',     anim: 'lb-glow',    bg: 'rgba(139,92,246,.16)', glow: '0 0 10px rgba(139,92,246,.4)' },
  { min: 10, emoji: '🚀', label: 'Rocket',     anim: 'lb-float',   bg: 'rgba(99,102,241,.16)', glow: '0 0 10px rgba(99,102,241,.4)' },
  { min: 7,  emoji: '💎', label: 'Diamond',    anim: 'lb-star',    bg: 'rgba(6,182,212,.16)',  glow: '0 0 8px rgba(6,182,212,.4)' },
  { min: 5,  emoji: '🔥', label: 'On Fire',    anim: 'lb-flame',   bg: 'rgba(249,115,22,.16)', glow: '0 0 8px rgba(249,115,22,.4)' },
  { min: 4,  emoji: '♨️', label: 'Heating Up', anim: 'lb-zap',     bg: 'rgba(250,204,21,.16)', glow: '0 0 8px rgba(250,204,21,.4)' },
  { min: 3,  emoji: '🎩', label: 'Hat Trick',  anim: 'lb-star',    bg: 'rgba(16,185,129,.16)', glow: '0 0 8px rgba(16,185,129,.4)' },
]
const getMilestone = (deals: number) => MILESTONES.find(t => deals >= t.min) ?? null
const getMilestoneTier = (deals: number) => MILESTONES.find(t => deals >= t.min)?.min ?? 0

function MilestoneBadge({ deals, index }: { deals: number; index: number }) {
  const m = getMilestone(deals)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!m) return
    let mounted = true
    const base = 1500 + (index % 5) * 800 + Math.random() * 2000
    const show = 3000 + Math.random() * 2000
    const hide = 2000 + Math.random() * 4000
    let t: ReturnType<typeof setTimeout>
    const cycle = (v: boolean) => { if (!mounted) return; setVisible(v); t = setTimeout(() => cycle(!v), v ? show : hide) }
    t = setTimeout(() => cycle(true), base)
    return () => { mounted = false; clearTimeout(t) }
  }, [m, index])
  if (!m) return null
  return (
    <span className={`lb-milestone ${m.anim} ${visible ? 'lb-badge-in' : 'lb-badge-out'}`}
      style={{ background: m.bg, boxShadow: visible ? m.glow : 'none', fontSize: 12, pointerEvents: 'none' }}>
      <span style={{ fontSize: 15 }}>{m.emoji}</span>
      <span style={{ color: 'rgba(255,255,255,.9)' }}>{m.label}</span>
    </span>
  )
}

interface TierUpEvent { agentName: string; milestone: typeof MILESTONES[0]; newDeals: number }

function TierUpCelebration({ event, onDone }: { event: TierUpEvent; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4500); return () => clearTimeout(t) }, [onDone])
  const { agentName, milestone, newDeals } = event
  const particles = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 360 * (Math.PI / 180)
    const d = 80 + Math.random() * 100
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, size: 4 + Math.random() * 6,
      color: ['#8b5cf6','#3b82f6','#f97316','#06b6d4','#a78bfa','#f472b6','#22d3ee','#fbbf24'][i % 8],
      delay: Math.random() * 0.4 }
  })
  return (
    <div className="tierup-backdrop" onClick={onDone}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle at center,rgba(11,20,38,.92),rgba(11,20,38,.97))', backdropFilter: 'blur(8px)' }}>
      <div className="tierup-card" style={{ position: 'relative', textAlign: 'center', padding: '48px 64px', borderRadius: 28,
        background: 'linear-gradient(145deg,rgba(26,48,88,.95),rgba(20,34,54,.95))',
        border: `2px solid ${milestone.glow.match(/rgba\([^)]+\)/)?.[0] || 'rgba(201,168,76,.4)'}`,
        boxShadow: `0 0 60px ${milestone.glow.match(/rgba\([^)]+\)/)?.[0] || 'rgba(201,168,76,.3)'},0 24px 48px rgba(0,0,0,.5)` }}>
        {[0,.3,.6].map((d, i) => (
          <div key={i} className="tierup-ring" style={{ width: 120, height: 120, top: '50%', left: '50%', marginTop: -60, marginLeft: -60,
            color: milestone.glow.match(/rgba\([^)]+\)/)?.[0] || '#8b5cf6', animationDelay: `${d}s`, opacity: 0 }} />
        ))}
        {particles.map((p, i) => (
          <div key={i} className="tierup-particle" style={{ width: p.size, height: p.size, background: p.color,
            top: '50%', left: '50%', '--px': `${p.x}px`, '--py': `${p.y}px`, animationDelay: `${p.delay}s` } as React.CSSProperties} />
        ))}
        <div style={{ fontSize: 80, lineHeight: 1, marginBottom: 16, filter: `drop-shadow(${milestone.glow})` }}>{milestone.emoji}</div>
        <div className="tierup-name" style={{ fontSize: 28, fontWeight: 900, color: '#fff', letterSpacing: '-.02em', marginBottom: 8 }}>{agentName}</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 28px', borderRadius: 50,
          fontSize: 20, fontWeight: 900, letterSpacing: '.04em', background: milestone.bg, boxShadow: milestone.glow, color: 'rgba(255,255,255,.95)' }}>
          <span className={milestone.anim} style={{ fontSize: 26 }}>{milestone.emoji}</span> {milestone.label}
        </div>
        <div className="tierup-name" style={{ marginTop: 16, fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,.45)', animationDelay: '.8s' }}>
          {newDeals} deals today
        </div>
      </div>
    </div>
  )
}

const getStreak = (deals: number) => {
  if (deals >= 20) return <span className="lb-rainbow" style={{ fontSize: 18, filter: 'drop-shadow(0 0 8px rgba(201,168,76,.6))' }}>🏆</span>
  if (deals >= 15) return <span className="lb-float"   style={{ fontSize: 18, filter: 'drop-shadow(0 0 6px rgba(99,102,241,.5))' }}>🚀</span>
  if (deals >= 10) return <span className="lb-flame"   style={{ fontSize: 18, filter: 'drop-shadow(0 0 6px rgba(249,115,22,.6))' }}>🔥</span>
  if (deals >= 5)  return <span className="lb-zap"     style={{ fontSize: 16, filter: 'drop-shadow(0 0 4px rgba(250,204,21,.5))' }}>⚡</span>
  if (deals >= 3)  return <span className="lb-star"    style={{ fontSize: 16, filter: 'drop-shadow(0 0 4px rgba(192,132,252,.4))' }}>⭐</span>
  return null
}

/* ─── SidePanel (This Week / This Month) ─── */
function SidePanel({ data, accentColor, label, icon }: {
  data: PeriodData; accentColor: string; label: string; icon: string
}) {
  return (
    <div style={{ borderRadius: 14, overflow: 'hidden',
      background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.07)', borderTop: `3px solid ${accentColor}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px',
        borderBottom: '1px solid rgba(255,255,255,.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12,
            background: `${accentColor}20`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{icon}</div>
          <div>
            <div style={{ fontWeight: 800, color: '#fff', fontSize: 17 }}>{label}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)' }}>{data.start_date} — {data.end_date}</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 900, fontSize: 30, color: accentColor }}>{data.total_deals}</div>
          <div style={{ fontWeight: 700, fontSize: 11, color: 'rgba(255,255,255,.4)' }}>deals</div>
          {data.total_premium > 0 && <div style={{ fontWeight: 800, fontSize: 13, color: 'rgba(238,241,248,.6)' }}>{fmt$(data.total_premium)}</div>}
        </div>
      </div>
      <div style={{ padding: 10, maxHeight: 380, overflowY: 'auto' }}>
        {!data.leaders?.length ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'rgba(255,255,255,.4)' }}>
            <Trophy style={{ width: 48, height: 48, margin: '0 auto 8px', opacity: .3 }} />
            <div style={{ fontWeight: 600 }}>No deals yet</div>
          </div>
        ) : data.leaders.map((entry, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 12, marginBottom: 6,
            padding: '11px 14px',
            background: i === 0 ? `${accentColor}22` : 'rgba(255,255,255,.04)',
            border: i === 0 ? `1px solid ${accentColor}44` : '1px solid transparent' }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 900, fontSize: 12, flexShrink: 0, ...getSideRankStyle(i + 1) }}>
              {i === 0 ? '👑' : i + 1}
            </div>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: getAvatarGradient(entry.name),
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
              {getInitials(entry.name)}
            </div>
            <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, color: 'rgba(255,255,255,.9)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {getStreak(entry.deals)}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 900, color: '#fff', fontSize: 18 }}>{entry.deals}</div>
                {entry.premium > 0 && <div style={{ fontWeight: 700, fontSize: 12, color: accentColor }}>{fmt$(entry.premium)}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Main component ─── */
export function LeaderboardPage({ me }: { me: { role: string; agency_id: string } | null }) {
  const { agencySlug } = useParams<{ agencySlug: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<LBResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'leaders' | 'breakdown'>('leaders')
  const [breakdownPeriod, setBreakdownPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [syncing, setSyncing] = useState(false)

  const token = localStorage.getItem('token') || ''

  const fetchRef = useRef(false)
  const prevDealMap = useRef<Record<string, number>>({})
  const isFirst = useRef(true)
  const [tierQueue, setTierQueue] = useState<TierUpEvent[]>([])

  const detectTierUps = useCallback((d: LBResponse) => {
    if (isFirst.current) {
      isFirst.current = false
      const m: Record<string, number> = {}
      for (const e of d.daily.leaders || []) m[e.name] = e.deals
      prevDealMap.current = m
      return
    }
    const prev = prevDealMap.current
    const events: TierUpEvent[] = []
    for (const e of d.daily.leaders || []) {
      const oldTier = getMilestoneTier(prev[e.name] ?? 0)
      const newTier = getMilestoneTier(e.deals)
      if (newTier > oldTier) {
        const m = getMilestone(e.deals)
        if (m) events.push({ agentName: e.name, milestone: m, newDeals: e.deals })
      }
    }
    const map: Record<string, number> = {}
    for (const e of d.daily.leaders || []) map[e.name] = e.deals
    prevDealMap.current = map
    if (events.length) setTierQueue(q => [...q, ...events])
  }, [])

  const fetch = useCallback(async () => {
    if (fetchRef.current) return
    fetchRef.current = true
    try {
      const slug = agencySlug || 'all'
      const d = await apiGet<LBResponse>(`/api/leaderboard/${slug}`, token)
      detectTierUps(d)
      setData(d)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load leaderboard')
    }
    setLoading(false)
    fetchRef.current = false
  }, [agencySlug, token, detectTierUps])

  useEffect(() => { fetch() }, [fetch])
  // Poll every 60s for live feel
  useEffect(() => { const id = setInterval(fetch, 60000); return () => clearInterval(id) }, [fetch])

  const manualSync = async () => {
    setSyncing(true)
    try {
      await apiPost(`/api/leaderboard/sync/${agencySlug || 'all'}`, {}, token)
      await fetch()
    } catch { /* ignore */ } finally { setSyncing(false) }
  }

  if (loading && !data) return (
    <div style={{ minHeight: '100vh', background: '#0d0920', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <RefreshCw style={{ width: 48, height: 48, color: '#a78bfa', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
        <p style={{ color: 'rgba(255,255,255,.6)', fontSize: 18 }}>Loading leaderboard…</p>
      </div>
    </div>
  )

  if (error && !data) return (
    <div style={{ minHeight: '100vh', background: '#0d0920', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <AlertCircle style={{ width: 48, height: 48, color: '#f87171', margin: '0 auto 16px' }} />
        <p style={{ color: '#f87171', fontSize: 18, marginBottom: 16 }}>{error}</p>
        <button onClick={fetch} style={{ padding: '10px 24px', borderRadius: 12, background: 'rgba(139,92,246,.15)', border: '1.5px solid rgba(139,92,246,.3)', color: '#a78bfa', fontWeight: 700, cursor: 'pointer' }}>Retry</button>
      </div>
    </div>
  )

  if (!data) return null

  const daily = data.daily
  const maxPremium = Math.max(...(daily.leaders || []).map(l => l.premium), 1)
  const summaryData = activeTab === 'breakdown'
    ? (breakdownPeriod === 'weekly' ? data.weekly : breakdownPeriod === 'monthly' ? data.monthly : data.daily)
    : data.daily
  const avgPremium = summaryData.total_deals > 0 ? summaryData.total_premium / summaryData.total_deals : 0
  const breakdown = breakdownPeriod === 'weekly' ? data.weekly_breakdown
    : breakdownPeriod === 'monthly' ? data.monthly_breakdown : data.daily_breakdown

  const stateBarColors = ['linear-gradient(90deg,#3b82f6,#60a5fa)','linear-gradient(90deg,#06b6d4,#22d3ee)','linear-gradient(90deg,#8b5cf6,#a78bfa)','linear-gradient(90deg,#14b8a6,#5eead4)','linear-gradient(90deg,#f97316,#fb923c)']
  const planBarColors  = ['linear-gradient(90deg,#8b5cf6,#a78bfa)','linear-gradient(90deg,#3b82f6,#60a5fa)','linear-gradient(90deg,#dc2626,#f87171)','linear-gradient(90deg,#059669,#34d399)','linear-gradient(90deg,#d97706,#fbbf24)']
  const stateAccents   = ['#3b82f6','#06b6d4','#8b5cf6','#14b8a6','#f97316']
  const planAccents    = ['#a78bfa','#3b82f6','#dc2626','#059669','#d97706']

  return (
    <div style={{ minHeight: '100vh', background: '#0d0920', color: '#eef1f8', fontFamily: 'Geist,system-ui,sans-serif' }}>
      {tierQueue.length > 0 && <TierUpCelebration event={tierQueue[0]} onDone={() => setTierQueue(q => q.slice(1))} />}

      {/* Header bar — matches app sidebar color exactly */}
      <header style={{ position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', height: 64, gap: 12, flexWrap: 'wrap',
        background: '#1a0d42', borderBottom: '1px solid rgba(255,255,255,.09)', boxShadow: '0 2px 16px rgba(0,0,0,.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* SVG shield — same as dashboard sidebar logo */}
          <svg width="28" height="32" viewBox="0 0 36 40" fill="none" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="lbsg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4a6cf7"/>
                <stop offset="100%" stopColor="#9b40f0"/>
              </linearGradient>
            </defs>
            <path d="M18 1L35 7.5V22C35 31.5 27.5 37.5 18 40C8.5 37.5 1 31.5 1 22V7.5L18 1Z" fill="url(#lbsg)"/>
            <path d="M11 20.5L16 25.5L25 15" stroke="#22c55e" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div>
            <h1 style={{ fontSize: 'clamp(14px,3vw,20px)', fontWeight: 900, color: '#fff', margin: 0, letterSpacing: '-.02em' }}>
              {data?.agency_name || agencySlug || 'Leaderboard'}
            </h1>
            <p style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.38)', letterSpacing: '.06em', textTransform: 'uppercase', margin: 0 }}>
              Agent Leaderboard
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={fetch}
            style={{ padding: '8px 10px', borderRadius: 10, border: '1.5px solid rgba(255,255,255,.12)',
              background: 'transparent', color: 'rgba(255,255,255,.5)', cursor: 'pointer' }}>
            <RefreshCw style={{ width: 18, height: 18 }} />
          </button>
          <Link to="/leaderboard"
            style={{ padding: '8px 10px', borderRadius: 10, border: '1.5px solid rgba(255,255,255,.12)',
              background: 'transparent', color: 'rgba(255,255,255,.5)', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, textDecoration: 'none' }}>
            <ChevronLeft style={{ width: 16, height: 16 }} /> All agencies
          </Link>
          {me ? (
            <Link to="/"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 12, fontWeight: 700, fontSize: 14,
                background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', textDecoration: 'none',
                boxShadow: '0 4px 16px rgba(139,92,246,.35)' }}>
              Portal
            </Link>
          ) : (
            <Link to="/login"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 12, fontWeight: 700, fontSize: 14,
                background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', textDecoration: 'none',
                boxShadow: '0 4px 16px rgba(139,92,246,.35)' }}>
              Login
            </Link>
          )}
        </div>
      </header>

      <div style={{ maxWidth: 1320, margin: '0 auto', padding: '28px 24px' }}>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {([['leaders','Leaders'],['breakdown','Breakdown']] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setActiveTab(k)}
            style={{ padding: '10px 20px', borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: 'pointer', border: 'none',
              ...(activeTab === k
                ? { background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', boxShadow: '0 4px 16px rgba(139,92,246,.35)' }
                : { background: 'rgba(255,255,255,.05)', color: 'rgba(255,255,255,.45)', border: '1.5px solid rgba(255,255,255,.08)' }) }}>
            {k === 'breakdown' && <BarChart3 style={{ width: 14, height: 14, display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />}
            {lbl}
          </button>
        ))}
      </div>

      {/* Summary KPI cards — exact dashboard card style */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 24 }}>
        <div style={{ borderRadius: 14, padding: '20px 22px', position: 'relative', overflow: 'hidden',
          background: 'linear-gradient(160deg,rgba(167,139,250,.14),rgba(255,255,255,.02))',
          border: '1px solid rgba(255,255,255,.07)', borderTop: '3px solid #a78bfa' }}>
          <span style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', fontSize: 36, opacity: .4 }}>🏆</span>
          <div style={{ fontWeight: 700, fontSize: 11, color: 'rgba(238,241,248,.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>Total Deals</div>
          <div style={{ fontWeight: 900, fontSize: 40, lineHeight: 1, color: '#a78bfa' }}>{summaryData.total_deals}</div>
        </div>
        <div style={{ borderRadius: 14, padding: '20px 22px', position: 'relative', overflow: 'hidden',
          background: 'linear-gradient(160deg,rgba(52,211,153,.14),rgba(255,255,255,.02))',
          border: '1px solid rgba(255,255,255,.07)', borderTop: '3px solid #34d399' }}>
          <span style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', fontSize: 36, opacity: .4 }}>💰</span>
          <div style={{ fontWeight: 700, fontSize: 11, color: 'rgba(238,241,248,.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>Total Premium</div>
          <div style={{ fontWeight: 900, fontSize: 40, lineHeight: 1, color: '#34d399' }}>{fmt$(summaryData.total_premium)}</div>
        </div>
        <div style={{ borderRadius: 14, padding: '20px 22px', position: 'relative', overflow: 'hidden',
          background: 'linear-gradient(160deg,rgba(34,211,238,.14),rgba(255,255,255,.02))',
          border: '1px solid rgba(255,255,255,.07)', borderTop: '3px solid #22d3ee' }}>
          <span style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', fontSize: 36, opacity: .4 }}>📈</span>
          <div style={{ fontWeight: 700, fontSize: 11, color: 'rgba(238,241,248,.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>Avg Premium</div>
          <div style={{ fontWeight: 900, fontSize: 40, lineHeight: 1, color: '#22d3ee' }}>{fmt$(avgPremium)}</div>
        </div>
      </div>

      {/* Leaders tab */}
      {activeTab === 'leaders' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
          {/* Today's leaders */}
          <div style={{ borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.09)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 32px', borderBottom: '1.5px solid rgba(255,255,255,.08)' }}>
              <h2 style={{ color: '#fff', fontSize: 24, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 28 }}>🏆</span> Today's Leaders
              </h2>
              <span style={{ fontSize: 14, color: 'rgba(255,255,255,.4)', fontWeight: 600 }}>{daily.period_label}</span>
            </div>
            <div style={{ padding: 20 }}>
              {!daily.leaders?.length ? (
                <div style={{ textAlign: 'center', padding: '56px 0' }}>
                  <Trophy style={{ width: 80, height: 80, margin: '0 auto 16px', color: 'rgba(255,255,255,.12)' }} />
                  <p style={{ fontWeight: 700, fontSize: 20, color: 'rgba(255,255,255,.5)' }}>No deals yet today</p>
                  <p style={{ fontWeight: 500, fontSize: 15, color: 'rgba(255,255,255,.25)', marginTop: 8 }}>Be the first to close a deal!</p>
                </div>
              ) : daily.leaders.map((entry, i) => {
                const rank = i + 1
                const pct = maxPremium > 0 ? (entry.premium / maxPremium) * 100 : 0
                const rowBg = rank === 1 ? 'linear-gradient(90deg,rgba(139,92,246,.18),rgba(139,92,246,.04))'
                  : rank === 2 ? 'linear-gradient(90deg,rgba(148,163,184,.12),transparent)'
                  : rank === 3 ? 'linear-gradient(90deg,rgba(217,119,6,.12),transparent)'
                  : 'rgba(255,255,255,.025)'
                const borderLeft = rank === 1 ? '4px solid #8b5cf6' : rank === 2 ? '4px solid #94a3b8' : rank === 3 ? '4px solid #d97706' : '4px solid rgba(255,255,255,.08)'
                return (
                  <div key={i} className={rank === 1 ? 'lb-glow' : ''} style={{
                    display: 'flex', alignItems: 'center', gap: 16, borderRadius: 16, marginBottom: 12,
                    padding: 'clamp(12px,3vw,20px) clamp(12px,3vw,24px)',
                    background: rowBg, borderLeft, transition: 'transform .15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.transform = 'translateX(3px)')}
                  onMouseLeave={e => (e.currentTarget.style.transform = 'none')}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 900, fontSize: 14, flexShrink: 0, ...getRankStyle(rank) }}>
                      {rank === 1 ? '👑' : rank}
                    </div>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: getAvatarGradient(entry.name),
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16,
                      color: '#fff', boxShadow: '0 4px 14px rgba(0,0,0,.45)', flexShrink: 0 }}>
                      {getInitials(entry.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 800, color: '#fff', fontSize: 'clamp(14px,3vw,19px)' }}>{entry.name}</span>
                        <MilestoneBadge deals={entry.deals} index={i} />
                      </div>
                      <div style={{ marginTop: 10, height: 6, borderRadius: 3, background: 'rgba(255,255,255,.08)' }}>
                        <div style={{ height: 6, borderRadius: 3, width: `${pct}%`, background: getBarFill(rank),
                          boxShadow: rank === 1 ? '0 0 10px rgba(139,92,246,.5)' : 'none', transition: 'width 1s ease' }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontWeight: 900, color: '#fff', fontSize: 'clamp(22px,5vw,36px)', lineHeight: 1 }}>{entry.deals}</div>
                      <div style={{ fontWeight: 700, fontSize: 11, color: 'rgba(255,255,255,.3)', textTransform: 'uppercase', letterSpacing: '1px', marginTop: 2 }}>deals</div>
                      {entry.premium > 0 && <div style={{ fontWeight: 800, fontSize: 'clamp(12px,2.5vw,16px)', color: '#c4b5fd', marginTop: 2 }}>{fmt$(entry.premium)}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Sidebar: week + month */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <SidePanel data={data.weekly}  accentColor="#22d3ee" label="This Week"  icon="⏱" />
            <SidePanel data={data.monthly} accentColor="#a78bfa" label="This Month" icon="⭐" />
          </div>
        </div>
      )}

      {/* Breakdown tab */}
      {activeTab === 'breakdown' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['daily','weekly','monthly'] as const).map(p => (
                <button key={p} onClick={() => setBreakdownPeriod(p)}
                  style={{ padding: '10px 20px', borderRadius: 12, fontWeight: 700, fontSize: 14, cursor: 'pointer', border: 'none',
                    ...(breakdownPeriod === p
                      ? { background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', boxShadow: '0 4px 16px rgba(139,92,246,.35)' }
                      : { background: 'rgba(255,255,255,.05)', color: 'rgba(255,255,255,.45)', border: '1.5px solid rgba(255,255,255,.08)' }) }}>
                  {p === 'daily' ? 'Today' : p === 'weekly' ? 'This Week' : 'This Month'}
                </button>
              ))}
            </div>
          </div>

          {breakdown ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 20 }}>
              {/* By State */}
              <div style={{ borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.09)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 28px', borderBottom: '1.5px solid rgba(255,255,255,.08)' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(59,130,246,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <MapPin style={{ width: 20, height: 20, color: '#60a5fa' }} />
                  </div>
                  <h2 style={{ fontWeight: 900, color: '#fff', fontSize: 20, margin: 0 }}>By State</h2>
                </div>
                <div style={{ padding: 20 }}>
                  {!breakdown.states?.length ? (
                    <div style={{ textAlign: 'center', padding: '56px 0', color: 'rgba(255,255,255,.4)' }}><MapPin style={{ width: 60, height: 60, margin: '0 auto 8px', opacity: .2 }} /><p>No data yet</p></div>
                  ) : breakdown.states.map((item, i) => {
                    const maxC = breakdown.states[0]?.count || 1
                    const pct = (item.count / maxC) * 100
                    const accent = stateAccents[i % stateAccents.length]
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, borderRadius: 18, marginBottom: 10, padding: '16px 20px',
                        background: i === 0 ? 'rgba(59,130,246,.08)' : 'rgba(255,255,255,.025)', borderLeft: `4px solid ${accent}`,
                        transition: 'transform .15s' }}
                        onMouseEnter={e => (e.currentTarget.style.transform = 'translateX(3px)')}
                        onMouseLeave={e => (e.currentTarget.style.transform = 'none')}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: `${accent}22`, color: accent,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 14, flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontWeight: 800, color: '#fff', fontSize: 16 }}>{item.label}</span>
                            <div style={{ display: 'flex', gap: 16 }}>
                              <span style={{ fontWeight: 900, color: '#fff', fontSize: 18 }}>{item.count}</span>
                              <span style={{ fontWeight: 800, fontSize: 15, color: '#4ade80' }}>{fmt$(item.premium)}</span>
                            </div>
                          </div>
                          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,.08)' }}>
                            <div style={{ height: 6, borderRadius: 3, width: `${pct}%`, background: stateBarColors[i % stateBarColors.length], transition: 'width .7s ease' }} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* By Plan Type */}
              <div style={{ borderRadius: 16, overflow: 'hidden', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.09)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 28px', borderBottom: '1.5px solid rgba(255,255,255,.08)' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(139,92,246,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Briefcase style={{ width: 20, height: 20, color: '#a78bfa' }} />
                  </div>
                  <h2 style={{ fontWeight: 900, color: '#fff', fontSize: 20, margin: 0 }}>By Plan Type</h2>
                </div>
                <div style={{ padding: 20 }}>
                  {!breakdown.plan_types?.length ? (
                    <div style={{ textAlign: 'center', padding: '56px 0', color: 'rgba(255,255,255,.4)' }}><Briefcase style={{ width: 60, height: 60, margin: '0 auto 8px', opacity: .2 }} /><p>No data yet</p></div>
                  ) : breakdown.plan_types.map((item, i) => {
                    const maxC = breakdown.plan_types[0]?.count || 1
                    const pct = (item.count / maxC) * 100
                    const accent = planAccents[i % planAccents.length]
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, borderRadius: 18, marginBottom: 10, padding: '16px 20px',
                        background: i === 0 ? 'rgba(139,92,246,.06)' : 'rgba(255,255,255,.025)', borderLeft: `4px solid ${accent}`,
                        transition: 'transform .15s' }}
                        onMouseEnter={e => (e.currentTarget.style.transform = 'translateX(3px)')}
                        onMouseLeave={e => (e.currentTarget.style.transform = 'none')}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: `${accent}22`, color: accent,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 14, flexShrink: 0 }}>{i + 1}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontWeight: 800, color: '#fff', fontSize: 16 }}>{item.label}</span>
                            <div style={{ display: 'flex', gap: 16 }}>
                              <span style={{ fontWeight: 900, color: '#fff', fontSize: 18 }}>{item.count}</span>
                              <span style={{ fontWeight: 800, fontSize: 15, color: accent }}>{fmt$(item.premium)}</span>
                            </div>
                          </div>
                          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,.08)' }}>
                            <div style={{ height: 6, borderRadius: 3, width: `${pct}%`, background: planBarColors[i % planBarColors.length], transition: 'width .7s ease' }} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ borderRadius: 16, padding: 56, textAlign: 'center', background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.09)' }}>
              <BarChart3 style={{ width: 80, height: 80, margin: '0 auto 16px', color: 'rgba(255,255,255,.12)' }} />
              <p style={{ fontWeight: 800, fontSize: 20, color: 'rgba(255,255,255,.4)' }}>No breakdown data available yet</p>
            </div>
          )}
        </div>
      )}

      <div style={{ textAlign: 'center', padding: '24px 0 8px', color: 'rgba(255,255,255,.18)', fontSize: 12, fontWeight: 600 }}>
        Last updated: {data.last_sync ? new Date(data.last_sync).toLocaleString() : 'No sync yet'} · Refreshes every 60s
      </div>
    </div>
    </div>
  )
}
