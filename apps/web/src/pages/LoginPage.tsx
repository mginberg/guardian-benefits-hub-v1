import React, { useState } from 'react'
import { apiPost } from '../lib/api'

type LoginMode = 'agent' | 'admin'

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<LoginMode>('agent')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
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
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 'var(--sp-4)', background: 'var(--bg-app)' }}>
      <div style={{ width: '100%', maxWidth: 440 }}>

        {/* Brand mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-6)', justifyContent: 'center' }}>
          {/* Shield logo */}
          <svg width="42" height="48" viewBox="0 0 42 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M21 2L4 9V22C4 32.5 11.5 42.1 21 46C30.5 42.1 38 32.5 38 22V9L21 2Z"
              fill="url(#lg)" stroke="rgba(139,92,246,.4)" strokeWidth="1.5"/>
            <path d="M14 24l5 5 9-9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <defs>
              <linearGradient id="lg" x1="4" y1="2" x2="38" y2="46" gradientUnits="userSpaceOnUse">
                <stop stopColor="#7c3aed"/>
                <stop offset="1" stopColor="#4f46e5"/>
              </linearGradient>
            </defs>
          </svg>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: '-.3px', lineHeight: 1.1 }}>
              <span style={{ color: '#fff' }}>Guardian</span>{' '}
              <span style={{ color: '#c4b5fd' }}>Benefits</span>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.4)', fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>
              Operations Hub
            </div>
          </div>
        </div>

        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(255,255,255,.04)', padding: 4, borderRadius: 14, border: '1px solid rgba(255,255,255,.08)' }}>
          {(['agent', 'admin'] as LoginMode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError('') }}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 11, fontWeight: 700, fontSize: 14, cursor: 'pointer', border: 'none', transition: 'all .2s',
                ...(mode === m
                  ? { background: 'linear-gradient(135deg,#7c3aed,#5b21b6)', color: '#fff', boxShadow: '0 4px 14px rgba(124,58,237,.4)' }
                  : { background: 'transparent', color: 'rgba(255,255,255,.4)' })
              }}
            >
              {m === 'agent' ? '👤 Agent Login' : '🛡 Admin Login'}
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 'var(--sp-6)' }}>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, marginBottom: 'var(--sp-1)' }}>
            {mode === 'agent' ? 'Agent sign in' : 'Admin sign in'}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--sp-5)' }}>
            {mode === 'agent'
              ? 'Sign in to view your leaderboard rankings, deals, and team stats.'
              : 'Sign in to manage agencies, view reports, and configure the platform.'}
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <div className="field">
              <label className="fieldLabel">Email</label>
              <input
                className="input"
                style={{ width: '100%' }}
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                required
                autoComplete="email"
                placeholder={mode === 'agent' ? 'agent@guardian-benefits.com' : 'admin@guardian-benefits.com'}
              />
            </div>
            <div className="field">
              <label className="fieldLabel">Password</label>
              <input
                className="input"
                style={{ width: '100%' }}
                value={password}
                onChange={e => setPassword(e.target.value)}
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
              style={{
                marginTop: 'var(--sp-2)', width: '100%', padding: '12px var(--sp-4)', fontSize: 15,
                fontWeight: 700, borderRadius: 12, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                background: loading ? 'rgba(139,92,246,.4)' : 'linear-gradient(135deg,#7c3aed,#5b21b6)',
                color: '#fff', boxShadow: loading ? 'none' : '0 4px 16px rgba(124,58,237,.4)', transition: 'all .2s',
              }}
            >
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: 'rgba(255,255,255,.25)' }}>
          Guardian Benefits Hub · Secure Portal
        </div>
      </div>
    </div>
  )
}
