// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API_BASE } from '../api'
import { readSession, peekSessionEnd, clearSessionEnd, returnPathFor } from '../session'
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
      const res = await api.post(`${API_BASE}/auth/login`, { username: normalizedUsername, password })
      const session = readSession(res.data.token)
      if (!session) {
        // The server just issued this token, so "expired" can only mean this device's
        // clock is wrong. Say so: returning to a blank login form looked like a failure
        // with no reason, and the user could never get in.
        setError('Can\'t start your session: this device\'s date and time look wrong. Correct them, then sign in again.')
        return
      }
      try {
        localStorage.setItem('token', res.data.token)
      } catch {
        // The server accepted the sign-in; the BROWSER refused to store it (storage
        // blocked or full). Not "can't reach the server", which is what it read as.
        setError('Signed-in sessions need browser storage, and this browser blocked it. Allow site data for this site, then sign in again.')
        return
      }
      setUser(session)
      // Back to where the session ended only for the SAME user (FE-14).
      navigate(returnPathFor(sessionEnd, res.data.token) || '/search')
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
