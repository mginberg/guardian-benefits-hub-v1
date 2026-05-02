import React, { useState } from 'react'
import { apiPost } from '../lib/api'

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'var(--sp-4)' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>

        {/* Brand mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-6)', justifyContent: 'center' }}>
          <div className="sidebarLogoIcon" style={{ width: 44, height: 44, borderRadius: 'var(--radius-md)', fontSize: 22 }}>G</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)', letterSpacing: '-.1px' }}>Guardian Benefits Hub</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>Operations & Analytics</div>
          </div>
        </div>

        <div className="card" style={{ padding: 'var(--sp-6)' }}>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, marginBottom: 'var(--sp-1)' }}>Sign in</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--sp-5)' }}>
            Use your admin email and password.
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setLoading(true)
              setError('')
              try {
                const res = await apiPost<{ access_token: string }>('/api/auth/login', { email, password })
                onLogin(res.access_token)
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Login failed')
              } finally {
                setLoading(false)
              }
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}
          >
            <div className="field">
              <label className="fieldLabel">Email</label>
              <input
                className="input"
                style={{ width: '100%' }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                required
                autoComplete="email"
                placeholder="you@guardian-benefits.com"
              />
            </div>
            <div className="field">
              <label className="fieldLabel">Password</label>
              <input
                className="input"
                style={{ width: '100%' }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </div>

            {error && <div className="alert">{error}</div>}

            <button
              type="submit"
              disabled={loading}
              className="btn btnGold"
              style={{ marginTop: 'var(--sp-2)', width: '100%', justifyContent: 'center', padding: '11px var(--sp-4)', fontSize: 'var(--text-md)' }}
            >
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
