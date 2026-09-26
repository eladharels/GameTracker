// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect, useRef, useCallback } from 'react'
import { FaBell, FaCheck, FaCheckCircle, FaChevronDown, FaCog, FaEnvelope, FaExclamationCircle, FaEye, FaEyeSlash, FaGamepad, FaKey, FaLock, FaSync, FaTelegram } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { readSession } from '../session'
import { safeExternalUrl } from '../safeUrl'

// ── Settings sub-components ────────────────────────────────────────────────
function SettingsSection({ icon, title, description, configured, children }) {
  const Icon = icon // hoisted to var scope so varsIgnorePattern (^[A-Z_]) covers JSX usage
  return (
    <div className="ent-section">
      <div className="ent-section-header">
        <div className="ent-section-title-row">
          <div className="ent-section-icon-wrap"><Icon /></div>
          <div className="ent-section-title-group">
            <h3 className="ent-section-title">{title}</h3>
            <p className="ent-section-desc">{description}</p>
          </div>
          {configured === true  && <span className="ent-status ent-status--on"><span className="ent-status-dot" />Configured</span>}
          {configured === false && <span className="ent-status ent-status--off"><span className="ent-status-dot" />Not configured</span>}
        </div>
      </div>
      {children}
    </div>
  )
}

function SettingsField({ label, hint, saved, wide, children }) {
  return (
    <div className={`ent-field${wide ? ' ent-field--wide' : ''}`}>
      <div className="ent-field-label-row">
        <label className="ent-field-label">{label}</label>
        {saved && <span className="ent-field-saved" title="Value saved on server">● saved</span>}
      </div>
      {children}
      {hint && <span className="ent-field-hint">{hint}</span>}
    </div>
  )
}

function SectionSaveBar({ sectionKey, saving, saveStatus, saveError, dirty, onSave, label }) {
  const status = saveStatus[sectionKey]
  const message = status === 'error' ? saveError?.[sectionKey] : null
  return (
    <div className="ent-save-bar">
      {/* The server's reason, not just "Failed". A 409 (settings.json unreadable) and
          a 400 (malformed section) both need an action the button cannot perform.
          Its OWN row: sharing one with the button squeezed it to ~120px on a phone,
          wrapped a real message to twelve lines, and let a long unbroken value paint
          over the button. And it sits ALONGSIDE the dirty hint rather than replacing
          it — the error survives until the next save attempt, so replacing it hid
          "Unsaved changes" for the whole editing session that follows a failure. */}
      {message && (
        <span className="ent-save-error" role="alert">
          <FaExclamationCircle aria-hidden="true" /> {message}
        </span>
      )}
      <span className={`ent-unsaved-hint${dirty ? ' visible' : ''}`}>
        <FaExclamationCircle aria-hidden="true" /> Unsaved changes
      </span>
      <button
        type="button"
        className={`ent-save-btn${dirty ? ' ent-save-btn--dirty' : ''}${status === 'saved' ? ' ent-save-btn--saved' : ''}${status === 'error' ? ' ent-save-btn--error' : ''}`}
        onClick={onSave}
        disabled={saving[sectionKey]}
      >
        {/* No "retry" verdict on failure: next to "restore the file on the server",
            it advertises the one action that cannot work. The red styling still says
            it did not save; the message next to it says what to do instead. */}
        {saving[sectionKey] ? <><FaSync className="ent-spin" /> Saving…</>
          : status === 'saved'  ? <><FaCheckCircle /> Saved</>
          : <>Save {label}</>}
      </button>
    </div>
  )
}

