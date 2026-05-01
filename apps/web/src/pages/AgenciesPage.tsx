import React, { useEffect, useMemo, useState } from 'react'
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api'

type Agency = {
  id: string
  slug: string
  name: string
  is_active: boolean
  unl_prefix: string
  ghl_location_id: string
  ghl_pit_token_set: boolean
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 16,
        padding: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 900, letterSpacing: 0.2 }}>{title}</div>
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  )
}

export function AgenciesPage({ token }: { token: string }) {
  const [agencies, setAgencies] = useState<Agency[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [newSlug, setNewSlug] = useState('')
  const [newName, setNewName] = useState('')
  const [newPrefix, setNewPrefix] = useState('')

  const [selectedId, setSelectedId] = useState<string>('')
  const selected = useMemo(() => agencies.find((a) => a.id === selectedId) || null, [agencies, selectedId])

  const [editName, setEditName] = useState('')
  const [editActive, setEditActive] = useState(true)
  const [editPrefix, setEditPrefix] = useState('')
  const [editGhlLocationId, setEditGhlLocationId] = useState('')
  const [editPitToken, setEditPitToken] = useState('')

  async function refresh() {
    setError('')
    setLoading(true)
    try {
      const res = await apiGet<{ agencies: Agency[] }>('/api/agencies', token)
      setAgencies(res.agencies)
      if (!selectedId && res.agencies.length) setSelectedId(res.agencies[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agencies')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!selected) return
    setEditName(selected.name)
    setEditActive(selected.is_active)
    setEditPrefix(selected.unl_prefix || '')
    setEditGhlLocationId(selected.ghl_location_id || '')
    setEditPitToken('')
  }, [selected?.id])

  if (loading) return <div style={{ opacity: 0.8 }}>Loading…</div>

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 950 }}>Agencies</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
          Configure UNL routing + connect GoHighLevel per agency. Secrets are stored encrypted; we never show tokens back once saved.
        </div>
      </div>

      {error && (
        <div
          style={{
            borderRadius: 14,
            padding: 12,
            border: '1px solid rgba(254,202,202,0.35)',
            background: 'rgba(254,202,202,0.06)',
            color: '#fecaca',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <Card title="Create agency">
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
              Slug (unique)
              <input
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="medigap"
                style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
              Name
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Medigap"
                style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
              UNL prefix (optional)
              <input
                value={newPrefix}
                onChange={(e) => setNewPrefix(e.target.value)}
                placeholder="NEW"
                style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
              />
            </label>
            <button
              onClick={async () => {
                setError('')
                try {
                  const created = await apiPost<Agency>('/api/agencies', { slug: newSlug, name: newName, unl_prefix: newPrefix }, token)
                  setAgencies((prev) => [...prev, created].sort((a, b) => a.slug.localeCompare(b.slug)))
                  setSelectedId(created.id)
                  setNewSlug('')
                  setNewName('')
                  setNewPrefix('')
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Failed to create agency')
                }
              }}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(201,168,76,0.35)',
                background: 'rgba(201,168,76,0.12)',
                color: '#f5f3e6',
                fontWeight: 900,
                cursor: 'pointer',
              }}
            >
              Create
            </button>
          </div>
        </Card>

        <Card title="Agency list">
          {!agencies.length ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>No agencies yet.</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {agencies.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedId(a.id)}
                  style={{
                    textAlign: 'left',
                    padding: '10px 10px',
                    borderRadius: 12,
                    border: a.id === selectedId ? '1px solid rgba(201,168,76,0.35)' : '1px solid rgba(255,255,255,0.10)',
                    background: a.id === selectedId ? 'rgba(201,168,76,0.10)' : 'rgba(0,0,0,0.14)',
                    color: '#e5e7eb',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>{a.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{a.slug}</div>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8, textAlign: 'right' }}>
                      <div>{a.is_active ? 'Active' : 'Inactive'}</div>
                      <div>{a.ghl_pit_token_set ? 'GHL: connected' : 'GHL: not set'}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="Edit selected">
          {!selected ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>Select an agency to edit.</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
                Name
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
                Active
                <select
                  value={editActive ? 'true' : 'false'}
                  onChange={(e) => setEditActive(e.target.value === 'true')}
                  style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </label>

              <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
                UNL prefix
                <input
                  value={editPrefix}
                  onChange={(e) => setEditPrefix(e.target.value)}
                  placeholder="NEW"
                  style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
                GHL Location ID
                <input
                  value={editGhlLocationId}
                  onChange={(e) => setEditGhlLocationId(e.target.value)}
                  placeholder="..."
                  style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
                />
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={async () => {
                    setError('')
                    try {
                      const updated = await apiPatch<Agency>(
                        `/api/agencies/${selected.id}`,
                        { name: editName, is_active: editActive, unl_prefix: editPrefix, ghl_location_id: editGhlLocationId },
                        token,
                      )
                      setAgencies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)).sort((a, b) => a.slug.localeCompare(b.slug)))
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed to save')
                    }
                  }}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.14)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#e5e7eb',
                    fontWeight: 900,
                    cursor: 'pointer',
                  }}
                >
                  Save basics
                </button>
                <button
                  onClick={async () => {
                    setError('')
                    try {
                      await apiPut<Agency>(`/api/agencies/${selected.id}/ghl-token`, { pit_token: editPitToken }, token)
                      setEditPitToken('')
                      await refresh()
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed to set token')
                    }
                  }}
                  disabled={!editPitToken.trim()}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid rgba(201,168,76,0.35)',
                    background: editPitToken.trim() ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.03)',
                    color: '#f5f3e6',
                    fontWeight: 900,
                    cursor: editPitToken.trim() ? 'pointer' : 'not-allowed',
                    opacity: editPitToken.trim() ? 1 : 0.7,
                  }}
                >
                  Set PIT token
                </button>
              </div>

              <label style={{ display: 'grid', gap: 6, fontSize: 12, opacity: 0.85 }}>
                GHL PIT token (write-only)
                <input
                  value={editPitToken}
                  onChange={(e) => setEditPitToken(e.target.value)}
                  placeholder={selected.ghl_pit_token_set ? 'Token saved (enter a new one to rotate)' : 'pit-...'}
                  style={{ padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(0,0,0,0.18)', color: '#e5e7eb' }}
                />
              </label>

              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Current status: {selected.ghl_pit_token_set ? 'GHL token set' : 'GHL token not set'}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

