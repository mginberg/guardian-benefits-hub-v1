import React, { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet } from './lib/api'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { AgenciesPage } from './pages/AgenciesPage'
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
  { label: 'Dashboard',    to: '/',                  icon: '⬡' },
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
          <div className="sidebarLogoIcon">G</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: '-.1px', color: '#fff', lineHeight: 1.2 }}>Guardian</div>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: '-.1px', color: 'var(--gold-bright)', lineHeight: 1.2 }}>Benefits</div>
            <div style={{ fontWeight: 600, fontSize: 10, color: 'rgba(255,255,255,.42)', letterSpacing: '.5px', textTransform: 'uppercase', marginTop: 2 }}>Hub</div>
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
