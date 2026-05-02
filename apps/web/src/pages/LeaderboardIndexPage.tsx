import React, { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Trophy, Building2, ChevronRight, Shield, Globe2 } from 'lucide-react'
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

  const Card = ({ onClick, gradient, borderColor, shadowColor, children }: {
    onClick: () => void; gradient: string; borderColor: string; shadowColor: string; children: React.ReactNode
  }) => (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
      padding: '24px 28px', background: gradient, border: `1px solid ${borderColor}`, borderRadius: 14,
      cursor: 'pointer', color: '#f8fafc', fontSize: 16, fontWeight: 700, textAlign: 'left', transition: 'all .2s',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 6px 24px ${shadowColor}` }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none' }}>
      {children}
    </button>
  )

  const isLoggedIn = !!localStorage.getItem('token')

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#0b1426 0%,#1a2744 50%,#0b1426 100%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '3rem 1rem' }}>
      {/* Top right login */}
      <div style={{ position: 'absolute', top: 20, right: 24 }}>
        <Link to={isLoggedIn ? '/' : '/login'}
          style={{ padding: '9px 20px', borderRadius: 12, fontWeight: 700, fontSize: 14,
            background: 'linear-gradient(135deg,#c9a84c,#a88a35)', color: '#142748', textDecoration: 'none',
            boxShadow: '0 4px 16px rgba(201,168,76,.35)' }}>
          {isLoggedIn ? 'Portal' : 'Login'}
        </Link>
      </div>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Trophy style={{ width: 40, height: 40, color: '#c9a84c' }} />
          <span style={{ fontSize: 40, fontWeight: 900, background: 'linear-gradient(135deg,#c9a84c,#e6c55a)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Leaderboard</span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 17 }}>Select an agency to view rankings</p>
      </div>

      {/* All Downlines + Guardian parent cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12, maxWidth: 860, margin: '0 auto 12px' }}>
        <Card onClick={() => navigate('/leaderboard/all')}
          gradient="linear-gradient(135deg,rgba(201,168,76,.18),rgba(230,197,90,.08))"
          borderColor="rgba(201,168,76,.55)" shadowColor="rgba(201,168,76,.25)">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Globe2 style={{ width: 24, height: 24, color: '#e6c55a', flexShrink: 0 }} />
            <div>
              <div>Combined — All Agencies</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: '#cbd5e1', marginTop: 3 }}>Every agency rolled up into one ranking</div>
            </div>
          </div>
          <ChevronRight style={{ width: 20, height: 20, color: '#c9a84c', flexShrink: 0 }} />
        </Card>
      </div>

      {/* Agency cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, maxWidth: 860, margin: '0 auto' }}>
        {loading ? (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: 48, gridColumn: '1/-1' }}>Loading agencies…</div>
        ) : agencies.map(a => (
          <Card key={a.slug} onClick={() => navigate(`/leaderboard/${a.slug}`)}
            gradient="rgba(255,255,255,.03)"
            borderColor="rgba(201,168,76,.20)" shadowColor="rgba(201,168,76,.15)">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Building2 style={{ width: 20, height: 20, color: '#c9a84c', flexShrink: 0 }} />
              <span>{a.name}</span>
            </div>
            <ChevronRight style={{ width: 18, height: 18, color: '#64748b', flexShrink: 0 }} />
          </Card>
        ))}
      </div>

      <div style={{ textAlign: 'center', marginTop: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 6, color: '#475569', fontSize: 13 }}>
        <Shield style={{ width: 14, height: 14 }} />
        <span>Guardian Benefits Hub</span>
      </div>
    </div>
  )
}
