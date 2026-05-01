import React, { useState } from 'react'
import { apiPost } from '../lib/api'

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 420, borderRadius: 16, padding: 18, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>Sign in</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 14 }}>
          Use your admin email/password.
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
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8, fontWeight: 700 }}>Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              autoComplete="email"
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(0,0,0,0.25)',
                color: '#e5e7eb',
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: 0.8, fontWeight: 700 }}>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoComplete="current-password"
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(0,0,0,0.25)',
                color: '#e5e7eb',
              }}
            />
          </label>
          {error && (
            <div style={{ padding: 10, borderRadius: 12, background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.25)', color: '#fecaca', fontSize: 12 }}>
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid rgba(201,168,76,0.35)',
              background: 'linear-gradient(180deg, rgba(201,168,76,0.25), rgba(201,168,76,0.10))',
              color: '#f5f3e6',
              fontWeight: 900,
              cursor: 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