// ── DiagSelect — custom dark dropdown for the Diagnostics panel ────────────
function DiagSelect({ value, onChange, options, placeholder = 'Choose…' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const selected = options.find(o => o.value === value)

  return (
    <div className="diag-select" ref={ref}>
      <button
        type="button"
        className={`diag-select-btn${open ? ' open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {selected?.icon && <selected.icon className="diag-select-btn-icon" />}
        <span className="diag-select-btn-label">{selected?.label || placeholder}</span>
        {selected?.sub && <span className="diag-select-btn-sub">{selected.sub}</span>}
        <FaChevronDown className={`diag-select-arrow${open ? ' open' : ''}`} />
      </button>

      {open && (
        <div className="diag-select-dropdown">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`diag-select-option${value === opt.value ? ' active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.icon && <opt.icon className="diag-select-option-icon" />}
              <div className="diag-select-option-text">
                <span className="diag-select-option-label">{opt.label}</span>
                {opt.sub && <span className="diag-select-option-sub">{opt.sub}</span>}
              </div>
              {value === opt.value && <FaCheck className="diag-select-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Reusable API key input row (used in the API Keys settings tab)
function AkField({ fieldKey, label, hint, provider, meta, edit, setEdit, show, setShow }) {
  const editing = fieldKey in edit
  const visible = !!show[fieldKey]
  const sourceLabel = meta.source === 'settings' ? '● settings' : meta.source === 'env' ? '● env var' : '○ not set'
  const sourceColor = meta.source === 'settings' ? '#22c55e' : meta.source === 'env' ? '#f97316' : '#ef4444'
  return (
    <div className="ak-row">
      <div className="ak-row-header">
        <div>
          <div className="ak-label">{label}</div>
          {provider && <div className="ak-provider">{provider}</div>}
        </div>
        <span className="ak-source" style={{ color: sourceColor }}>{sourceLabel}</span>
      </div>
      <div className="ak-input-row">
        <div className="ak-input-wrap">
          <input
            type={visible ? 'text' : 'password'}
            className="settings-form input ak-input"
            placeholder={meta.set ? meta.masked : 'Not set — enter a value'}
            value={editing ? edit[fieldKey] : ''}
            onChange={e => setEdit(p => ({ ...p, [fieldKey]: e.target.value }))}
            autoComplete="new-password"
          />
          <button type="button" className="ak-toggle-btn" onClick={() => setShow(p => ({ ...p, [fieldKey]: !p[fieldKey] }))} title={visible ? 'Hide' : 'Show'}>
            {visible ? <FaEyeSlash /> : <FaEye />}
          </button>
        </div>
        <div className="ak-hint">{hint}</div>
      </div>
    </div>
  )
}

// ── Main SettingsPage ───────────────────────────────────────────────────────
export default function SettingsPage() {
  // Server-synced state
  const [serverSettings, setServerSettings] = useState({ smtp: {}, ntfy: {}, gotify: {}, ldap: {}, telegram: {} })
  const [smtp, setSmtp] = useState({})
  const [ntfy, setNtfy] = useState({})
  const [gotify, setGotify] = useState({})
  const [ldap, setLdap] = useState({})
  const [telegram, setTelegram] = useState({})
  const [loadingSettings, setLoadingSettings] = useState(true)
  // The server could not read settings.json. Every section then arrives EMPTY, which
  // looks exactly like an unconfigured server — so without this the admin would edit
  // a blank page and only discover the refusal on save.
  const [settingsUnreadable, setSettingsUnreadable] = useState(false)
  // Distinct from settingsUnreadable: that means the SERVER read settings.json and
  // could not parse it. This means we never heard back at all. Same consequence for
  // the UI — nothing shown can be trusted and nothing may be saved over it — but a
  // different sentence, because "restore the file on the server" is wrong advice for
  // a network failure.
  const [settingsLoadError, setSettingsLoadError] = useState(false)

  // API Keys state (admin-only)
  const [apiKeysMeta, setApiKeysMeta] = useState({})   // { key: { masked, set, source } }
  const [apiKeysEdit, setApiKeysEdit] = useState({})   // fields being edited (plain text)
  const [apiKeysShow, setApiKeysShow] = useState({})   // which fields are revealed
  const [apiKeysSaving, setApiKeysSaving] = useState(false)
  const [apiKeysSaveStatus, setApiKeysSaveStatus] = useState(null)
  const [saving, setSaving]       = useState({})
  const [saveStatus, setSaveStatus] = useState({})
  const [saveError, setSaveError] = useState({})   // per-section server message

  // Testing tab state (preserved)
  const [userGames, setUserGames]             = useState([])
  const [selectedGame, setSelectedGame]       = useState('')
  const [selectedService, setSelectedService] = useState('both')
  const [testLoading, setTestLoading]         = useState(false)
  const [testResult, setTestResult]           = useState(null)
  const [crackLoading, setCrackLoading]       = useState(false)
  const [crackInfo, setCrackInfo]             = useState(null)
  // Computed once; only http(s) may reach the Source link href (SEC-8).
  const crackSourceUrl = safeExternalUrl(crackInfo?.url)
  const [crackError, setCrackError]           = useState('')
  const [testError, setTestError]             = useState('')

  const token   = localStorage.getItem('token')
  // session.js is the one client-side JWT decode. The inline atob() here threw on
  // base64URL payloads and showed those admins the non-admin Settings page.
  const isAdmin = !!readSession(token)?.can_manage_users
  // Admins land on Email; non-admins only have the Diagnostics tab in Settings
  // (all notification config moved to My Account).
  const [activeTab, setActiveTab] = useState(() => (isAdmin ? 'email' : 'testing'))

  // ── Load from server. A callback, not just an effect, because a save that succeeds
  // while the unreadable banner is up means someone repaired the file on disk — and
  // every OTHER section is still holding the blank degraded read. Clearing the flag
  // alone would leave those blanks on screen with the explanation removed.
  const fetchSettings = useCallback(() => (
    api.get(`${API_BASE}/settings`)
      .then(res => {
        const s = res.data || {}
        setSettingsLoadError(false)
        setSettingsUnreadable(!!s.unreadable)
        setServerSettings(s)
        setSmtp(s.smtp       || {})
        setNtfy(s.ntfy       || {})
        setGotify(s.gotify   || {})
        setLdap(s.ldap       || {})
        setTelegram(s.telegram || {})
      })
      // There was no catch, and `.finally` below does NOT handle a rejection — it
      // re-throws. So a failed GET /settings produced an unhandled rejection AND left
      // every section at its blank initial value, which isConfigured() rendered as
      // "not configured" for SMTP, LDAP, ntfy, Gotify and Telegram. An admin saw their
      // whole server config as empty and could re-enter it over the top.
      //
      // The server-side degraded read (`s.unreadable`) was already handled carefully,
      // including refusing saves. A transport failure needed the same treatment: it is
      // the same "we do not know what is configured" state, reached differently.
      .catch(() => {
        setSettingsLoadError(true)
        setServerSettings({})
      })
  ), [])

  useEffect(() => {
    fetchSettings()
      .finally(() => setLoadingSettings(false))
  }, [fetchSettings])

  // Announce the degraded state once per transition, and drop a keyboard user at the
  // top of the panel where the explanation is.
  const unreadableRef = useRef(null)
  useEffect(() => { if (settingsUnreadable) unreadableRef.current?.focus() }, [settingsUnreadable])

  // ── Load API keys meta (admin only)
  useEffect(() => {
    if (!isAdmin) return
    api.get(`${API_BASE}/settings/apikeys`)
      .then(r => { setApiKeysMeta(r.data); setApiKeysEdit({}) })
      // A 401 is the api.js interceptor's (FE-15): it ends the session and reloads to the
      // login page, which says why. The "log out and log back in" banner this used to set
      // either never rendered or raced that reload.
      .catch(() => {})
  }, [])

  // ── Load user games for testing tab (available to all users)
  useEffect(() => {
    api.get(`${API_BASE}/user/me/games`)
      .then(r => setUserGames(r.data))
      .catch(() => {})
  }, [])

  // ── Helpers
  const isConfigured = data => Object.values(data || {}).some(v => v && String(v).trim())
  const isDirty = key => {
    const curr = key === 'smtp' ? smtp : key === 'ntfy' ? ntfy : key === 'gotify' ? gotify : key === 'telegram' ? telegram : ldap
    return JSON.stringify(curr) !== JSON.stringify(serverSettings[key] || {})
  }

  const saveSection = async (key) => {
    // Refuse outright when the load failed. The SERVER rejects saves while
    // settings.json is unreadable, which is what protects the degraded-read path — but
    // it cannot protect this one: as far as the server is concerned these are ordinary
    // valid writes. The fields are blank only because the GET never arrived, so saving
    // would persist those blanks over a working configuration.
    if (settingsLoadError) {
      setSaveError(p => ({ ...p, [key]: 'Settings could not be loaded, so saving would overwrite them with blanks. Reload first.' }))
      return
    }
    const data = key === 'smtp' ? smtp : key === 'ntfy' ? ntfy : key === 'gotify' ? gotify : key === 'telegram' ? telegram : ldap
    setSaving(p => ({ ...p, [key]: true }))
    setSaveStatus(p => ({ ...p, [key]: null }))
    setSaveError(p => ({ ...p, [key]: null }))
    try {
      await api.post(`${API_BASE}/settings`, { [key]: data })
      setServerSettings(p => ({ ...p, [key]: { ...data } }))
      // A save cannot succeed while the file is unreadable, so reaching here with the
      // banner up means it was repaired on disk. Refetch: the other sections are still
      // holding the blank degraded read.
      if (settingsUnreadable || settingsLoadError) fetchSettings()
      setSaveStatus(p => ({ ...p, [key]: 'saved' }))
      setTimeout(() => setSaveStatus(p => ({ ...p, [key]: null })), 3000)
    } catch (err) {
      const status = err.response?.status
      // The server's own message where it has one: a 409 says settings.json cannot be
      // read and must be restored on disk, a 400 says which section was malformed.
      // Neither is fixed by pressing the button again.
      //
      // No 401 branch: the response interceptor clears the token and navigates to
      // /login before any of this renders, and "log out and log back in" would be
      // wrong anyway — by then they already are logged out.
      setSaveError(p => ({ ...p, [key]:
        status === 403 ? 'Access denied — admin permission required.'
        : err.response
          ? (err.response.data?.error || `Save failed (HTTP ${status}). Check the server log.`)
          // No response at all: backend down, network gone, proxy refused. There is no
          // server log entry to check, so do not send them looking for one.
          : 'Could not reach the server — check that the backend is running.' }))
      if (status === 409) setSettingsUnreadable(true)
      setSaveStatus(p => ({ ...p, [key]: 'error' }))
    }
    setSaving(p => ({ ...p, [key]: false }))
  }

  const apiErrMsg = (err) => {
    const status = err.response?.status
    const body   = err.response?.data?.error || err.response?.data?.message || err.message || 'Unknown error'
    // Only reachable without a stored token (a sign-out in another tab) — the interceptor
    // handles every other 401 (FE-15). Same words as the other pages.
    if (status === 401) return 'Your session has ended. Please sign in again.'
    if (status === 403) return 'Access denied — admin permission required.'
    return body
  }

  const saveApiKeys = async () => {
    if (!Object.keys(apiKeysEdit).length) return
    setApiKeysSaving(true); setApiKeysSaveStatus(null)
    try {
      await api.post(`${API_BASE}/settings/apikeys`, apiKeysEdit)
      const r = await api.get(`${API_BASE}/settings/apikeys`)
      setApiKeysMeta(r.data); setApiKeysEdit({}); setApiKeysShow({})
      setApiKeysSaveStatus('saved')
      setTimeout(() => setApiKeysSaveStatus(null), 3000)
    } catch (err) {
      setApiKeysSaveStatus(apiErrMsg(err))
    } finally {
      setApiKeysSaving(false)
    }
  }

  const [igdbRefreshing, setIgdbRefreshing] = useState(false)
  const [igdbRefreshResult, setIgdbRefreshResult] = useState(null)
  const refreshIgdbToken = async () => {
    setIgdbRefreshing(true); setIgdbRefreshResult(null)
    try {
      const r = await api.post(`${API_BASE}/settings/apikeys/refresh-igdb-token`, {})
      const expiresInDays = r.data.expires_in ? Math.floor(r.data.expires_in / 86400) : null
      setIgdbRefreshResult({ ok: true, msg: `New token saved (${r.data.masked}). Expires in ~${expiresInDays ?? '?'} days.` })
      const meta = await api.get(`${API_BASE}/settings/apikeys`)
      setApiKeysMeta(meta.data)
    } catch (err) {
      setIgdbRefreshResult({ ok: false, msg: apiErrMsg(err) })
    } finally {
      setIgdbRefreshing(false)
    }
  }

  // ── Test handlers (preserved)
  const handleCrackTest = async () => {
    if (!selectedGame) return
    setCrackLoading(true); setCrackError(''); setCrackInfo(null)
    try {
      const game = userGames.find(g => g.game_id.toString() === selectedGame)
      if (!game) { setCrackError('Game not found'); return }
      const r = await api.post(`${API_BASE}/admin/crackrelease-status`, { gameName: game.game_name })
      setCrackInfo(r.data)
    } catch (err) { setCrackError(err.response?.data?.error || err.message || 'Failed') }
    finally { setCrackLoading(false) }
  }

  const handleTestNotification = async () => {
    if (!selectedGame) return
    setTestLoading(true); setTestError(''); setTestResult(null)
    try {
      const game = userGames.find(g => g.game_id.toString() === selectedGame)
      const r = await api.post(`${API_BASE}/admin/test-notification`, {
        service: selectedService, gameId: selectedGame,
        gameName: game.game_name, releaseDate: game.release_date,
        coverUrl: game.cover_url,
      })
      setTestResult(r.data)
    } catch (err) { setTestError(err.response?.data?.error || 'Test notification failed') }
    finally { setTestLoading(false) }
  }

  // ── Nav definition — adminOnly items are hidden from non-admin users
  const NAV = [
    { key: 'email',    label: 'Email',       sub: 'SMTP',         icon: FaEnvelope,    data: smtp,     adminOnly: true },
    // ntfy/gotify/telegram are server infrastructure (global default URL / bot token).
    // Regular users set their own notification server per-user in My Account, so these
    // are administrator-only here.
    { key: 'ntfy',     label: 'Push',        sub: 'NTFY',         icon: FaBell,        data: ntfy,     adminOnly: true },
    { key: 'gotify',   label: 'Gotify',      sub: 'Gotify Push',  icon: FaBell,        data: gotify,   adminOnly: true },
    { key: 'telegram', label: 'Telegram',    sub: 'Telegram Bot', icon: FaTelegram,    data: telegram, adminOnly: true },
    { key: 'ldap',     label: 'Directory',   sub: 'LDAP / AD',    icon: FaLock,        data: ldap,     adminOnly: true },
    { key: 'apikeys',  label: 'API Keys',    sub: 'Providers',    icon: FaKey,         data: null,     adminOnly: true },
    { key: 'testing',  label: 'Diagnostics', sub: 'Testing',      icon: FaCheckCircle, data: null },
  ]
  const visibleNAV = NAV.filter(s => !s.adminOnly || isAdmin)

  if (loadingSettings) return (
    <div className="ent-loading">
      <FaSync className="ent-spin" style={{ fontSize: '1.8rem', color: 'var(--color-accent)' }} />
      <span>Loading configuration…</span>
    </div>
  )

  return (
    <div className="ent-settings">

      {/* ── Left nav ── */}
      <nav className="ent-nav">
        <div className="ent-nav-header">
          <FaCog className="ent-nav-logo" />
          <span>Configuration</span>
        </div>

        {visibleNAV.map(s => {
          // 'unknown' when settings.json could not be read. Otherwise every section
          // arrives empty and every badge says "not configured" — five confident
          // wrong answers, next to a banner explaining that the blanks are not real.
          const configured = (settingsUnreadable || settingsLoadError) ? 'unknown'
            : (s.data !== null ? isConfigured(s.data) : null)
          const dirty      = s.data !== null ? isDirty(s.key)       : false
          return (
            <button
              key={s.key}
              className={`ent-nav-item${activeTab === s.key ? ' active' : ''}`}
              onClick={() => setActiveTab(s.key)}
            >
              <s.icon className="ent-nav-icon" />
              <div className="ent-nav-text">
                <span className="ent-nav-label">{s.label}</span>
                <span className="ent-nav-sub">{s.sub}</span>
              </div>
              <div className="ent-nav-badges">
                {dirty && <span className="ent-badge ent-badge--dirty">●</span>}
                {!dirty && configured === true  && <span className="ent-badge ent-badge--ok">✓</span>}
                {!dirty && configured === false && <span className="ent-badge ent-badge--off">—</span>}
                {!dirty && configured === 'unknown' && (
                  <span className="ent-badge ent-badge--unknown"
                        aria-label="Unknown — settings.json could not be read">?</span>
                )}
              </div>
            </button>
          )
        })}
      </nav>

      {/* ── Right panel ── */}
      <div className="ent-panel">

        {/* role="status", not "alert": this enters the DOM together with its whole
            container on first render, which screen readers announce unreliably, and
            on the 409 path it would be a second assertive interruption saying what
            the save-bar alert just said. Moving focus here announces it once and
            puts a keyboard user at the top of the panel. */}
        {settingsLoadError && (
          <div className="gt-alert gt-alert--danger gt-alert--page" role="alert">
            <FaExclamationCircle aria-hidden="true" />
            <div>
              <strong>Couldn&apos;t load settings — the server didn&apos;t answer.</strong>
              <br />The sections below are blank because of that, not because they are
              unconfigured. Saving is disabled so nothing is overwritten with blanks.
              <div>
                <button type="button" className="gt-alert-action" onClick={() => fetchSettings()}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {settingsUnreadable && (
          <div className="gt-alert gt-alert--danger gt-alert--page"
               ref={unreadableRef} tabIndex={-1} role="status">
            <FaExclamationCircle aria-hidden="true" />
            <div>
              <strong>settings.json could not be read — restore the file on the server, then reload.</strong>
              <br />The sections below are blank because of that, not because they are
              unconfigured. Saves are rejected until it is fixed, so nothing is overwritten
              with blanks. The parse error is in the server log.
              <div>
                <button type="button" className="gt-alert-action" onClick={() => window.location.reload()}>
                  Reload page
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Email */}
        {activeTab === 'email' && (
          <SettingsSection icon={FaEnvelope} title="Email Notifications" description="Configure SMTP to receive release reminders and status alerts by email." configured={isConfigured(smtp)}>
            <div className="ent-fields">
              <SettingsField label="SMTP Host"   saved={!!serverSettings.smtp?.host}>
                <input className="ent-input" value={smtp.host  || ''} onChange={e => setSmtp(p => ({ ...p, host:  e.target.value }))} placeholder="smtp.example.com" />
              </SettingsField>
              <SettingsField label="SMTP Port"   saved={!!serverSettings.smtp?.port}>
                <input className="ent-input" type="number" value={smtp.port  || ''} onChange={e => setSmtp(p => ({ ...p, port:  e.target.value }))} placeholder="587" />
              </SettingsField>
              <SettingsField label="Username"    saved={!!serverSettings.smtp?.user}>
                <input className="ent-input" value={smtp.user  || ''} onChange={e => setSmtp(p => ({ ...p, user:  e.target.value }))} placeholder="user@example.com" />
              </SettingsField>
              <SettingsField label="Password"    saved={!!serverSettings.smtp?.pass}>
                <input className="ent-input" type="password" value={smtp.pass  || ''} onChange={e => setSmtp(p => ({ ...p, pass:  e.target.value }))} placeholder="App password" />
              </SettingsField>
              <SettingsField label="From Address" saved={!!serverSettings.smtp?.from}>
                <input className="ent-input" value={smtp.from  || ''} onChange={e => setSmtp(p => ({ ...p, from:  e.target.value }))} placeholder="noreply@example.com" />
              </SettingsField>
              <SettingsField label="Recipient Address" saved={!!serverSettings.smtp?.to} hint="Address that receives notification emails">
                <input className="ent-input" value={smtp.to    || ''} onChange={e => setSmtp(p => ({ ...p, to:    e.target.value }))} placeholder="you@example.com" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="smtp" saving={saving} saveStatus={saveStatus} saveError={saveError} dirty={isDirty('smtp')} onSave={() => saveSection('smtp')} label="Email Settings" />
          </SettingsSection>
        )}

        {/* NTFY */}
        {activeTab === 'ntfy' && (
          <SettingsSection icon={FaBell} title="Push Notifications (NTFY)" description="Set the NTFY server URL. Each user subscribes using their own topic configured in My Account." configured={isConfigured(ntfy)}>
            <div className="ent-fields">
              <SettingsField label="NTFY Server URL" saved={!!serverSettings.ntfy?.url} wide hint="Self-hosted or ntfy.sh">
                <input className="ent-input" value={ntfy.url || ''} onChange={e => setNtfy(p => ({ ...p, url: e.target.value }))} placeholder="https://ntfy.sh" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="ntfy" saving={saving} saveStatus={saveStatus} saveError={saveError} dirty={isDirty('ntfy')} onSave={() => saveSection('ntfy')} label="NTFY Settings" />
          </SettingsSection>
        )}

        {/* Gotify */}
        {activeTab === 'gotify' && (
          <SettingsSection icon={FaBell} title="Push Notifications (Gotify)" description="Set the Gotify server URL. Each user provides their own app token configured in My Account." configured={isConfigured(gotify)}>
            <div className="ent-fields">
              <SettingsField label="Gotify Server URL" saved={!!serverSettings.gotify?.url} wide hint="Your self-hosted Gotify server">
                <input className="ent-input" value={gotify.url || ''} onChange={e => setGotify(p => ({ ...p, url: e.target.value }))} placeholder="https://gotify.example.com" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="gotify" saving={saving} saveStatus={saveStatus} saveError={saveError} dirty={isDirty('gotify')} onSave={() => saveSection('gotify')} label="Gotify Settings" />
          </SettingsSection>
        )}

        {/* Telegram */}
        {activeTab === 'telegram' && (
          <SettingsSection icon={FaTelegram} title="Telegram Notifications" description="Configure a Telegram bot to send notifications. Each user sets their own Chat ID in My Account." configured={isConfigured(telegram)}>
            <div className="ent-fields">
              <SettingsField label="Bot Token" saved={!!serverSettings.telegram?.bot_token} wide hint="Create a bot via @BotFather and paste the token here">
                <input className="ent-input" type="password" value={telegram.bot_token || ''} onChange={e => setTelegram(p => ({ ...p, bot_token: e.target.value }))} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="telegram" saving={saving} saveStatus={saveStatus} saveError={saveError} dirty={isDirty('telegram')} onSave={() => saveSection('telegram')} label="Telegram Settings" />
          </SettingsSection>
        )}

        {/* LDAP */}
        {activeTab === 'ldap' && (
          <SettingsSection icon={FaLock} title="Directory Services" description="Connect to Active Directory or FreeIPA for centralized user authentication." configured={isConfigured(ldap)}>
            <div className="ent-fields">
              <SettingsField label="LDAP Server URL"   saved={!!serverSettings.ldap?.url}           wide hint="e.g. ldap://dc01.corp.example.com">
                <input className="ent-input" value={ldap.url          || ''} onChange={e => setLdap(p => ({ ...p, url:           e.target.value }))} placeholder="ldap://dc01.example.com" />
              </SettingsField>
              <SettingsField label="Base DN"            saved={!!serverSettings.ldap?.base}          wide hint="Root of the directory tree to search">
                <input className="ent-input" value={ldap.base         || ''} onChange={e => setLdap(p => ({ ...p, base:          e.target.value }))} placeholder="dc=example,dc=com" />
              </SettingsField>
              <SettingsField label="User DN Pattern"    saved={!!serverSettings.ldap?.userDn}        wide hint="Use {username} and {baseDN} as placeholders">
                <input className="ent-input" value={ldap.userDn       || ''} onChange={e => setLdap(p => ({ ...p, userDn:        e.target.value }))} placeholder="cn={username},ou=Users,{baseDN}" />
              </SettingsField>
              <SettingsField label="Bind DN"            saved={!!serverSettings.ldap?.bindDn}        wide hint="Service account for directory lookups">
                <input className="ent-input" value={ldap.bindDn       || ''} onChange={e => setLdap(p => ({ ...p, bindDn:        e.target.value }))} placeholder="cn=readonly,dc=example,dc=com" />
              </SettingsField>
              <SettingsField label="Bind Password"      saved={!!serverSettings.ldap?.bindPass}>
                <input className="ent-input" type="password" value={ldap.bindPass     || ''} onChange={e => setLdap(p => ({ ...p, bindPass:      e.target.value }))} placeholder="Service account password" />
              </SettingsField>
              <SettingsField label="Required Group"     saved={!!serverSettings.ldap?.requiredGroup} hint="Optional — only members of this group can sign in">
                <input className="ent-input" value={ldap.requiredGroup || ''} onChange={e => setLdap(p => ({ ...p, requiredGroup: e.target.value }))} placeholder="GameTrackerUsers" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="ldap" saving={saving} saveStatus={saveStatus} saveError={saveError} dirty={isDirty('ldap')} onSave={() => saveSection('ldap')} label="LDAP Settings" />
          </SettingsSection>
        )}

        {/* API Keys */}
        {activeTab === 'apikeys' && (
          <SettingsSection icon={FaKey} title="API Provider Keys" description="Configure API credentials for game data providers. Settings here override environment variables. Leave a field blank to keep the existing value.">

            {/* IGDB / Twitch section */}
            <div className="ak-section-header">IGDB — via Twitch Developer</div>
            {[
              { key: 'igdb_client_id',     label: 'Client ID',      hint: 'From dev.twitch.tv → Your Application → Client ID' },
              { key: 'igdb_client_secret', label: 'Client Secret',  hint: 'From dev.twitch.tv → Your Application → New Secret' },
              { key: 'igdb_bearer_token',  label: 'Bearer Token',   hint: 'access_token from Twitch OAuth — use Refresh below instead of pasting manually' },
            ].map(({ key, label, hint }) => <AkField key={key} fieldKey={key} label={label} hint={hint} provider="igdb.com" meta={apiKeysMeta[key] || {}} edit={apiKeysEdit} setEdit={setApiKeysEdit} show={apiKeysShow} setShow={setApiKeysShow} />)}

            {/* IGDB auto-refresh button */}
            <div className="ak-refresh-box">
              <div className="ak-refresh-desc">
                <strong>Auto-refresh Bearer Token</strong>
                <span>Twitch tokens expire every ~60 days. Save your Client ID &amp; Secret above first, then click Refresh — the server calls Twitch and saves the new token automatically.</span>
              </div>
              <button className="ak-refresh-btn" onClick={refreshIgdbToken} disabled={igdbRefreshing}>
                <FaSync className={igdbRefreshing ? 'spin' : ''} />
                {igdbRefreshing ? 'Refreshing…' : 'Refresh IGDB Token'}
              </button>
              {igdbRefreshResult && (
                <div className={`ak-refresh-result${igdbRefreshResult.ok ? '' : ' ak-refresh-error'}`}>
                  {igdbRefreshResult.ok ? <FaCheckCircle /> : <FaExclamationCircle />}
                  {igdbRefreshResult.msg}
                </div>
              )}
            </div>

            {/* Other providers */}
            <div className="ak-section-header" style={{ marginTop: '1.5rem' }}>Other Providers</div>
            {[
              { key: 'rawg_api_key',       label: 'RAWG API Key',       hint: 'rawg.io/apidocs — free registration required',    provider: 'rawg.io' },
              { key: 'thegamesdb_api_key', label: 'TheGamesDB API Key', hint: 'forums.thegamesdb.net — optional third source',   provider: 'thegamesdb.net' },
            ].map(({ key, label, hint, provider }) => <AkField key={key} fieldKey={key} label={label} hint={hint} provider={provider} meta={apiKeysMeta[key] || {}} edit={apiKeysEdit} setEdit={setApiKeysEdit} show={apiKeysShow} setShow={setApiKeysShow} />)}

            <div className="ent-actions">
              {Object.keys(apiKeysEdit).some(k => apiKeysEdit[k].trim()) ? (
                <button className="ent-save-btn" onClick={saveApiKeys} disabled={apiKeysSaving}>
                  {apiKeysSaving ? <><FaSync className="ent-spin" /> Saving…</> : <><FaCheckCircle /> Save API Keys</>}
                </button>
              ) : (
                <span className="ak-no-changes">Edit a field above to save</span>
              )}
              {apiKeysSaveStatus === 'saved' && <span className="ent-saved-msg"><FaCheckCircle /> Saved</span>}
              {apiKeysSaveStatus && apiKeysSaveStatus !== 'saved' && <span className="ent-test-error"><FaExclamationCircle /> {apiKeysSaveStatus}</span>}
            </div>
          </SettingsSection>
        )}

        {/* Diagnostics */}
        {activeTab === 'testing' && (
          <SettingsSection icon={FaCheckCircle} title="Diagnostics & Testing" description="Verify your notification pipeline by sending a test to your configured channels." configured={null}>
            <div className="ent-fields">
              <SettingsField label="Notification Service">
                <DiagSelect
                  value={selectedService}
                  onChange={setSelectedService}
                  options={[
                    { value: 'both',       label: 'All Services',      sub: 'Email · NTFY · Gotify · Telegram', icon: FaBell },
                    { value: 'email',      label: 'Email only',        sub: 'SMTP',                             icon: FaEnvelope },
                    { value: 'ntfy',       label: 'NTFY only',         sub: 'Push notification',                icon: FaBell },
                    { value: 'gotify',     label: 'Gotify only',       sub: 'Self-hosted push',                 icon: FaBell },
                    { value: 'telegram',   label: 'Telegram only',     sub: 'Telegram Bot',                     icon: FaTelegram },
                    ...(isAdmin ? [{ value: 'crackwatch', label: 'CrackRelease only', sub: 'Crack status lookup', icon: FaCheckCircle }] : []),
                  ]}
                />
              </SettingsField>
              <SettingsField label="Game" hint={userGames.length ? `${userGames.length} games in library` : 'Loading…'}>
                <DiagSelect
                  value={selectedGame}
                  onChange={setSelectedGame}
                  placeholder="Choose a game…"
                  options={userGames.map(g => ({
                    value: g.game_id.toString(),
                    label: g.game_name,
                    sub: g.release_date ? new Date(g.release_date).toLocaleDateString() : 'no date',
                    icon: FaGamepad,
                  }))}
                />
              </SettingsField>
            </div>

            <div className="ent-test-actions">
              <button
                type="button"
                className="ent-test-btn"
                disabled={(selectedService === 'crackwatch' ? crackLoading : testLoading) || !selectedGame}
                onClick={selectedService === 'crackwatch' ? handleCrackTest : handleTestNotification}
              >
                {(selectedService === 'crackwatch' ? crackLoading : testLoading)
                  ? <><FaSync className="ent-spin" /> Running…</>
                  : selectedService === 'crackwatch'
                    ? 'Check CrackRelease Status'
                    : 'Send Test Notification'}
              </button>
              {testError && <span className="ent-test-error"><FaExclamationCircle /> {testError}</span>}
            </div>

            {/* CrackRelease result */}
            {crackInfo && (
              <div className="ent-result-card">
                <div className="ent-result-row">
                  <span className="ent-result-label">Status</span>
                  <span className={`ent-crack-status ent-crack-status--${crackInfo.status || 'unknown'}`}>
                    {(crackInfo.status || 'unknown').toUpperCase()}
                  </span>
                </div>
                {crackSourceUrl && (
                  <div className="ent-result-row">
                    <span className="ent-result-label">Source</span>
                    {/* safeExternalUrl: only http(s) reaches an href (SEC-8) */}
                    <a href={crackSourceUrl} target="_blank" rel="noopener noreferrer" className="ent-result-link">CrackRelease ↗</a>
                  </div>
                )}
              </div>
            )}
            {crackError && <div className="ent-test-error" style={{marginTop:'1rem'}}><FaExclamationCircle /> {crackError}</div>}

            {/* Notification test result */}
            {testResult && (
              <div className="ent-result-card">
                <div className="ent-result-row">
                  <span className="ent-result-label">Game</span>
                  <span>{testResult.gameInfo?.name}</span>
                </div>
                <div className="ent-result-row">
                  <span className="ent-result-label">Release</span>
                  <span>{testResult.gameInfo?.releaseText}</span>
                </div>
                <div className="ent-result-divider" />
                <div className="ent-result-row">
                  <span className="ent-result-label">Email</span>
                  <span className={`ent-service-status ent-service-status--${testResult.results?.email?.sent ? 'ok' : 'fail'}`}>
                    {testResult.results?.email?.sent ? '✓ Sent' : `✗ ${testResult.results?.email?.error || 'Failed'}`}
                  </span>
                </div>
                <div className="ent-result-row">
                  <span className="ent-result-label">NTFY</span>
                  <span className={`ent-service-status ent-service-status--${testResult.results?.ntfy?.sent ? 'ok' : 'fail'}`}>
                    {testResult.results?.ntfy?.sent ? '✓ Sent' : `✗ ${testResult.results?.ntfy?.error || 'Failed'}`}
                  </span>
                </div>
                <div className="ent-result-row">
                  <span className="ent-result-label">Gotify</span>
                  <span className={`ent-service-status ent-service-status--${testResult.results?.gotify?.sent ? 'ok' : 'fail'}`}>
                    {testResult.results?.gotify?.sent ? '✓ Sent' : `✗ ${testResult.results?.gotify?.error || 'Failed'}`}
                  </span>
                </div>
                <div className="ent-result-row">
                  <span className="ent-result-label">Telegram</span>
                  <span className={`ent-service-status ent-service-status--${testResult.results?.telegram?.sent ? 'ok' : 'fail'}`}>
                    {testResult.results?.telegram?.sent ? '✓ Sent' : `✗ ${testResult.results?.telegram?.error || 'Failed'}`}
                  </span>
                </div>
              </div>
            )}
          </SettingsSection>
        )}
      </div>
    </div>
  )
}
