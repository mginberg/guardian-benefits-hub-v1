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
  ghl_agent_field_id: string
  ghl_premium_field_id: string
  ghl_plan_field_id: string
  ghl_field_map: string
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
  const [editAgentFieldId, setEditAgentFieldId] = useState('')
  const [editPremiumFieldId, setEditPremiumFieldId] = useState('')
  const [editPlanFieldId, setEditPlanFieldId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

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
    setEditAgentFieldId(selected.ghl_agent_field_id || '')
    setEditPremiumFieldId(selected.ghl_premium_field_id || '')
    setEditPlanFieldId(selected.ghl_plan_field_id || '')
    setSaveMsg('')
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-5)' }}>
      <div>
        <div className="pageTitle">Agencies</div>
        <div className="pageSub">
          Configure UNL routing and GoHighLevel integration per agency. PIT tokens are stored encrypted and never shown again once saved.
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--sp-4)', alignItems: 'start' }}>

        {/* Create agency */}
        <div className="card">
          <div className="cardInner" style={{ display: 'grid', gap: 'var(--sp-4)' }}>
            <div className="cardTitle">Create agency</div>

            <div className="field">
              <label className="fieldLabel">Slug (unique)</label>
              <input className="input" style={{ width: '100%' }} value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)} placeholder="medigap" />
            </div>
            <div className="field">
              <label className="fieldLabel">Display name</label>
              <input className="input" style={{ width: '100%' }} value={newName}
                onChange={(e) => setNewName(e.target.value)} placeholder="Medigap Agency" />
            </div>
            <div className="field">
              <label className="fieldLabel">UNL prefix (optional)</label>
              <input className="input" style={{ width: '100%' }} value={newPrefix}
                onChange={(e) => setNewPrefix(e.target.value)} placeholder="NEW" />
            </div>
            <button
              className="btn btnGold"
              style={{ justifyContent: 'center' }}
              onClick={async () => {
                setError('')
                try {
                  const created = await apiPost<Agency>('/api/agencies', { slug: newSlug, name: newName, unl_prefix: newPrefix }, token)
                  setAgencies((prev) => [...prev, created].sort((a, b) => a.slug.localeCompare(b.slug)))
                  setSelectedId(created.id)
                  setNewSlug(''); setNewName(''); setNewPrefix('')
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Failed to create agency')
                }
              }}
            >
              Create agency
            </button>
          </div>
        </div>

        {/* Agency list */}
        <div className="card">
          <div className="cardInner">
            <div className="cardTitle" style={{ marginBottom: 'var(--sp-3)' }}>
              All agencies ({agencies.length})
            </div>
            {!agencies.length ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No agencies yet.</div>
            ) : (
              <div style={{ display: 'grid', gap: 'var(--sp-2)' }}>
                {agencies.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    style={{
                      textAlign: 'left',
                      padding: 'var(--sp-3)',
                      borderRadius: 'var(--radius-md)',
                      border: a.id === selectedId ? '1px solid var(--gold-border)' : '1px solid var(--border)',
                      background: a.id === selectedId ? 'var(--gold-bg)' : 'rgba(0,0,0,.18)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      transition: 'border-color .12s, background .12s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-2)', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 'var(--text-sm)' }}>{a.name}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>{a.slug} · {a.unl_prefix || 'no prefix'}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                        <span className={`badge ${a.is_active ? 'badgeGreen' : 'badgeOrange'}`}>
                          {a.is_active ? 'Active' : 'Inactive'}
                        </span>
                        <span className={`badge ${a.ghl_pit_token_set ? 'badgeBlue' : 'badgeOrange'}`} style={{ fontSize: 10 }}>
                          {a.ghl_pit_token_set ? 'GHL ✓' : 'GHL ✗'}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Edit selected */}
        <div className="card">
          <div className="cardInner">
            <div className="cardTitle" style={{ marginBottom: 'var(--sp-4)' }}>
              {selected ? `Edit: ${selected.name}` : 'Edit selected'}
            </div>
            {!selected ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Select an agency from the list.</div>
            ) : (
              <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
                <div className="field">
                  <label className="fieldLabel">Display name</label>
                  <input className="input" style={{ width: '100%' }} value={editName}
                    onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="field">
                  <label className="fieldLabel">Status</label>
                  <select className="select" style={{ width: '100%' }}
                    value={editActive ? 'true' : 'false'}
                    onChange={(e) => setEditActive(e.target.value === 'true')}>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                  </select>
                </div>
                <div className="field">
                  <label className="fieldLabel">UNL prefix</label>
                  <input className="input" style={{ width: '100%' }} value={editPrefix}
                    onChange={(e) => setEditPrefix(e.target.value)} placeholder="NEW" />
                </div>
                <div className="field">
                  <label className="fieldLabel">GHL Location ID</label>
                  <input className="input" style={{ width: '100%' }} value={editGhlLocationId}
                    onChange={(e) => setEditGhlLocationId(e.target.value)} placeholder="loc_..." />
                </div>

                <hr className="divider" />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 6 }}>
                  GHL Webhook URL (Instant Leaderboard Sync)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <code style={{ fontSize: 11, background: 'rgba(255,255,255,.06)', padding: '6px 10px', borderRadius: 6,
                    border: '1px solid rgba(255,255,255,.12)', wordBreak: 'break-all', color: 'var(--text-muted)', flex: 1 }}>
                    {(import.meta.env.VITE_API_BASE || window.location.origin)}/api/leaderboard/webhook/{selected.slug}
                  </code>
                  <button className="btn" style={{ fontSize: 12, padding: '6px 12px', whiteSpace: 'nowrap' }}
                    onClick={() => navigator.clipboard.writeText(
                      `${import.meta.env.VITE_API_BASE || window.location.origin}/api/leaderboard/webhook/${selected.slug}`
                    ).then(() => setSaveMsg('Webhook URL copied!'))}>
                    Copy
                  </button>
                </div>
                <div style={{ fontSize: 11, opacity: .5, marginTop: 4 }}>
                  Add this to your GHL workflow → Actions → Webhook. Fires instantly when a contact is created/updated.
                </div>

                <hr className="divider" />
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>
                  GHL Custom Field IDs
                </div>
                <button
                  className="btn"
                  style={{ background: 'var(--purple)', color: '#fff', fontSize: 13, padding: '8px 14px', marginBottom: 8 }}
                  onClick={async () => {
                    if (!selected) return
                    try {
                      const res = await apiPost<{ok: boolean; discovered?: Record<string,string>; total_mapped?: number; error?: string}>(
                        `/api/leaderboard/discover-fields/${selected.slug}`, {}, token
                      )
                      if (res.ok) {
                        setSaveMsg(`Auto-discovered ${res.total_mapped ?? 0} field IDs — refresh to see them`)
                        setTimeout(() => window.location.reload(), 1500)
                      } else {
                        setError(res.error ?? 'Discovery failed')
                      }
                    } catch (e) { setError(e instanceof Error ? e.message : 'Discovery failed') }
                  }}
                >
                  Auto-Discover from GHL
                </button>
                <div style={{ fontSize: 11, opacity: .55, marginBottom: 8 }}>
                  Uses this agency's PIT token to query GHL and auto-map field IDs — no manual entry needed.
                  Only override below if auto-discovery maps the wrong field.
                </div>
                <div className="field">
                  <label className="fieldLabel">Agent Name Field ID</label>
                  <input className="input" style={{ width: '100%' }} value={editAgentFieldId}
                    onChange={(e) => setEditAgentFieldId(e.target.value)}
                    placeholder="e.g. vnvXADl6hMkqRrKIkyvw (from GHL custom fields)" />
                </div>
                <div className="field">
                  <label className="fieldLabel">Monthly Premium Field ID</label>
                  <input className="input" style={{ width: '100%' }} value={editPremiumFieldId}
                    onChange={(e) => setEditPremiumFieldId(e.target.value)}
                    placeholder="e.g. dKIrCNiUvpHV7o2IVNLQ" />
                </div>
                <div className="field">
                  <label className="fieldLabel">Plan Name Field ID</label>
                  <input className="input" style={{ width: '100%' }} value={editPlanFieldId}
                    onChange={(e) => setEditPlanFieldId(e.target.value)}
                    placeholder="e.g. QE4TstnSBeYlHBWmX5ML" />
                </div>

                {saveMsg && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--green)', fontWeight: 700 }}>{saveMsg}</div>
                )}

                <button
                  className="btn btnNavy"
                  style={{ justifyContent: 'center' }}
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true); setError(''); setSaveMsg('')
                    try {
                      const updated = await apiPatch<Agency>(
                        `/api/agencies/${selected.id}`,
                        {
                          name: editName, is_active: editActive, unl_prefix: editPrefix,
                          ghl_location_id: editGhlLocationId,
                          ghl_agent_field_id: editAgentFieldId,
                          ghl_premium_field_id: editPremiumFieldId,
                          ghl_plan_field_id: editPlanFieldId,
                        },
                        token,
                      )
                      setAgencies((prev) => prev.map((x) => (x.id === updated.id ? updated : x)).sort((a, b) => a.slug.localeCompare(b.slug)))
                      setSaveMsg('Saved!')
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed to save')
                    } finally { setSaving(false) }
                  }}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>

                <hr className="divider" />

                <div className="field">
                  <label className="fieldLabel">GHL PIT Token (write-only)</label>
                  <input className="input" style={{ width: '100%' }} type="password" value={editPitToken}
                    onChange={(e) => setEditPitToken(e.target.value)}
                    placeholder={selected.ghl_pit_token_set ? 'Enter new token to rotate' : 'pit-...'} />
                </div>
                <button
                  className="btn btnGold"
                  style={{ justifyContent: 'center' }}
                  disabled={!editPitToken.trim() || saving}
                  onClick={async () => {
                    setSaving(true); setError(''); setSaveMsg('')
                    try {
                      await apiPut<Agency>(`/api/agencies/${selected.id}/ghl-token`, { pit_token: editPitToken }, token)
                      setEditPitToken('')
                      setSaveMsg('PIT token saved!')
                      await refresh()
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed to set token')
                    } finally { setSaving(false) }
                  }}
                >
                  {saving ? 'Saving…' : 'Set PIT token'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
