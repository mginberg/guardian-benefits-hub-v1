import React, { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet } from './lib/api'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { AgenciesPage } from './pages/AgenciesPage'
import { LeaderboardPage } from './pages/LeaderboardPage'
import { LeaderboardIndexPage } from './pages/LeaderboardIndexPage'
import { PolicyBookPage } from './pages/PolicyBookPage'

type Me = {
  user_id: string
  agency_id: string
  role: string
  email: string
  display_name: string
  impersonated_by?: string | null
}

function useSession() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '')
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!token) {
        setMe(null)
        setLoading(false)
        return
      }
      try {
        const res = await apiGet<Me>('/api/auth/me', token)
        if (!cancelled) setMe(res)
      } catch {
        if (!cancelled) {
          localStorage.removeItem('token')
          setToken('')
          setMe(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [token])

  const login = (newToken: string) => {
    localStorage.setItem('token', newToken)
    setToken(newToken)
  }
  const logout = () => {
    localStorage.removeItem('token')
    setToken('')
    setMe(null)
  }

  return { token, me, loading, login, logout }
}

type NavItem = {
  label: string
  to: string
  icon: string
  adminOnly?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    to: '/',             icon: '⬡' },
  { label: 'Leaderboard',  to: '/leaderboard',  icon: '🏆' },
  { label: 'Agencies',     to: '/settings/agencies', icon: '🏢', adminOnly: true },
]

function Sidebar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const location = useLocation()
  const initials = (me.display_name || me.email || '?')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('')

  return (
    <aside className="sidebar">
      <div className="sidebarBrand">
        <div className="sidebarLogo">
          {/* SVG shield — matches Guardian Benefits logo */}
          <svg width="34" height="38" viewBox="0 0 36 40" fill="none" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4a6cf7"/>
                <stop offset="100%" stopColor="#9b40f0"/>
              </linearGradient>
              <linearGradient id="sg2" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#6a8eff" stopOpacity=".45"/>
                <stop offset="100%" stopColor="#b060ff" stopOpacity=".45"/>
              </linearGradient>
            </defs>
            <path d="M18 1L35 7.5V22C35 31.5 27.5 37.5 18 40C8.5 37.5 1 31.5 1 22V7.5L18 1Z" fill="url(#sg)"/>
            <path d="M18 5L31 10.5V22C31 29.5 25.5 34.5 18 37C10.5 34.5 5 29.5 5 22V10.5L18 5Z" fill="none" stroke="url(#sg2)" strokeWidth="1.5"/>
            {/* Green checkmark */}
            <path d="M11 20.5L16 25.5L25 15" stroke="#22c55e" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {/* Horizontal lockup: Guardian Benefits · Hub */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{ fontWeight: 900, fontSize: 14, color: '#fff', letterSpacing: '-.1px' }}>Guardian</span>
              <span style={{ fontWeight: 900, fontSize: 14, color: '#b8aaff', letterSpacing: '-.1px' }}>Benefits</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: 10, color: 'rgba(255,255,255,.38)', letterSpacing: '.6px', textTransform: 'uppercase' }}>Hub</div>
          </div>
        </div>
      </div>

      <nav className="sidebarNav">
        <div className="sidebarSection">Navigation</div>
        {NAV_ITEMS.filter((item) => !item.adminOnly || me.role === 'super_admin').map((item) => {
          const active = item.to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`sidebarLink${active ? ' sidebarLinkActive' : ''}`}
            >
              <span className="sidebarLinkIcon">{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="sidebarFooter">
        <div className="sidebarUser">
          <div className="sidebarAvatar">{initials}</div>
          <div className="sidebarUserInfo">
            <div className="sidebarUserName">{me.display_name || me.email}</div>
            <div className="sidebarUserRole">{me.role.replace('_', ' ')}</div>
          </div>
        </div>
        <button
          className="btn btnGhost"
          style={{ width: '100%', marginTop: 10, fontSize: 12, padding: '7px 10px' }}
          onClick={onLogout}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}

function Shell({ children, me, onLogout, pageTitle, pageSub }: {
  children: React.ReactNode
  me: Me
  onLogout: () => void
  pageTitle?: string
  pageSub?: string
}) {
  return (
    <div className="appShell">
      <Sidebar me={me} onLogout={onLogout} />
      <div className="mainContent">
        {pageTitle && (
          <header className="pageHeader">
            <div className="pageHeaderLeft">
              <div className="pageHeaderTitle">{pageTitle}</div>
              {pageSub && <div className="pageHeaderSub">{pageSub}</div>}
            </div>
            {me.impersonated_by && (
              <div className="badge badgeOrange">View-only (impersonating)</div>
            )}
          </header>
        )}
        <div className="container">{children}</div>
      </div>
    </div>
  )
}

export function App() {
  const { token, me, loading, login, logout } = useSession()

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', opacity: .6 }}>
        Loading…
      </div>
    )
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={me ? <Navigate to="/" replace /> : <LoginPage onLogin={login} />}
      />
      <Route
        path="/"
        element={
          me ? (
            <Shell me={me} onLogout={logout} pageTitle="Dashboard">
              <DashboardPage token={token} me={{ role: me.role, agency_id: me.agency_id }} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/leaderboard"
        element={
          me ? (
            <Shell me={me} onLogout={logout} pageTitle="Leaderboard">
              <LeaderboardIndexPage token={token} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/leaderboard/:agencySlug"
        element={
          me ? (
            <Shell me={me} onLogout={logout} pageTitle="Leaderboard">
              <LeaderboardPage token={token} me={{ role: me.role, agency_id: me.agency_id }} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/policy-book"
        element={<Navigate to="/" replace />}
      />
      <Route
        path="/settings/agencies"
        element={
          me ? (
            <Shell me={me} onLogout={logout} pageTitle="Agencies" pageSub="Manage agency configuration">
              <AgenciesPage token={token} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
