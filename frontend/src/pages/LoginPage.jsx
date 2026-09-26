// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API_BASE, probeSession } from '../api'
import {
  peekSessionEnd, clearSessionEnd, returnPathFor, sessionFromView, setSession, writeHint,
  announceSession, peekSignInUpdated, clearSignInUpdated,
} from '../session'
import { loginErrorMessage } from '../loginErrors'

export default function LoginPage({ setUser }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()
  // Why this page is showing, read once: set when a session ENDED (expiry, or refused by
  // the server), never on a manual logout. Carries the path to return to.
  const [sessionEnd] = useState(() => peekSessionEnd())
  // In flight: a slow directory bind otherwise leaves the form looking idle, inviting a
  // second submit.
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => { clearSessionEnd() }, [])   // cleared AFTER mount: see peekSessionEnd
  const [showEndNotice, setShowEndNotice] = useState(!!sessionEnd)
  // SEC-14: shown once after the old localStorage session was removed at boot. Neutral --
  // it is not the "session ended" notice, and it never shows alongside it.
  const [showUpdated] = useState(() => !sessionEnd && peekSignInUpdated())
  useEffect(() => { clearSignInUpdated() }, [])

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setShowEndNotice(false)
    
    // Client-side validation to prevent empty credentials
    if (!username.trim() || !password.trim()) {
      setError('Username and password are required.')
      return
    }
    
    setSigningIn(true)
    try {
      // Convert username to lowercase to prevent case sensitivity issues
      const normalizedUsername = username.toLowerCase()
      // SEC-14: a COOKIE session. The server sets an HttpOnly cookie this page cannot read,
      // and answers who signed in; no token ever reaches JavaScript.
      await api.post(`${API_BASE}/auth/login`, { username: normalizedUsername, password, session: 'cookie' })
      // The session is real only once the SERVER sees the cookie come back. A browser that
      // refused it (a plain-HTTP install without the insecure opt-out) answers 401 here --
      // said as such, rather than looping back to this form with no reason (condition 17).
      let view
      try {
        view = await probeSession()
      } catch (probeErr) {
        if (probeErr?.response?.status === 401) {
          setError('Your browser didn\'t keep the sign-in cookie. Allow cookies for this site; if it is served over plain HTTP, an administrator must enable HTTPS or set SESSION_COOKIE_INSECURE=1.')
        } else if (probeErr?.response?.status === 403) {
          // The sign-in itself SUCCEEDED; only the confirmation was refused (a proxy stripping
          // the X-Requested-With header, typically). Not "your account isn't allowed", which
          // is what the generic mapping would say (CISO review).
          setError('Signed in, but the server refused to confirm the session. A proxy in front of GameTracker may be stripping request headers; ask an administrator.')
        } else {
          setError(loginErrorMessage(probeErr))
        }
        return
      }
      const session = setSession(sessionFromView(view))
      if (!session) { setError('Sign-in failed. Please try again.'); return }
      writeHint(session)
      announceSession('login', session.username)
      setUser(session)
      // Back to where the session ended only for the SAME user (FE-14).
      navigate(returnPathFor(sessionEnd, session.username) || '/search')
    } catch (err) {
      // Distinct answers for a lockout, an outage and a wrong password (FE-4).
      setError(loginErrorMessage(err))
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleLogin}>
        <div className="login-wordmark">
          <span className="brand-mark brand-mark--lg" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 11h4M8 9v4"/><line x1="15" y1="11" x2="15.01" y2="11"/><line x1="18" y1="13" x2="18.01" y2="13"/><rect x="2" y="6" width="20" height="12" rx="5"/></svg>
          </span>
          <div className="login-wordmark-title">GameTracker</div>
          <div className="login-wordmark-sub">Track every game worth your time</div>
        </div>
        {showEndNotice && (
          // role="status", not "alert": nothing the user typed is wrong.
          <div className="login-notice" role="status">
            Your session has ended. Please sign in again.
          </div>
        )}
        {showUpdated && (
          <div className="login-notice" role="status">
            Sign-in has been updated for better security. Please sign in again.
          </div>
        )}
        <div className="login-field-group">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            placeholder="Enter your username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onBlur={e => setUsername(e.target.value.toLowerCase())}
            autoFocus
          />
        </div>
        <div className="login-field-group">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" disabled={signingIn} aria-busy={signingIn}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="error-msg" role="alert">{error}</div>}
      </form>
    </div>
  )
}
