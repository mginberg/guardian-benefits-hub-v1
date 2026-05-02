import React, { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
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
    return () => {
      cancelled = true
    }
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

function Shell({ children, me, onLogout }: { children: React.ReactNode; me: Me; onLogout: () => void }) {
  return (
    <div className="appShell">
      <div className="topbar">
        <div className="topbarInner">
          <div className="brand">
            <div className="brandTitle">Guardian Benefits Hub</div>
            <div className="brandMeta">
              {me.display_name || me.email} · {me.role}
              {me.impersonated_by ? ' · impersonating (read-only)' : ''}
            </div>
            <div className="nav">
              <Link to="/" className="navLink">
                Dashboard
              </Link>
              <Link to="/policy-book" className="navLink navLinkPrimary">
                Policy Book
              </Link>
              {me.role === 'super_admin' && (
                <Link to="/settings/agencies" className="navLink">
                  Agencies
                </Link>
              )}
            </div>
          </div>
          <button onClick={onLogout} className="btn btnGhost">
            Logout
          </button>
        </div>
      </div>
      <div className="container">{children}</div>
    </div>
  )
}

export function App() {
  const { token, me, loading, login, logout } = useSession()

  if (loading) return <div style={{ padding: 24, opacity: 0.8 }}>Loading…</div>

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
            <Shell me={me} onLogout={logout}>
              <DashboardPage token={token} me={{ role: me.role, agency_id: me.agency_id }} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings/agencies"
        element={
          me ? (
            <Shell me={me} onLogout={logout}>
              <AgenciesPage token={token} />
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/policy-book"
        element={
          me ? (
            <Shell me={me} onLogout={logout}>
              <PolicyBookPage token={token} me={{ role: me.role, agency_id: me.agency_id }} />
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

