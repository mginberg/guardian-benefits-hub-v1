import React, { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ChevronRight, Globe2 } from 'lucide-react'
import { apiGet } from '../lib/api'

interface AgencyInfo { slug: string; name: string; code: string }

export function LeaderboardIndexPage() {
  const navigate = useNavigate()
  const [agencies, setAgencies] = useState<AgencyInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiGet<AgencyInfo[]>('/api/leaderboard')
      .then(d => setAgencies(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const isLoggedIn = !!localStorage.getItem('token')

  return (
    <div style={{ minHeight: '100vh', background: '#0d0920', fontFamily: 'Geist,system-ui,sans-serif', color: '#eef1f8' }}>
      {/* Header — matches leaderboard page exactly */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 32px', height: 64, background: '#1a0d42',
        borderBottom: '1px solid rgba(255,255,255,.09)', boxShadow: '0 2px 16px rgba(0,0,0,.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* SVG shield matching dashboard */}
          <svg width="28" height="32" viewBox="0 0 36 40" fill="none">
            <defs>
              <linearGradient id="lsg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4a6cf7"/>
                <stop offset="100%" stopColor="#9b40f0"/>
              </linearGradient>
            </defs>
            <path d="M18 1L35 7.5V22C35 31.5 27.5 37.5 18 40C8.5 37.5 1 31.5 1 22V7.5L18 1Z" fill="url(#lsg)"/>
            <path d="M11 20.5L16 25.5L25 15" stroke="#22c55e" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{ fontWeight: 900, fontSize: 14, color: '#fff' }}>Guardian</span>
              <span style={{ fontWeight: 900, fontSize: 14, color: '#b8aaff' }}>Benefits</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 10, color: 'rgba(255,255,255,.38)', letterSpacing: '.6px', textTransform: 'uppercase' }}>Leaderboard</div>
          </div>
        </div>
        <Link to={isLoggedIn ? '/' : '/login'}
          style={{ padding: '8px 18px', borderRadius: 10, fontWeight: 700, fontSize: 13,
            background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', textDecoration: 'none',
            boxShadow: '0 4px 14px rgba(124,58,237,.35)' }}>
          {isLoggedIn ? 'Portal' : 'Login'}
        </Link>
      </header>

      <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 20px' }}>
        {/* Title */}
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 32, fontWeight: 900, margin: '0 0 8px', letterSpacing: '-.03em' }}>
            🏆 Leaderboard
          </h1>
          <p style={{ color: 'rgba(238,241,248,.5)', fontSize: 15, margin: 0 }}>Select an agency to view rankings</p>
        </div>

        {/* Combined card */}
        <div style={{ marginBottom: 16 }}>
          <button onClick={() => navigate('/leaderboard/all')} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
            padding: '20px 24px', borderRadius: 14, cursor: 'pointer', textAlign: 'left', transition: 'all .2s',
            background: 'linear-gradient(135deg,rgba(139,92,246,.18),rgba(91,33,182,.08))',
            border: '1.5px solid rgba(139,92,246,.5)', color: '#fff', fontSize: 15, fontWeight: 700,
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(139,92,246,.25)' }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Globe2 style={{ width: 22, height: 22, color: '#a78bfa', flexShrink: 0 }} />
              <div>
                <div>Combined — All Agencies</div>
                <div style={{ fontSize: 12, fontWeight: 400, color: 'rgba(238,241,248,.5)', marginTop: 2 }}>Every agency rolled up into one ranking</div>
              </div>
            </div>
            <ChevronRight style={{ width: 18, height: 18, color: '#a78bfa', flexShrink: 0 }} />
          </button>
        </div>

        {/* Agency grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 10 }}>
          {loading ? (
            <div style={{ color: 'rgba(238,241,248,.4)', textAlign: 'center', padding: 48, gridColumn: '1/-1' }}>Loading agencies…</div>
          ) : agencies.map(a => (
            <button key={a.slug} onClick={() => navigate(`/leaderboard/${a.slug}`)} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 20px', borderRadius: 12, cursor: 'pointer', textAlign: 'left', transition: 'all .2s',
              background: 'rgba(255,255,255,.042)', border: '1px solid rgba(255,255,255,.09)',
              color: '#eef1f8', fontSize: 14, fontWeight: 600,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.072)'; e.currentTarget.style.borderColor = 'rgba(139,92,246,.4)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,.042)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,.09)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Mini shield per agency */}
                <svg width="18" height="20" viewBox="0 0 36 40" fill="none" style={{ flexShrink: 0 }}>
                  <defs>
                    <linearGradient id={`ag-${a.slug}`} x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#4a6cf7"/>
                      <stop offset="100%" stopColor="#9b40f0"/>
                    </linearGradient>
                  </defs>
                  <path d="M18 1L35 7.5V22C35 31.5 27.5 37.5 18 40C8.5 37.5 1 31.5 1 22V7.5L18 1Z" fill={`url(#ag-${a.slug})`}/>
                  <path d="M11 20.5L16 25.5L25 15" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>{a.name}</span>
              </div>
              <ChevronRight style={{ width: 16, height: 16, color: 'rgba(238,241,248,.3)', flexShrink: 0 }} />
            </button>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: 48, fontSize: 12, color: 'rgba(238,241,248,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <svg width="12" height="14" viewBox="0 0 36 40" fill="none">
            <path d="M18 1L35 7.5V22C35 31.5 27.5 37.5 18 40C8.5 37.5 1 31.5 1 22V7.5L18 1Z" fill="rgba(255,255,255,.2)"/>
          </svg>
          Guardian Benefits Hub
        </div>
      </div>
    </div>
  )
}
