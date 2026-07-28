import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { FaKey, FaSync, FaTrash, FaCheckCircle, FaExclamationCircle, FaCopy, FaPlus } from 'react-icons/fa'

// Personal access tokens, managed from My Account.
//
// The API this page drives is /api/user/me/tokens — session-authenticated, because
// /api/v2 takes tokens only and the endpoint that mints your FIRST token cannot itself
// require one. See index.js.
//
// The plaintext is returned exactly once, at creation, and is not recoverable
// afterwards: the server stores only a SHA-256 hash. That single fact drives most of
// the design below — the reveal is a deliberate, dismissible step rather than a toast,
// because a user who misses it has lost the token and has to mint another.

const API_BASE = '/api'

const SCOPE_COPY = {
  library: {
    label: 'Library',
    desc: 'Read and change your own games, backlog, shares and notification settings.',
  },
  admin: {
    label: 'Admin',
    desc: 'Everything above, plus user management, server settings and instance-wide jobs.',
  },
}

// Mirrors the server's cap. Shown as a hint, never relied on — the service validates.
const MAX_NAME = 60

export default function ApiTokensSection({ canManageUsers }) {
  const [tokens, setTokens] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState(['library'])
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')

  // The one-time reveal. Held in component state only — never written to storage.
  const [minted, setMinted] = useState(null)
  const [copied, setCopied] = useState(false)

  const [revoking, setRevoking] = useState(null)

  const authH = useCallback(
    () => ({ headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }),
    [],
  )

  const load = useCallback(async () => {
    setListError('')
    try {
      const res = await axios.get(`${API_BASE}/user/me/tokens`, authH())
      setTokens(Array.isArray(res.data?.tokens) ? res.data.tokens : [])
    } catch (err) {
      setListError(err.response?.data?.error || 'Could not load your tokens.')
    } finally {
      setLoading(false)
    }
  }, [authH])

  useEffect(() => { load() }, [load])

  const toggleScope = (scope) => {
    setScopes((prev) => {
      if (prev.includes(scope)) {
        // Never let the set empty out — the server refuses it, and a disabled Create
        // button with no explanation is worse than not allowing the last one off.
        return prev.length === 1 ? prev : prev.filter((s) => s !== scope)
      }
      return [...prev, scope]
    })
  }

  const resetForm = () => {
    setName(''); setScopes(['library']); setPassword(''); setExpiresAt('')
    setFormError(''); setShowForm(false)
  }

  const create = async (e) => {
    e.preventDefault()
    setCreating(true)
    setFormError('')
    try {
      const res = await axios.post(`${API_BASE}/user/me/tokens`, {
        name: name.trim(),
        scopes,
        password,
        // The server takes an ISO instant or null; the date input gives YYYY-MM-DD.
        // End of the chosen day, so a token dated "today" is valid for the rest of it
        // rather than already expired.
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
      }, authH())
      setMinted(res.data)
      setCopied(false)
      resetForm()
      load()
    } catch (err) {
      setFormError(err.response?.data?.error || 'Could not create the token.')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (tokenId, tokenName) => {
    // Irreversible and immediate — anything using this token stops working on the next
    // request. Worth a confirm; there is no undo and no way to re-issue the same value.
    if (!window.confirm(`Revoke "${tokenName}"?\n\nAnything using it stops working immediately. This cannot be undone.`)) return
    setRevoking(tokenId)
    try {
      await axios.delete(`${API_BASE}/user/me/tokens/${tokenId}`, authH())
      load()
    } catch (err) {
      setListError(err.response?.data?.error || 'Could not revoke that token.')
    } finally {
      setRevoking(null)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(minted.token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard access is denied over plain HTTP and in some browsers. The token is
      // already on screen and selectable, so this is a convenience failing, not the
      // feature failing — say nothing rather than raising an alarm.
    }
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' }) : null)

  const expired = (iso) => !!iso && new Date(iso).getTime() <= Date.now()

  return (
    <div className="ent-section" style={{ marginTop: '2rem' }}>
      <div className="ent-section-header">
        <FaKey className="ent-section-icon" />
        <div>
          <div className="ent-section-title">API Tokens</div>
          <div className="ent-section-desc">
            For scripts, tools and the API Reference page. A token acts as you — treat it
            like a password.
          </div>
        </div>
      </div>

      {/* The one-time reveal. Placed above the list so it cannot be scrolled past. */}
      {minted && (
        <div className="token-reveal" role="alert">
          <div className="token-reveal-head">
            <FaCheckCircle className="token-reveal-icon" />
            <div>
              <strong>Copy this now — it will not be shown again.</strong>
              <div className="token-reveal-sub">
                The server keeps only a hash of it, so it cannot be recovered or resent.
              </div>
            </div>
          </div>
          <div className="token-reveal-value">
            <code>{minted.token}</code>
            <button type="button" className="ent-save-btn token-copy-btn" onClick={copy}>
              {copied ? <><FaCheckCircle /> Copied</> : <><FaCopy /> Copy</>}
            </button>
          </div>
          <button type="button" className="token-reveal-dismiss" onClick={() => setMinted(null)}>
            I&apos;ve saved it — hide this
          </button>
        </div>
      )}

      {listError && <div className="ent-test-error"><FaExclamationCircle /> {listError}</div>}

      {loading ? (
        <div className="token-empty">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="token-empty">
          No tokens yet. Create one to use the API from a script, or to try endpoints on the
          API&nbsp;Reference page.
        </div>
      ) : (
        <ul className="token-list">
          {tokens.map((t) => (
            <li key={t.id} className={`token-row${expired(t.expires_at) ? ' token-row--expired' : ''}`}>
              <div className="token-row-main">
                <div className="token-row-name">
                  {t.name}
                  {/* The last four characters — the only part kept — so an operator can
                      match a token in a config file against the row they are revoking. */}
                  <span className="token-row-hint">…{t.hint}</span>
                  {expired(t.expires_at) && <span className="token-badge token-badge--expired">Expired</span>}
                </div>
                <div className="token-row-meta">
                  {t.scopes.map((s) => (
                    <span key={s} className={`token-badge token-badge--${s}`}>{SCOPE_COPY[s]?.label || s}</span>
                  ))}
                  <span>Created {fmt(t.created_at)}</span>
                  {/* "Never used" is the actionable state: a token nobody has used is one
                      that can be revoked without breaking anything. */}
                  <span>{t.last_used_at ? `Last used ${fmt(t.last_used_at)}` : 'Never used'}</span>
                  {t.expires_at && <span>{expired(t.expires_at) ? 'Expired' : 'Expires'} {fmt(t.expires_at)}</span>}
                </div>
              </div>
              <button
                type="button"
                className="token-revoke-btn"
                onClick={() => revoke(t.id, t.name)}
                disabled={revoking === t.id}
                aria-label={`Revoke ${t.name}`}
              >
                {revoking === t.id ? <FaSync className="ent-spin" /> : <FaTrash />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!showForm ? (
        <div className="ent-save-bar">
          <button type="button" className="ent-save-btn" onClick={() => setShowForm(true)}>
            <FaPlus /> New Token
          </button>
        </div>
      ) : (
        <form className="token-form" onSubmit={create}>
          <label className="token-field">
            <span>Name</span>
            <input
              type="text" value={name} maxLength={MAX_NAME} required autoFocus
              placeholder="What will use this token?"
              onChange={(e) => setName(e.target.value)}
            />
            <small>So you can recognise it later — the token itself is never shown again.</small>
          </label>

          <fieldset className="token-field token-scopes">
            <legend>Scope</legend>
            {Object.entries(SCOPE_COPY).map(([key, copyText]) => {
              // Admin is offered only to accounts that hold it. The server enforces
              // this too — it refuses to mint a scope the account does not have — so
              // hiding it here is about not offering a button that cannot work.
              if (key === 'admin' && !canManageUsers) return null
              const checked = scopes.includes(key)
              return (
                <label key={key} className={`token-scope${checked ? ' token-scope--active' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleScope(key)} />
                  <span>
                    <strong>{copyText.label}</strong>
                    <small>{copyText.desc}</small>
                  </span>
                </label>
              )
            })}
          </fieldset>

          <label className="token-field">
            <span>Expires <em>(optional)</em></span>
            <input
              type="date" value={expiresAt}
              min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <small>Leave empty for a token that never expires.</small>
          </label>

          <label className="token-field">
            <span>Confirm your password</span>
            <input
              type="password" value={password} required autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <small>
              Asked again because a token outlives this browser session. If you sign in
              through a directory, tokens must be created on the server instead.
            </small>
          </label>

          {formError && <div className="ent-test-error"><FaExclamationCircle /> {formError}</div>}

          <div className="ent-save-bar">
            <button type="submit" className="ent-save-btn" disabled={creating || !name.trim() || !password}>
              {creating ? <><FaSync className="ent-spin" /> Creating…</> : 'Create Token'}
            </button>
            <button type="button" className="token-cancel-btn" onClick={resetForm} disabled={creating}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
