// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect } from 'react'
import { FaCheckCircle, FaExclamationCircle, FaMinusCircle, FaSpinner, FaSync, FaTimesCircle } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { getSession } from '../session'

// ── SystemStatusPage ────────────────────────────────────────────────────────
export default function SystemStatusPage() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const SERVICE_META = {
    database:   { label: 'Database',    desc: 'Local SQLite database',                website: null,                     auth: 'None — local file' },
    igdb:       { label: 'IGDB',        desc: 'Primary game search & metadata',        website: 'api.igdb.com',           auth: 'Client-ID + Bearer token (Twitch OAuth)' },
    rawg:       { label: 'RAWG',        desc: 'Secondary game search & metadata',      website: 'api.rawg.io',            auth: 'API key' },
    thegamesdb: { label: 'TheGamesDB',  desc: 'Tertiary game source & box art',        website: 'api.thegamesdb.net',     auth: 'API key (optional)' },
    steam:      { label: 'Steam Store', desc: 'Game pricing by region',                website: 'store.steampowered.com', auth: 'None — public API' },
    crackwatch: { label: 'CrackWatch',  desc: 'DRM/crack status (daily cached)',       website: 'api.crackwatch.com',     auth: 'None — public API' },
  }

  const HTTP_STATUS_LABELS = {
    400: 'Bad Request', 401: 'Unauthorized — check token/key', 403: 'Forbidden — insufficient permissions',
    404: 'Not Found', 429: 'Rate Limited — too many requests', 500: 'Server Error', 503: 'Service Unavailable',
  }

  const timeAgo = (iso) => {
    if (!iso) return null
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1)   return 'just now'
    if (m < 60)  return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24)  return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30)  return `${d}d ago`
    return new Date(iso).toLocaleDateString()
  }

  const fetchStatus = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get(`${API_BASE}/system-status`)
      setStatus(res.data)
    } catch (err) {
      const s = err.response?.status
      const msg = err.response?.data?.error || err.response?.data?.message
      const friendly =
        msg ? `${s ? `HTTP ${s} — ` : ''}${msg}` :
        s === 401 ? 'HTTP 401 — Session expired. Please log out and back in.' :
        s === 403 ? 'HTTP 403 — Admin access required to view system status.' :
        s ? `HTTP ${s} — ${err.response?.statusText || 'Server error'}` :
        err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED' ? 'Cannot reach the backend server. Is it running?' :
        err.message || 'Unknown error'
      setError(friendly)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStatus() }, [])

  const statusIcon = (s) => {
    if (s === 'ok')           return <FaCheckCircle className="ss-icon ss-ok" />
    if (s === 'error')        return <FaTimesCircle className="ss-icon ss-error" />
    if (s === 'unconfigured') return <FaMinusCircle className="ss-icon ss-unconfigured" />
    return <FaSpinner className="ss-icon ss-loading" />
  }

  const overallClass = status
    ? status.overall === 'ok' ? 'ss-overall ss-overall-ok' : 'ss-overall ss-overall-degraded'
    : 'ss-overall'

  return (
    <div className="system-status-page">
      <div className="ss-header">
        <div className={overallClass}>
          {status && (status.overall === 'ok'
            ? <><FaCheckCircle /> All systems operational</>
            : <><FaExclamationCircle /> One or more services need attention</>
          )}
          {!status && !loading && !error && <span>—</span>}
          {loading && <><FaSpinner className="spin" /> Checking services…</>}
          {error && <><FaTimesCircle /> {error}</>}
        </div>
        <button className="ss-refresh-btn" onClick={fetchStatus} disabled={loading}>
          <FaSync className={loading ? 'spin' : ''} />
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {/* SEC-14 condition 10: an instance running with SESSION_COOKIE_INSECURE=1 says so
          where an administrator looks, not only in a boot log line nobody reads. */}
      {getSession()?.cookieSecure === false && (
        <div className="ss-security-warning" role="status">
          <FaExclamationCircle aria-hidden="true" />
          <span>
            Sign-in cookies are <strong>not</strong> marked Secure (SESSION_COOKIE_INSECURE=1).
            Sessions can be read on the network and tossed by sibling subdomains. Serve
            GameTracker over HTTPS and unset it.
          </span>
        </div>
      )}

      {status && (
        <>
          <div className="ss-grid">
            {status.services.map(svc => {
              const meta = SERVICE_META[svc.name] || { label: svc.name, desc: '', website: null, auth: '' }
              const ago = timeAgo(svc.lastOk)
              const httpLabel = svc.httpStatus ? `HTTP ${svc.httpStatus}${HTTP_STATUS_LABELS[svc.httpStatus] ? ' — ' + HTTP_STATUS_LABELS[svc.httpStatus] : ''}` : null
              // IGDB/Twitch tokens expire every ~60 days — show actionable hint on 401
              const igdbTokenExpired = svc.name === 'igdb' && svc.httpStatus === 401
              return (
                <div key={svc.name} className={`ss-card ss-card-${svc.status}`}>

                  {/* Title row */}
                  <div className="ss-card-top">
                    {statusIcon(svc.status)}
                    <div className="ss-card-title-block">
                      <div className="ss-card-label">{meta.label}</div>
                      {meta.website && <div className="ss-card-website">{meta.website}</div>}
                    </div>
                    <span className={`ss-badge ss-badge-${svc.status}`}>
                      {svc.status === 'ok' ? 'OK' : svc.status === 'error' ? 'Error' : 'N/A'}
                    </span>
                  </div>

                  {/* Description + auth */}
                  <div className="ss-card-meta">
                    <span className="ss-card-desc">{meta.desc}</span>
                    <span className="ss-card-auth">{meta.auth}</span>
                  </div>

                  {/* HTTP error */}
                  {svc.status === 'error' && httpLabel && (
                    <div className="ss-http-status">{httpLabel}</div>
                  )}

                  {/* IGDB token expiry hint */}
                  {igdbTokenExpired && (
                    <div className="ss-igdb-hint">
                      <strong>Twitch OAuth token expired.</strong><br />
                      Go to <strong>Settings → API Keys</strong>, make sure your Client ID &amp; Secret are saved, then click <em>Refresh IGDB Token</em> — it fetches a new token automatically.
                    </div>
                  )}

                  {/* Error / info message */}
                  {svc.message && (
                    <div className={`ss-card-msg${svc.status === 'error' ? ' ss-card-msg-error' : ''}`}>
                      {svc.message}
                    </div>
                  )}

                  {/* Footer row: latency + last OK */}
                  <div className="ss-card-footer">
                    <span className="ss-last-ok">
                      {svc.status === 'ok'
                        ? <><FaCheckCircle className="ss-lastok-icon ss-ok" /> Last OK: just now</>
                        : ago
                          ? <><FaCheckCircle className="ss-lastok-icon ss-ok" /> Last OK: {ago}</>
                          : <><FaTimesCircle className="ss-lastok-icon ss-error" /> Never succeeded</>
                      }
                    </span>
                    {svc.latency != null && (
                      <span className="ss-latency">{svc.latency} ms</span>
                    )}
                  </div>

                </div>
              )
            })}
          </div>
          <div className="ss-footer">Last checked: {new Date(status.checkedAt).toLocaleString()}</div>
        </>
      )}
    </div>
  )
}
