// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect } from 'react'
import { FaBell, FaCheckCircle, FaExclamationCircle, FaRegCalendarAlt, FaSync, FaUser } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import ApiTokensSection from '../ApiTokensSection'

// ── AccountPage (all users) ─────────────────────────────────────────────────
const NOTIF_DAY_OPTIONS = [
  { days: 0,  label: 'On release day' },
  { days: 3,  label: '3 days before' },
  { days: 7,  label: '7 days before' },
  { days: 14, label: '14 days before' },
  { days: 30, label: '30 days before' },
  { days: 60, label: '60 days before' },
]

export default function AccountPage({ user }) {

  const [profile, setProfile] = useState({ email: '', ntfy_url: '', ntfy_topic: '', gotify_url: '', gotify_token: '', telegram_chat_id: '', notification_days: [0, 7, 30] })
  const [saved, setSaved] = useState({})   // { channels: true/null, schedule: true/null }
  const [saving, setSaving] = useState({})
  const [error, setError] = useState({})
  const [loading, setLoading] = useState(true)
  // `.catch(() => {})` swallowed the failure and left every field at its blank initial
  // value. The form then rendered as though the user had configured nothing, and
  // saveSection would PUT those blanks — a failed READ one click away from destroying
  // the real settings.
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    api.get(`${API_BASE}/user/me`)
      .then(res => setProfile({
        email:             res.data.email || '',
        ntfy_url:          res.data.ntfy_url || '',
        ntfy_topic:        res.data.ntfy_topic || '',
        gotify_url:        res.data.gotify_url || '',
        gotify_token:      res.data.gotify_token || '',
        telegram_chat_id:  res.data.telegram_chat_id || '',
        notification_days: Array.isArray(res.data.notification_days) ? res.data.notification_days : [0, 7, 30],
      }))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
  }, [])

  const saveSection = async (section, body) => {
    // Refuse while the load failed: the fields are blank because the GET never
    // arrived, not because the user cleared them, and the server has no way to tell
    // the difference.
    if (loadError) {
      setError(p => ({ ...p, [section]: 'Your settings could not be loaded, so saving would overwrite them with blanks. Reload first.' }))
      return
    }
    setSaving(p => ({ ...p, [section]: true }))
    setError(p => ({ ...p, [section]: null }))
    setSaved(p => ({ ...p, [section]: null }))
    try {
      await api.put(`${API_BASE}/user/me/settings`, body)
      setSaved(p => ({ ...p, [section]: true }))
      setTimeout(() => setSaved(p => ({ ...p, [section]: null })), 3000)
    } catch (err) {
      setError(p => ({ ...p, [section]: err.response?.data?.error || 'Save failed' }))
    } finally {
      setSaving(p => ({ ...p, [section]: false }))
    }
  }

  const toggleDay = (day) => {
    setProfile(p => {
      const days = p.notification_days.includes(day)
        ? p.notification_days.filter(d => d !== day)
        : [...p.notification_days, day]
      return { ...p, notification_days: days }
    })
  }

  if (loading) return <div className="ent-settings"><div className="ent-loading">Loading…</div></div>
  if (loadError) return (
    <div className="ent-settings">
      <div className="gt-alert gt-alert--danger gt-alert--page" role="alert">
        <FaExclamationCircle aria-hidden="true" />
        <div>
          <strong>Couldn&apos;t load your account settings.</strong>
          <br />The form is hidden rather than shown blank, because blank fields here
          are one click from overwriting what you actually have configured.
          <div>
            <button type="button" className="gt-alert-action" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className="ent-settings">
      <nav className="ent-nav">
        <div className="ent-nav-header">Account</div>
        <button className="ent-nav-item ent-nav-item--active">
          <FaUser className="ent-nav-icon" />
          <span>My Profile</span>
        </button>
      </nav>

      <div className="ent-panel">
        {/* Notification Channels */}
        <div className="ent-section">
          <div className="ent-section-header">
            <FaBell className="ent-section-icon" />
            <div>
              <div className="ent-section-title">Notification Channels</div>
              <div className="ent-section-desc">Your personal push and email addresses for game notifications.</div>
            </div>
          </div>
          <div className="ent-fields">
            <div className="ent-field ent-field--wide">
              <label className="ent-label">Email Address</label>
              <input className="ent-input" type="email" value={profile.email} onChange={e => setProfile(p => ({ ...p, email: e.target.value }))} placeholder="you@example.com" />
            </div>
            <div className="ent-field">
              <label className="ent-label">NTFY Server URL</label>
              <input className="ent-input" type="url" inputMode="url" value={profile.ntfy_url} onChange={e => setProfile(p => ({ ...p, ntfy_url: e.target.value }))} placeholder="https://ntfy.sh" />
            </div>
            <div className="ent-field">
              <label className="ent-label">NTFY Topic</label>
              <input className="ent-input" value={profile.ntfy_topic} onChange={e => setProfile(p => ({ ...p, ntfy_topic: e.target.value }))} placeholder="my-gametracker-alerts" />
            </div>
            <div className="ent-field">
              <label className="ent-label">Gotify Server URL</label>
              <input className="ent-input" type="url" inputMode="url" value={profile.gotify_url} onChange={e => setProfile(p => ({ ...p, gotify_url: e.target.value }))} placeholder="https://gotify.example.com" />
            </div>
            <div className="ent-field">
              <label className="ent-label">Gotify Token</label>
              <input className="ent-input" value={profile.gotify_token} onChange={e => setProfile(p => ({ ...p, gotify_token: e.target.value }))} placeholder="AbCdEfGhIjKlMn" />
            </div>
            <div className="ent-field">
              <label className="ent-label">Telegram Chat ID</label>
              <input className="ent-input" value={profile.telegram_chat_id} onChange={e => setProfile(p => ({ ...p, telegram_chat_id: e.target.value }))} placeholder="123456789" />
            </div>
          </div>
          <div className="ent-save-bar">
            <button
              className="ent-save-btn"
              disabled={!!saving.channels}
              onClick={() => saveSection('channels', { email: profile.email, ntfy_url: profile.ntfy_url, ntfy_topic: profile.ntfy_topic, gotify_url: profile.gotify_url, gotify_token: profile.gotify_token, telegram_chat_id: profile.telegram_chat_id })}
            >
              {saving.channels ? <><FaSync className="ent-spin" /> Saving…</> : 'Save Channels'}
            </button>
            {saved.channels && <span className="ent-saved-msg"><FaCheckCircle /> Saved</span>}
            {error.channels && <span className="ent-test-error"><FaExclamationCircle /> {error.channels}</span>}
          </div>
        </div>

        {/* Notification Schedule */}
        <div className="ent-section" style={{ marginTop: '2rem' }}>
          <div className="ent-section-header">
            <FaRegCalendarAlt className="ent-section-icon" />
            <div>
              <div className="ent-section-title">Notification Schedule</div>
              <div className="ent-section-desc">Choose when to receive release reminders. Select at least one.</div>
            </div>
          </div>
          <div className="account-notif-grid">
            {NOTIF_DAY_OPTIONS.map(({ days, label }) => {
              const checked = profile.notification_days.includes(days)
              return (
                <label key={days} className={`account-notif-option${checked ? ' account-notif-option--active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDay(days)}
                    disabled={checked && profile.notification_days.length === 1}
                  />
                  <span className="account-notif-label">{label}</span>
                </label>
              )
            })}
          </div>
          <div className="ent-save-bar">
            <button
              className="ent-save-btn"
              disabled={!!saving.schedule || profile.notification_days.length === 0}
              onClick={() => saveSection('schedule', { notification_days: [...profile.notification_days].sort((a, b) => b - a) })}
            >
              {saving.schedule ? <><FaSync className="ent-spin" /> Saving…</> : 'Save Schedule'}
            </button>
            {saved.schedule && <span className="ent-saved-msg"><FaCheckCircle /> Saved</span>}
            {error.schedule && <span className="ent-test-error"><FaExclamationCircle /> {error.schedule}</span>}
          </div>
        </div>

        <ApiTokensSection canManageUsers={!!user?.can_manage_users} />
      </div>
    </div>
  )
}
