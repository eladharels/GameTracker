import { useEffect, useState } from 'react'
import { FaAndroid, FaDownload, FaExclamationCircle, FaSync } from 'react-icons/fa'
import { api } from './api'

// My Account -> Android App (MOB-40).
//
// The ONE published APK lives at this fixed path, served by the frontend's nginx (never the
// backend), so it is fetched with a plain same-origin URL, not API_BASE. A HEAD request
// tells "published" (200) from "not yet" (404, until the first signed build) from "could
// not check" (anything else), so the page never offers a download that would save a 404
// page as "gametracker.apk". It is not /api/, so api.js adds no CSRF header to it, and a
// 404 here never touches the session (only a 401 does).
export const APK_PATH = '/download/gametracker.apk'

const formatSize = (bytes) => {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (httpDate) => {
  const d = httpDate ? new Date(httpDate) : null
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function MobileAppSection() {
  // 'checking' | 'available' | 'missing' | 'error'
  const [state, setState] = useState('checking')
  const [meta, setMeta] = useState({ size: null, updated: null })

  useEffect(() => {
    let live = true
    api.head(APK_PATH)
      .then((res) => {
        if (!live) return
        setMeta({
          size: formatSize(res.headers?.['content-length']),
          updated: formatDate(res.headers?.['last-modified']),
        })
        setState('available')
      })
      .catch((err) => {
        if (!live) return
        setState(err?.response?.status === 404 ? 'missing' : 'error')
      })
    return () => { live = false }
  }, [])

  const details = [meta.updated && `Updated ${meta.updated}`, meta.size].filter(Boolean).join(' · ')

  return (
    <div className="ent-section" style={{ marginTop: '2rem' }}>
      <div className="ent-section-header">
        <FaAndroid className="ent-section-icon" aria-hidden="true" />
        <div>
          <div className="ent-section-title">Android App</div>
          <div className="ent-section-desc">
            GameTracker for Android phones. Sign in with the same username and password.
          </div>
        </div>
      </div>

      <div className="mobile-app-body">
        {/* The live region is this one short line only: wrapping the steps and the note in
            it made a screen reader read all of them on every visit (UI/UX review, PR #10). */}
        <p className={`mobile-app-status${state === 'error' ? ' mobile-app-status--error' : ''}`} role="status">
          {state === 'checking' && <><FaSync className="ent-spin" aria-hidden="true" /> Checking for the app…</>}
          {state === 'available' && 'The Android app is available.'}
          {state === 'missing' && 'The Android app hasn\u2019t been published on this server yet. Check back later.'}
          {state === 'error' && <><FaExclamationCircle aria-hidden="true" /> Couldn&apos;t check whether the app is available.</>}
        </p>

        {state === 'error' && (
          // No `download` here: this state covers 5xx and proxy errors, and `download` would
          // save that error page as gametracker.apk. Opened normally, the browser shows the
          // real response instead (UI/UX review, PR #10).
          <p className="mobile-app-fallback">
            <a className="mobile-app-inline-link" href={APK_PATH}>Try the download anyway</a>
          </p>
        )}

        {state === 'available' && (
          <>
            <div className="mobile-app-actions">
              <a className="ent-save-btn mobile-app-download" href={APK_PATH} download="gametracker.apk">
                <FaDownload aria-hidden="true" /> Download for Android
              </a>
              {details && <span className="mobile-app-meta">{details}</span>}
            </div>
            <ol className="mobile-app-steps">
              <li>Open this page on your phone and tap <strong>Download for Android</strong>.</li>
              <li>Open the downloaded file. If Android asks, allow <strong>Install unknown apps</strong> for your browser.</li>
              <li>If Play Protect warns about an unknown developer, choose <strong>Install anyway</strong>.</li>
            </ol>
            <p className="mobile-app-note">
              New versions install over the old one: download again to update. If a test build
              from somewhere else is installed, Android refuses this one (&ldquo;App not
              installed&rdquo;) until you uninstall it. Uninstalling deletes the ratings and notes
              stored on that phone.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
