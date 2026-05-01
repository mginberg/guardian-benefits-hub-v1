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
    <div style={{ minHeight: '100vh' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>Guardian Benefits Hub</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              {me.display_name || me.email} · {me.role}{me.impersonated_by ? ' · impersonating (read-only)' : ''}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
              <Link to="/" style={{ color: '#e5e7eb', opacity: 0.9, textDecoration: 'none', fontWeight: 800 }}>
                Dashboard
              </Link>
              <Link to="/policy-book" style={{ color: '#e5e7eb', opacity: 0.9, textDecoration: 'none', fontWeight: 800 }}>
                Policy Book
              </Link>
              {me.role === 'super_admin' && (
                <Link to="/settings/agencies" style={{ color: '#e5e7eb', opacity: 0.9, textDecoration: 'none', fontWeight: 800 }}>
                  Agencies
                </Link>
              )}
            </div>
          </div>
          <button
            onClick={onLogout}
            style={{
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: '#e5e7eb',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            Logout
          </button>
        </div>
      </div>
      <div style={{ padding: 20 }}>{children}</div>
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
              <DashboardPage token={token} />
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

