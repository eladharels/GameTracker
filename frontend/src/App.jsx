import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom'
import './App.css'
import { FaSearch, FaBook, FaUsers, FaSignOutAlt, FaLock, FaSortAlphaDown, FaSortNumericDown, FaSortAmountDown, FaCog, FaEnvelope, FaBell, FaCheckCircle, FaRegCalendarAlt, FaArrowLeft, FaPlay, FaHeart, FaEye, FaCheck, FaTh, FaList, FaTrash, FaExclamationCircle, FaShareAlt, FaSync, FaArrowUp, FaArrowDown, FaGamepad, FaGripVertical, FaExpand, FaCompress, FaUser, FaTelegram, FaChevronDown, FaServer, FaTimesCircle, FaMinusCircle, FaSpinner, FaKey, FaEyeSlash, FaCode, FaChartBar, FaHourglassHalf } from 'react-icons/fa'
import { useToast } from './contexts/ToastContext'
import SharedLibrary from './SharedLibrary'
import { api, API_BASE } from './api'
import GameDetailModal from './GameDetailModal'
import { formatDurationShort, formatDurationLong, formatDateReadable, formatDateLocal } from './dateUtils'
import ApiTokensSection from './ApiTokensSection'
import StatsPage from './StatsPage'
import { readSession, msUntilExpiry, peekSessionEnd, clearSessionEnd, endSession, returnPathFor } from './session'
import { safeExternalUrl } from './safeUrl'
import { libraryMatch } from './libraryMatch'
import { loginErrorMessage } from './loginErrors'
import { useDialogFocus } from './useDialogFocus'
// LAZY, deliberately. swagger-ui-react is larger than the rest of this application
// put together, and it is needed on exactly one page that most sessions never open.
// Statically imported it would land in the main chunk and slow every login.
const ApiDocsPage = lazy(() => import('./ApiDocsPage'))

const ACCENT_PRESETS = [
  { name: 'Violet',  value: '#8b5cf6' },
  { name: 'Blue',    value: '#3b82f6' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Amber',   value: '#f59e0b' },
  { name: 'Rose',    value: '#f43f5e' },
  { name: 'Cyan',    value: '#06b6d4' },
]

// API_BASE and the ONE authenticated client live in ./api (FE-16): the token is attached,
// and a 401 ends the session, by that client's interceptors — not by patching the
// global axios on import, which every page used to depend on silently.

const STATUSES = ['wishlist', 'playing', 'done', 'backlog']

// Date-only future check (YYYY-MM-DD parses as UTC midnight; compare date-only,
// matching the backend cron so "releases today" counts as released everywhere).
function isGameReleaseInFuture(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d > today;
}

// Single source of truth: a game is "unreleased" if flagged, dateless, or its
// release date is still in the future. Accepts library games (release_date) or
// search results (releaseDate).
function isGameUnreleased(game) {
  const date = game.release_date ?? game.releaseDate;
  return game.status === 'unreleased' || !date || isGameReleaseInFuture(date);
}

// Helper function to normalize status values
function normalizeStatus(status) {
  if (!status) return 'wishlist';
  return status.toLowerCase();
}

// ${window.location.protocol} ${window.location.hostname}
function useAuth() {
  // Read during the FIRST render, not in an effect: with `null` on the first pass the
  // logged-out `*` route redirected every deep link to /login before the token was read.
  //
  // readSession checks `exp` (SEC-7): an expired or malformed token is dropped here
  // instead of rendering the whole app until the first request comes back 401.
  const [user, setUser] = useState(() => {
    const token = localStorage.getItem('token')
    const payload = readSession(token)
    if (token && !payload) endSession({ explain: true, fromPath: window.location.pathname })
    return payload
  })
  return [user, setUser]
}

function App() {
  const [user, setUser] = useAuth()
  const { showToast } = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  const [accentColor, setAccentColor] = useState(
    () => localStorage.getItem('accent_color') || '#8b5cf6'
  )
  useEffect(() => {
    document.documentElement.style.setProperty('--color-accent', accentColor)
    localStorage.setItem('accent_color', accentColor)
  }, [accentColor])

  const [widescreen, setWidescreen] = useState(
    () => localStorage.getItem('widescreen') === 'true'
  )
  const toggleWidescreen = () => {
    setWidescreen(prev => {
      const next = !prev
      localStorage.setItem('widescreen', String(next))
      return next
    })
  }

  // Logout function
  const logout = useCallback(() => {
    endSession({ explain: false })   // a manual sign-out: the login page says nothing
    setUser(null)
    navigate('/login')
  }, [setUser, navigate])

  // The session ENDED rather than being left: the login page says so, and offers the
  // way back. Separate from `logout`, which is also a click handler (`onClick={logout}`
  // would hand it the event) and must stay silent — a manual logout is not an expiry.
  const expireSession = useCallback(() => {
    endSession({ explain: true, fromPath: window.location.pathname })
    setUser(null)
    navigate('/login')
  }, [setUser, navigate])

  // End the session when the token expires while the app is open, rather than when the
  // next request happens to be refused. Re-armed whenever the signed-in user changes.
  // Two minutes ahead, a warning: when the timer fires the route tree unmounts and any
  // half-filled form goes with it — the server would refuse the save anyway, since there
  // is no token refresh, so a warning is the only thing that can save the work.
  useEffect(() => {
    if (!user) return undefined
    const ms = msUntilExpiry(localStorage.getItem('token'))
    if (ms === null) { expireSession(); return undefined }
    const WARN_AHEAD_MS = 2 * 60 * 1000
    // setTimeout overflows past ~24.8 days and fires at once; a 12-hour token never gets
    // near that, but a clamp costs nothing. A timer delayed by a suspended laptop or a
    // background tab fires late, not never — and until it does, the 401 interceptor is
    // the backstop for any request made on the expired token.
    //
    // Known trade-off: `exp` is compared with the CLIENT clock. A clock running more than
    // 12 hours fast reads a fresh token as expired and sends the user back to login.
    // The server's check is the real one; this only decides what the UI shows.
    const clamp = (v) => Math.min(v, 2 ** 31 - 1)
    const timers = [setTimeout(expireSession, clamp(ms))]
    if (ms > WARN_AHEAD_MS) {
      timers.push(setTimeout(
        () => showToast('info', 'Your session ends in 2 minutes. Save any changes now.', { duration: 15000 }),
        clamp(ms - WARN_AHEAD_MS),
      ))
    }
    return () => timers.forEach(clearTimeout)
  }, [user, expireSession, showToast])

  // Determine page title
  let pageTitle = ''
  if (location.pathname.startsWith('/search')) pageTitle = 'Search Games'
  else if (location.pathname.startsWith('/library')) pageTitle = 'My Library'
  else if (location.pathname.startsWith('/calendar')) pageTitle = 'Calendar'
  else if (location.pathname.startsWith('/stats')) pageTitle = 'Statistics'
  else if (location.pathname.startsWith('/users')) pageTitle = 'User Management'
  else if (location.pathname.startsWith('/account')) pageTitle = 'My Account'
  else if (location.pathname.startsWith('/settings')) pageTitle = 'Settings'
  else if (location.pathname.startsWith('/system-status')) pageTitle = 'System Status'
  else if (location.pathname.startsWith('/api-docs')) pageTitle = 'API Reference'
  else if (location.pathname.startsWith('/game/')) pageTitle = 'Game Details'

  // If not logged in, render only the login page/route
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage setUser={setUser} />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    )
  }

  // If logged in, render the full app
  return (
    <div className={`container${widescreen ? ' widescreen' : ''}`}>
      <aside className="sidebar left-sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 11h4M8 9v4"/><line x1="15" y1="11" x2="15.01" y2="11"/><line x1="18" y1="13" x2="18.01" y2="13"/><rect x="2" y="6" width="20" height="12" rx="5"/></svg>
          </span>
          <span className="brand-name">GameTracker</span>
        </div>
        <nav className="nav-menu">
          <Link to="/search" className={location.pathname === '/search' ? 'active' : ''}>
            <FaSearch className="nav-icon" />
            <span className="nav-label">Search Games</span>
          </Link>
          <Link to="/library" className={location.pathname === '/library' ? 'active' : ''}>
            <FaBook className="nav-icon" />
            <span className="nav-label">My Library</span>
          </Link>
          <Link to="/shared-library" className={location.pathname === '/shared-library' ? 'active' : ''}>
            <FaShareAlt className="nav-icon" />
            <span className="nav-label">Shared Library</span>
          </Link>
          <Link to="/calendar" className={location.pathname === '/calendar' ? 'active' : ''}>
            <FaRegCalendarAlt className="nav-icon" />
            <span className="nav-label">Calendar</span>
          </Link>
          <Link to="/stats" className={location.pathname === '/stats' ? 'active' : ''}>
            <FaChartBar className="nav-icon" />
            <span className="nav-label">Statistics</span>
          </Link>
          {/* The same check as the /users route gate, so the link never leads to a redirect. */}
          {user.can_manage_users && (
            <Link to="/users" className={location.pathname === '/users' ? 'active' : ''}>
              <FaUsers className="nav-icon" />
              <span className="nav-label">User Management</span>
            </Link>
          )}
          <Link to="/account" className={location.pathname === '/account' ? 'active' : ''}>
            <FaUser className="nav-icon" />
            <span className="nav-label">My Account</span>
          </Link>
          <Link to="/settings" className={location.pathname === '/settings' ? 'active' : ''}>
            <FaCog className="nav-icon" />
            <span className="nav-label">Settings</span>
          </Link>
          <Link to="/api-docs" className={location.pathname === '/api-docs' ? 'active' : ''}>
            <FaCode className="nav-icon" />
            <span className="nav-label">API Docs</span>
          </Link>
          {/* !! is load-bearing: can_manage_users is INTEGER 0/1, so `0 && …` renders
              the literal "0" in the sidebar for every non-admin, on every page. */}
          {!!user?.can_manage_users && (
            <Link to="/system-status" className={location.pathname === '/system-status' ? 'active' : ''}>
              <FaServer className="nav-icon" />
              <span className="nav-label">System Status</span>
            </Link>
          )}
          <button className="logout-btn" onClick={logout}>
            <FaSignOutAlt className="nav-icon" />
            <span className="nav-label">Sign out</span>
          </button>
          <button
            className={`widescreen-btn${widescreen ? ' widescreen-btn--active' : ''}`}
            onClick={toggleWidescreen}
            aria-label={widescreen ? 'Exit wide layout' : 'Enable wide layout'}
            aria-pressed={widescreen}
          >
            {widescreen ? <FaCompress className="nav-icon" /> : <FaExpand className="nav-icon" />}
            <span className="nav-label">{widescreen ? 'Compact' : 'Wide Screen'}</span>
          </button>
          <div className="theme-picker">
            {ACCENT_PRESETS.map(p => (
              <button
                key={p.value}
                className={`theme-dot${accentColor === p.value ? ' active' : ''}`}
                style={{ background: p.value }}
                onClick={() => setAccentColor(p.value)}
                title={p.name}
                aria-label={`Set accent color to ${p.name}`}
                aria-pressed={accentColor === p.value}
              />
            ))}
          </div>
        </nav>
      </aside>
      <main className="main-content">
        {/* A heading, and focusable by script only: the detail dialog's last-resort focus
            target when the list it was opened from no longer exists (FE-7). */}
        {pageTitle && <div className="page-title" role="heading" aria-level={1} tabIndex={-1}>{pageTitle}</div>}
        <Routes>
          <Route path="/search" element={<SearchPage user={user} />} />
          <Route path="/library" element={<LibraryPage user={user} />} />
          <Route path="/shared-library" element={<SharedLibrary />} />
          <Route path="/calendar" element={<CalendarPage user={user} />} />
          <Route path="/stats" element={<StatsPage user={user} />} />
          <Route path="/account" element={<AccountPage user={user} />} />
          {/* Admin-only pages are gated here too, not only in the sidebar: typing the URL
              used to open them, and the first 403 then logged the user out (P0-6). The
              server still decides; this only keeps a non-admin off a page of errors. */}
          <Route path="/users" element={user.can_manage_users ? <UserManagementPage user={user} /> : <Navigate to="/search" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Suspense boundary is required by the lazy import above. The fallback is
              deliberately plain text rather than a spinner component: this chunk is
              large, so the fallback is what a first-time visitor actually reads. */}
          <Route path="/api-docs" element={
            <Suspense fallback={<div className="api-docs-loading">Loading the API reference…</div>}>
              <ApiDocsPage />
            </Suspense>
          } />
          <Route path="/system-status" element={user.can_manage_users ? <SystemStatusPage /> : <Navigate to="/search" replace />} />
          <Route path="*" element={<Navigate to="/search" />} />
        </Routes>
      </main>
    </div>
  )
}

function LoginPage({ setUser }) {
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

function UserManagementPage({ user }) {
  const [users, setUsers] = useState([])
  const [, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The list itself failed to load. The table is then hidden, not shown empty: an empty
  // user table reads as "there are no users", which a failed request is not.
  const [loadFailed, setLoadFailed] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', can_manage_users: false })
  const [success, setSuccess] = useState('')
  const [ldapSyncLoading, setLdapSyncLoading] = useState(false)
  const [formError, setFormError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState(null)
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwTarget, setPwTarget] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const modalRef = useRef()
  const confirmModalRef = useRef()
  const pwModalRef = useRef()
  const addUserFirstInputRef = useRef()
  const pwInputRef = useRef()

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await api.get(`${API_BASE}/users`)
      setUsers(res.data)
      setLoadFailed(false)
      setLoading(false)
    } catch (err) {
      // 401 is the api.js interceptor's to handle (it ends the session). A 403 is NOT
      // "logged out" (ROADMAP P0-6): this handler used to delete the token and navigate
      // to /login while React still held the user, so the app bounced to /search looking
      // signed in and every later request failed.
      // A 401 normally never shows: the interceptor ends the session and reloads. It
      // only acts when a token is stored, though — after a logout in ANOTHER tab this
      // one sends no token, and a silent empty page is the wrong answer to that.
      const status = err.response?.status
      setError(status === 403 ? 'You do not have permission to manage users.'
        : status === 401 ? 'Your session has ended. Please sign in again.'
        : 'Failed to load users')
      setLoadFailed(true)
      setLoading(false)
    }
  }
  useEffect(() => { fetchUsers() }, [])

  const handleCreate = async (e) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setFormError('')
    // Basic validation
    if (!newUser.username.trim() || !newUser.password.trim()) {
      setFormError('Username and password are required.')
      return
    }
    try {
      await api.post(`${API_BASE}/users`, newUser)
      setSuccess('User created!')
      setNewUser({ username: '', password: '', can_manage_users: false })
      fetchUsers()
    } catch (err) {
      setError('Failed to create user')
    }
  }
  const handleDelete = async (id) => {
    setError('')
    setSuccess('')
    try {
      await api.delete(`${API_BASE}/users/${id}`)
      setSuccess('User deleted!')
      fetchUsers()
    } catch (err) {
      setError('Failed to delete user')
    }
  }

  const confirmDelete = (id) => {
    setConfirmTarget(id)
    setConfirmOpen(true)
  }

  const handlePasswordChange = (id) => {
    setPwTarget(id)
    setNewPassword('')
    setPwModalOpen(true)
  }

  const submitPasswordChange = async () => {
    if (!newPassword.trim()) return
    await handleEdit(pwTarget, { password: newPassword })
    setPwModalOpen(false)
    setNewPassword('')
    setPwTarget(null)
  }
  const handleEdit = async (id, updates) => {
    setError('')
    setSuccess('')
    try {
      await api.put(`${API_BASE}/users/${id}`, updates)
      setSuccess('User updated!')
      fetchUsers()
    } catch (err) {
      setError('Failed to update user')
    }
  }

  const handleLdapSync = async () => {
    setLdapSyncLoading(true)
    setError('')
    setSuccess('')
    
    try {
      const response = await api.post(`${API_BASE}/admin/ldap-sync`, {})
      
      const result = response.data
      if (result.success) {
        setSuccess(`LDAP sync completed! ${result.results.updated} users updated out of ${result.results.total} LDAP users.`)
        fetchUsers() // Refresh the user list to show updated information
      } else {
        setError('LDAP sync failed')
      }
    } catch (err) {
      setError(err.response?.data?.error || 'LDAP sync failed')
    } finally {
      setLdapSyncLoading(false)
    }
  }

  // Modal close on ESC
  useEffect(() => {
    if (!modalOpen && !confirmOpen && !pwModalOpen) return;
    function onKey(e) {
      if (e.key === 'Escape') {
        if (pwModalOpen) { setPwModalOpen(false); return }
        if (confirmOpen) { setConfirmOpen(false); return }
        setModalOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, confirmOpen, pwModalOpen])

  // Focus in on open, back to the opener on close, Tab kept inside (FE-19). These focused
  // an input after a 50 ms setTimeout and never gave focus back; the delete confirmation
  // got no initial focus at all. An alertdialog opens on its LEAST destructive action, so
  // an Enter pressed out of habit cancels rather than deletes. Escape stays with the
  // window listener above, which knows which dialog is on top.
  const confirmCancelRef = useRef(null)
  const confirmDialog = useDialogFocus(confirmOpen, { initialRef: confirmCancelRef })
  const pwDialog = useDialogFocus(pwModalOpen, { initialRef: pwInputRef })
  const addUserDialog = useDialogFocus(modalOpen, { initialRef: addUserFirstInputRef })

  function handleModalBgClick(e) {
    if (e.target === modalRef.current) setModalOpen(false)
  }

  // Modern card-based UI
  return (
    <div className="user-management-page-modern">
      <div className="user-management-toolbar">
        <div>
          <div className="user-mgmt-subtitle">Manage your team members and their account permissions here.</div>
        </div>
        <div className="user-management-actions">
          <button 
            className="ldap-sync-btn" 
            onClick={handleLdapSync}
            disabled={ldapSyncLoading}
          >
            {ldapSyncLoading ? (
              <>
                <FaSpinner className="spin-icon" style={{marginRight:6}} />
                Syncing...
              </>
            ) : (
              <>
                <FaSync style={{marginRight:6}} />
                Sync LDAP Users
              </>
            )}
          </button>
          <button className="add-user-btn" onClick={() => setModalOpen(true)}>Add User</button>
        </div>
      </div>
      {confirmOpen && (
        <div className="user-modal-bg" ref={confirmModalRef} onClick={e => { if (e.target === confirmModalRef.current) setConfirmOpen(false) }} tabIndex={-1} aria-modal="true" role="alertdialog" aria-labelledby="confirm-dialog-title">
          <div className="user-modal-window" style={{maxWidth: 400}} onKeyDown={confirmDialog.onKeyDown}>
            <h3 id="confirm-dialog-title" style={{marginTop:0}}>Delete User</h3>
            <p style={{color:'var(--color-fg-muted)'}}>Are you sure you want to delete this user? This cannot be undone.</p>
            <div style={{display:'flex', gap:'1rem', justifyContent:'flex-end', marginTop:'1.5rem'}}>
              <button ref={confirmCancelRef} className="icon-btn enhanced-icon-btn" style={{padding:'0.6em 1.4em'}} onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button
                className="create-user-btn enhanced-btn"
                style={{background:'#ef4444', padding:'0.6em 1.4em'}}
                onClick={() => { handleDelete(confirmTarget); setConfirmOpen(false) }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}
      {pwModalOpen && (
        <div className="user-modal-bg" ref={pwModalRef} onClick={e => { if (e.target === pwModalRef.current) setPwModalOpen(false) }} tabIndex={-1} aria-modal="true" role="dialog" aria-labelledby="pw-dialog-title">
          <div className="user-modal-window" style={{maxWidth: 400}} onKeyDown={pwDialog.onKeyDown}>
            <button className="user-modal-close" aria-label="Close" onClick={() => setPwModalOpen(false)}>&times;</button>
            <h3 id="pw-dialog-title" style={{marginTop:0}}>Change Password</h3>
            <div className="user-form-group" style={{flexDirection:'column'}}>
              <label htmlFor="pw-new-input" style={{fontWeight:600, marginBottom:'0.35rem'}}>New Password</label>
              <input
                id="pw-new-input"
                ref={pwInputRef}
                type="password"
                className="ent-input"
                placeholder="Enter new password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitPasswordChange() }}
              />
            </div>
            <div style={{display:'flex', gap:'1rem', justifyContent:'flex-end', marginTop:'1.5rem'}}>
              <button className="icon-btn enhanced-icon-btn" style={{padding:'0.6em 1.4em'}} onClick={() => setPwModalOpen(false)}>Cancel</button>
              <button
                className="create-user-btn enhanced-btn"
                disabled={!newPassword.trim()}
                onClick={submitPasswordChange}
              >Change Password</button>
            </div>
          </div>
        </div>
      )}
      {modalOpen && (
        <div className="user-modal-bg" ref={modalRef} onClick={handleModalBgClick} tabIndex={-1} aria-modal="true" role="dialog" aria-labelledby="add-user-dialog-title">
          <div className="user-modal-window" onKeyDown={addUserDialog.onKeyDown}>
            <button className="user-modal-close" aria-label="Close" onClick={() => setModalOpen(false)}>&times;</button>
            <h3 id="add-user-dialog-title" style={{marginTop:0, marginBottom:'1rem'}}>Add User</h3>
            <form className="user-form-modern user-form-vertical user-form-enhanced" onSubmit={handleCreate}>
              <div className="user-form-group">
                <label>Username
                  <input
                    ref={addUserFirstInputRef}
                    type="text"
                    placeholder="Username"
                    value={newUser.username}
                    onChange={e => setNewUser({ ...newUser, username: e.target.value })}
                    required
                  />
                </label>
                <label>Password
                  <input
                    type="password"
                    placeholder="Password"
                    value={newUser.password}
                    onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                    required
                  />
                </label>
              </div>
              <div className="user-form-group user-form-checkboxes enhanced-toggles" style={{justifyContent: 'flex-start', alignItems: 'center', gap: '2.2rem', marginBottom: '0.5rem'}}>
                <label className="switch-modern enhanced-switch">
                  <input type="checkbox" checked={newUser.can_manage_users} onChange={e => setNewUser({ ...newUser, can_manage_users: e.target.checked })} />
                  <span className="slider-modern enhanced-slider"></span>
                  <span className="switch-label enhanced-switch-label">Admin</span>
                </label>
              </div>
              {formError && <div className="error-msg enhanced-error"><FaExclamationCircle style={{marginRight:6}}/> {formError}</div>}
              <button type="submit" className="create-user-btn enhanced-btn">Create User</button>
            </form>
            {success && <div className="success-msg enhanced-success"><FaCheckCircle style={{marginRight:6}}/> {success}</div>}
            {error && <div className="error-msg enhanced-error"><FaExclamationCircle style={{marginRight:6}}/> {error}</div>}
          </div>
        </div>
      )}
      {/* Page-level messages. They used to render ONLY inside the Add User dialog, so a
          failed load, delete or LDAP sync with the dialog closed said nothing at all. While
          the dialog is open it shows them itself, next to the form they concern. */}
      {!modalOpen && error && (
        <div className="gt-alert gt-alert--danger gt-alert--page" role="alert">
          <FaExclamationCircle aria-hidden="true" />
          <div>
            {error}
            {/* With the table hidden, retrying is otherwise only a page reload. */}
            {loadFailed && (
              <><br /><button type="button" className="gt-alert-action" onClick={() => { setError(''); fetchUsers() }}>
                <FaSync aria-hidden="true" /> Retry
              </button></>
            )}
          </div>
        </div>
      )}
      {!modalOpen && success && (
        <div className="success-msg enhanced-success" role="status"><FaCheckCircle style={{marginRight:6}}/> {success}</div>
      )}
      {!loadFailed && (
      <div className="user-table-section">
        <table className="user-table-modern">
          <thead>
            <tr>
              <th>Avatar</th>
              <th>Name</th>
              <th>Full name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Date Joined</th>
              <th>Permissions</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              function stringToColor(str) {
                let hash = 0;
                for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
                const h = Math.abs(hash) % 360;
                return `hsl(${h}, 70%, 80%)`;
              }
              const avatarBg = stringToColor(u.username || 'U');
              const avatarLetter = (u.username && u.username.length > 0) ? u.username[0].toUpperCase() : '?';
              let role = 'User';
              if (u.can_manage_users) role = 'Admin';
              // Use real created_at date if available
              let joined = u.created_at ? new Date(u.created_at).toLocaleDateString() : 'Unknown';
              return (
                <tr key={u.id}>
                  <td><div className="user-table-avatar" style={{ background: avatarBg }} aria-label={`Avatar for ${u.username}` }>{avatarLetter}</div></td>
                  <td><span className="user-table-name">{u.username}</span></td>
                  <td><span className="user-table-fullname">{u.display_name || ''}</span></td>
                  <td><span className="user-table-email" title={u.email || 'No email set'}>{u.email || '—'}</span></td>
                  <td><span className="user-table-role">{role}</span></td>
                  <td><span className="user-table-date">{joined}</span></td>
                  <td>
                    <div className="user-table-perms">
                      <label className="switch-modern enhanced-switch" title="Toggle Admin Permission">
                        <input
                          type="checkbox"
                          aria-label={`Admin permission for ${u.username}`}
                          checked={!!u.can_manage_users}
                          disabled={u.username === 'root' || u.id === user.id}
                          onChange={e => handleEdit(u.id, { can_manage_users: e.target.checked })}
                        />
                        <span className="slider-modern enhanced-slider"></span>
                      </label>
                    </div>
                  </td>
                  <td><span className="user-table-source">{u.origin === 'ldap' ? 'LDAP' : 'Local'}</span></td>
                  <td>
                    <div className="user-table-actions">
                      <button className="icon-btn enhanced-icon-btn" title="Change Password" aria-label={`Change password for ${u.username}`} onClick={() => handlePasswordChange(u.id)}><FaLock /></button>
                      <button className="icon-btn enhanced-icon-btn" title="Delete User" aria-label={`Delete user ${u.username}`} onClick={() => confirmDelete(u.id)} disabled={u.username === 'root'}><FaTrash /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}

function SearchPage({ user }) {
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [viewMode, setViewMode] = useState('grid')
  const [gamePrices, setGamePrices] = useState({}) // { [gameId]: { price, loading, error } }
  const [openGame, setOpenGame] = useState(null)
  const { showToast } = useToast();
  // Which search is current (FE-2). A slow answer to an EARLIER query used to replace the
  // results of the one on screen; every response now checks it is still the latest.
  const searchSeq = useRef(0)
  // Where focus goes when the detail dialog closes and its opener is gone (FE-7).
  const resultsListRef = useRef(null)
  const openResult = (game, unreleased) => setOpenGame({
    ...game,
    game_id: game.id,
    game_name: game.name,
    cover_url: game.coverUrl,
    release_date: game.releaseDate,
    status: unreleased ? 'unreleased' : 'wishlist',
  })

  // Fetch price for a game by Steam App ID. `seq` ties it to the search that asked.
  const fetchGamePrice = async (gameId, steamAppId, seq) => {
    setGamePrices(prev => ({ ...prev, [gameId]: { loading: true } }))
    try {
      const res = await api.get(`${API_BASE}/game-price/${steamAppId}`)
      if (seq !== searchSeq.current) return
      setGamePrices(prev => ({ ...prev, [gameId]: { price: res.data.price, loading: false } }))
    } catch (err) {
      if (seq !== searchSeq.current) return
      setGamePrices(prev => ({ ...prev, [gameId]: { price: null, loading: false, error: true } }))
    }
  }

  // Search games
  const handleSearch = async (e) => {
    e.preventDefault()
    if (!search) return
    const seq = ++searchSeq.current
    setLoading(true)
    setSearchError('')
    try {
      const res = await api.get(`${API_BASE}/games/search?q=${encodeURIComponent(search)}`)
      if (seq !== searchSeq.current) return   // a newer search owns the screen now
      // Ensure res.data is an array
      const results = Array.isArray(res.data) ? res.data : []
      setSearchResults(results)
      // Fetch price for games with a Steam App ID
      results.forEach(game => {
        if (game.steamAppId) {
          fetchGamePrice(game.id, game.steamAppId, seq)
        }
      })
      if (results.length === 0) {
        setSearchError('No games found. Try a different search term.')
      }
    } catch (err) {
      if (seq !== searchSeq.current) return
      console.error('Search error:', err)
      setSearchResults([])
      const errorMsg = err.response?.data?.error || err.message || 'Failed to search games. Please try again.'
      setSearchError(errorMsg)
      showToast('error', errorMsg)
    }
    setLoading(false)
  }

  // Add to library (statusOverride lets the detail modal add with a chosen status)
  const addToLibrary = async (game, unreleased = false, statusOverride = null) => {
    if (!user) {
      showToast('error', 'You must be logged in to add games.');
      return;
    }
    try {
      // Check for duplicate: by id, or by name AND year (FE-3) — by name alone a remake
      // was refused because the original was in the library. The five-column own-games
      // read, not the whole library with every alias.
      const res = await api.get(`${API_BASE}/user/me/games`);
      const match = libraryMatch(res.data, game);
      if (match === 'same') {
        // 'info', not 'error': nothing failed — the game is simply already there.
        showToast('info', 'This game is already in your library.');
        return;
      }
      await api.post(`${API_BASE}/user/${user.username}/games`, {
        gameId: game.id,
        gameName: game.name,
        coverUrl: game.coverUrl,
        releaseDate: game.releaseDate,
        status: statusOverride || (unreleased ? 'unreleased' : 'wishlist'),
        steamAppId: game.steamAppId || null,
      })
      if (match === 'possible') {
        // Not refused (it may be a remake), but not silent either: search often returns
        // the undated copy of a game the library already holds from another provider.
        // ONE toast, so a screen reader announces one thing, not two in a row.
        showToast('info', `Added "${game.name}" to your library. You already had a game with this name, so remove one if they're the same game.`, { duration: 8000 });
      } else {
        showToast('success', `Added ${game.name} to your library!`);
      }
    } catch (err) {
      showToast('error', 'Failed to add to library.');
    }
  }

  return (
    <div className="results-section">
      <div className="search-controls-header">
        <form onSubmit={handleSearch} className="search-bar sonarr-style">
          <label htmlFor="search-input" className="visually-hidden">Search Games</label>
          <input
            id="search-input"
            type="text"
            placeholder="Search for games..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="search-icon-btn" aria-label="Search">
            <FaSearch />
          </button>
        </form>
        <div className="view-controls">
          <div className="view-toggle">
            <button onClick={() => setViewMode('grid')} className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`} aria-label="Grid view" aria-pressed={viewMode === 'grid'}><FaTh /></button>
            <button onClick={() => setViewMode('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} aria-label="List view" aria-pressed={viewMode === 'list'}><FaList /></button>
          </div>
        </div>
      </div>
      {loading && (
        <div className="games-list grid-view">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton-cover" />
              <div className="skeleton-line skeleton-line--med" />
              <div className="skeleton-line skeleton-line--short" />
            </div>
          ))}
        </div>
      )}
      {searchError && <div className="error-msg">{searchError}</div>}
      {searchResults.length > 0 && (
        <>
          <h2 id="search-results-heading">Search Results</h2>
          {/* role="region": an aria-label/labelledby on a role-less div is not allowed —
              the list is where focus lands when the dialog's opener is gone (FE-7). */}
          <div ref={resultsListRef} tabIndex={-1} role="region" aria-labelledby="search-results-heading"
            className={`games-list ${viewMode === 'list' ? 'list-view' : 'grid-view'}`}>
            {searchResults.map(game => {
              // Determine if unreleased (dateless or future release date)
              const unreleased = isGameUnreleased(game);
              // Price display logic
              let priceDisplay = 'Price: N/A';
              if (game.steamAppId) {
                const priceInfo = gamePrices[game.id];
                if (priceInfo?.loading) priceDisplay = 'Price: ...';
                else if (priceInfo?.price) priceDisplay = `Price: ${priceInfo.price}`;
                else if (priceInfo && priceInfo.price === null) priceDisplay = 'Price: Not found';
              }
              return (
                <div
                  key={game.id}
                  className={`game-card ${viewMode === 'list' ? 'list-item' : ''}`}
                  style={{ animationDelay: `${searchResults.indexOf(game) * 0.04}s` }}
                  onClick={(e) => {
                    if (e.target.closest('select,button,a')) return;
                    openResult(game, unreleased);
                  }}
                >
                  <div className="game-cover-container">
                    {game.coverUrl ? (
                      <img src={game.coverUrl} alt={game.name} className="game-cover" loading="lazy" decoding="async" onLoad={(e) => e.currentTarget.classList.add('cover-loaded')} />
                    ) : (
                      <div className="cover-placeholder">
                        <FaGamepad className="cover-placeholder-icon" />
                        <span className="cover-placeholder-name">{game.name}</span>
                      </div>
                    )}
                  </div>
                  <div className="game-info">
                    <div className="game-title">
                      <button type="button" className="game-title-btn"
                        onClick={(e) => { e.stopPropagation(); openResult(game, unreleased) }}>
                        {game.name}
                      </button>
                    </div>
                    <div className="game-release-date">
                      Release: {game.releaseDate ? game.releaseDate : 'Unreleased'}
                      {unreleased && <span className="unreleased-pill">Unreleased</span>}
                    </div>
                    <div className="game-price" style={{ margin: '0.5em 0', color: 'var(--color-accent)', fontWeight: 600 }}>{priceDisplay}</div>
                    <button
                      className="add-btn"
                      onClick={e => { e.stopPropagation(); addToLibrary(game, unreleased); }}
                    >
                      Add to Library
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <GameDetailModal
        game={openGame}
        onClose={() => setOpenGame(null)}
        onSetStatus={(g, status) => { addToLibrary(g, false, status); setOpenGame(null); }}
        onRemove={() => setOpenGame(null)}
        fallbackFocusRef={resultsListRef}
      />
    </div>
  )
}

function LibraryPage({ user }) {
  const [userGames, setUserGames] = useState([])
  // Starts true when there is a user, because the fetch below begins immediately and
  // `false` here paints "Your library is empty" for one frame before it does.
  const [loading, setLoading] = useState(Boolean(user))
  // A FAILED load is not an empty library. Without this the two are indistinguishable
  // on screen, which is how a six-second gap during a deploy read as "all my games
  // were deleted". Never let a fetch failure render as data.
  //
  // `responded` distinguishes "the server said nothing" from "the server said no". The
  // catch is unconditional, so telling a user their server "didn't respond" after a 500
  // states a cause nothing checked — the same defect as reporting a provider outage and
  // zero results identically, which services/catalog.js already refuses to do.
  const [loadError, setLoadError] = useState(null)   // null | { responded, status }
  const [retrying, setRetrying] = useState(false)
  const [filter, setFilter] = useState('all')
  const [statusError, setStatusError] = useState('')
  const [removeError, setRemoveError] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [sortDir, setSortDir] = useState('asc')
  const [viewMode, setViewMode] = useState('grid')
  const [currentPage, setCurrentPage] = useState(1)
  const [showPrices, setShowPrices] = useState(false)
  const [gamePrices, setGamePrices] = useState({}) // { [game_id]: { price, loading, error } }
  const [showCrackStatus, setShowCrackStatus] = useState(false)
  const [crackStatusMap, setCrackStatusMap] = useState({}) // { [game_id]: 'cracked'|'uncracked'|'unknown' }
  const [searchTerm, setSearchTerm] = useState('')
  const [refreshingMetadata, setRefreshingMetadata] = useState(false)
  const [refreshMetadataResult, setRefreshMetadataResult] = useState(null)
  const [refreshingGameIds, setRefreshingGameIds] = useState({})
  const [draggedGameId, setDraggedGameId] = useState(null)
  const [dragOverGameId, setDragOverGameId] = useState(null)
  const [isDraggingAny, setIsDraggingAny] = useState(false)
  const [keyboardDragId, setKeyboardDragId] = useState(null)
  const [openGame, setOpenGame] = useState(null)
  // The modal reads LIVE library state, not the object captured on click. `openGame` was
  // a snapshot and setGameStatus never refreshed it, so changing a status from inside the
  // modal left the Status pill — and, now, the timeline — showing the value from before
  // the change until the modal was closed and reopened. Falls back to the snapshot so a
  // game removed while open does not blank the modal mid-interaction.
  const modalGame = openGame
    ? (userGames.find((g) => String(g.game_id) === String(openGame.game_id)) ?? openGame)
    : null

  const { showToast } = useToast()
  const pendingDeleteRef = useRef({}) // { [gameId]: { timers, snapshot } }
  const gamesPerPage = 24

  // ONE fetch of the library, called by the mount effect and by "Try again".
  //
  // This matches the file's existing idiom (fetchUsers, fetchStatus, fetchSettings) and
  // replaces a reloadKey counter that was a fourth way of doing the same job. It also
  // gives the response-shape guard a single home: five other places in this component
  // refetch the same URL, and a guard that lives in only one of them protects only one.
  const fetchGames = useCallback(async () => {
    if (!user) { setUserGames([]); setLoadError(null); return }
    setLoadError(null)
    try {
      // Timestamp to defeat caching.
      const res = await api.get(`${API_BASE}/user/${user.username}/games?t=${Date.now()}`)
      // Guard the SHAPE: a reverse proxy answering with an HTML error page yields a
      // string, and setUserGames("<html>...") renders as an empty library rather than
      // as the failure it is.
      if (!Array.isArray(res.data)) throw new Error('unexpected library response')
      setUserGames(res.data)
      return true
    } catch (err) {
      // There was NO catch here at all. A rejected promise left `loading` true forever
      // — skeleton cards, no error, no retry, an unhandled rejection — and left any
      // previously loaded games on screen as though they were current.
      setUserGames([])
      setLoadError({ responded: Boolean(err?.response), status: err?.response?.status })
      return false
    }
  }, [user])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchGames().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchGames])

  // Per-game timings for the card badges, from the SAME endpoint the statistics page
  // reads. Not folded into the library response on purpose: that shape is frozen and
  // `SELECT *` already puts every new user_games column on the wire by accident (see
  // CLAUDE.md). Timings live in the event log, not on the row, so they arrive separately.
  //
  // DELIBERATELY NOT AWAITED with the library, and failure is silent. A badge is a
  // decoration on a card that already rendered; blocking the library on it, or showing an
  // error over a library that loaded perfectly well, would be the tail wagging the dog.
  // The map simply stays empty and no badges appear.
  const [gameTimings, setGameTimings] = useState({ done: {}, playing: {} })
  // Keyed on a counter bumped by SERVER-CONFIRMED writes, never on the `userGames` array.
  //
  // The array identity changes on the OPTIMISTIC setState inside setGameStatus — before
  // `await api.post` — so an effect depending on it issued this read concurrently with
  // the write it exists to observe, and nothing refetched afterwards. Marking a game done
  // therefore left its "Took 12d" badge missing or stale until a full page reload: the
  // feature failing precisely when used. The same dependency also refired on every
  // backlog drag-reorder, which cannot change any timing, costing a 5-query aggregate per
  // drop.
  // Whether the timings fetch has SETTLED, so the card can reserve the badge's line
  // instead of growing when it arrives. `.game-info` is space-between inside a grid row
  // that stretches to its tallest card, so a badge appearing in one card pushes
  // `.game-card-actions` — the status select, refresh and REMOVE — down in every card of
  // that row, a few hundred ms after the page looked settled.
  const [timingsLoaded, setTimingsLoaded] = useState(false)
  const [timingsVersion, setTimingsVersion] = useState(0)
  const refreshTimings = useCallback(() => setTimingsVersion((v) => v + 1), [])
  useEffect(() => {
    if (!user) { setGameTimings({ done: {}, playing: {} }); return }
    let cancelled = false
    api.get(`${API_BASE}/user/${encodeURIComponent(user.username)}/stats`)
      .then((res) => {
        if (cancelled || !res.data) return
        const done = {}
        for (const d of res.data.durations || []) done[d.gameId] = d
        const playing = {}
        for (const p of res.data.inProgress || []) playing[p.gameId] = p
        setGameTimings({ done, playing })
        setTimingsLoaded(true)
      })
      // Badges are optional; the library is not. But the reserved slot must still be
      // released, or a failed fetch leaves an empty line on every done/playing card.
      .catch(() => { if (!cancelled) setTimingsLoaded(true) })
    return () => { cancelled = true }
  }, [user, timingsVersion])

  // Retry needs to be VISIBLE. Measured without the floor: on a fast failure the
  // skeleton showed for a single ~16ms frame, so the button appeared to do nothing —
  // to precisely the user who already thinks their data is gone.
  const retryFetchGames = useCallback(async () => {
    setRetrying(true)
    const started = Date.now()
    const ok = await fetchGames()
    const elapsed = Date.now() - started
    if (elapsed < 400) await new Promise(r => setTimeout(r, 400 - elapsed))
    setRetrying(false)
    if (!ok) showToast('error', 'Still can\'t reach the server.')
  }, [fetchGames, showToast])

  const statusCounts = {
    all:        userGames.length,
    wishlist:   userGames.filter(g => normalizeStatus(g.status) === 'wishlist').length,
    playing:    userGames.filter(g => normalizeStatus(g.status) === 'playing').length,
    done:       userGames.filter(g => normalizeStatus(g.status) === 'done').length,
    unreleased: userGames.filter(g => isGameUnreleased(g)).length,
    backlog:    userGames.filter(g => normalizeStatus(g.status) === 'backlog').length,
  }

  const FILTERS = [
    { label: 'All', value: 'all' },
    { label: 'Wishlist', value: 'wishlist' },
    { label: 'Playing', value: 'playing' },
    { label: 'Done', value: 'done' },
    { label: 'Unreleased', value: 'unreleased' },
    { label: 'Backlog', value: 'backlog' },
  ]
  
  let filteredUserGames = filter === 'all'
    ? userGames
    : userGames.filter(game => {
        if (filter === 'unreleased') {
          return isGameUnreleased(game);
        }
        // Case-insensitive status comparison using helper function
        return normalizeStatus(game.status) === filter;
      });

  // Apply search filter
  if (searchTerm.trim()) {
    filteredUserGames = filteredUserGames.filter(game =>
      (game.game_name || '').toLowerCase().includes(searchTerm.trim().toLowerCase())
    );
  }

  // Sorting logic
  filteredUserGames = [...filteredUserGames].sort((a, b) => {
    // Backlog is always sorted by queue position
    if (filter === 'backlog') {
      return (a.backlog_order ?? 999999) - (b.backlog_order ?? 999999)
    }
    if (sortBy === 'name') {
      return sortDir === 'asc'
        ? a.game_name.localeCompare(b.game_name)
        : b.game_name.localeCompare(a.game_name)
    } else if (sortBy === 'release') {
      return sortDir === 'asc'
        ? (a.release_date || '').localeCompare(b.release_date || '')
        : (b.release_date || '').localeCompare(a.release_date || '')
    } else if (sortBy === 'status') {
      return sortDir === 'asc'
        ? a.status.localeCompare(b.status)
        : b.status.localeCompare(a.status)
    }
    return 0
  })

  // Pagination
  const totalPages = Math.ceil(filteredUserGames.length / gamesPerPage)
  const indexOfLastGame = currentPage * gamesPerPage
  const indexOfFirstGame = indexOfLastGame - gamesPerPage
  const currentGames = filteredUserGames.slice(indexOfFirstGame, indexOfLastGame)
  // A STABLE identity for the visible page (FE-1). `currentGames` is a new array on every
  // render, so effects keyed on it ran on every render; with crack-status requests not
  // tracked in flight, each response re-rendered and re-POSTed every pending game.
  const currentPageKey = currentGames.map(g => g.game_id).join('\u0001')
  // Prices also depend on WHICH visible games have a Steam id: a metadata refresh can
  // add one without changing any id, and the price would never load.
  const currentPriceKey = currentGames.map(g => `${g.game_id}:${g.steamAppId || ''}`).join('\u0001')
  const crackInFlight = useRef(new Set())
  // A 429 is "not now", not "no DRM information" (SEC-15 review): nothing is cached for the
  // throttled game, and no check is sent until the server's Retry-After has passed.
  const crackThrottledUntil = useRef(0)
  // Where focus goes when the detail dialog closes and the card that opened it is gone —
  // removed, or filtered out by a status change made in the dialog (FE-7, UI/UX review).
  const gamesListRef = useRef(null)

  // Fetch price for a game by Steam App ID
  const fetchGamePrice = async (gameId, steamAppId) => {
    setGamePrices(prev => ({ ...prev, [gameId]: { loading: true } }))
    try {
      const res = await api.get(`${API_BASE}/game-price/${steamAppId}`)
      setGamePrices(prev => ({ ...prev, [gameId]: { price: res.data.price, loading: false } }))
    } catch (err) {
      setGamePrices(prev => ({ ...prev, [gameId]: { price: null, loading: false, error: true } }))
    }
  }

  // When showPrices is toggled on, fetch prices for visible games with steamAppId
  useEffect(() => {
    if (showPrices) {
      currentGames.forEach(game => {
        if (game.steamAppId && !gamePrices[game.game_id]) {
          fetchGamePrice(game.game_id, game.steamAppId)
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPrices, currentPriceKey])

  const fetchCrackStatus = async (game) => {
    const id = String(game.game_id)
    if (crackInFlight.current.has(id)) return   // one request per game at a time
    crackInFlight.current.add(id)
    try {
      const res = await api.post(`${API_BASE}/user/${user.username}/games/${game.game_id}/crackrelease-status`);
      setCrackStatusMap(prev => ({ ...prev, [game.game_id]: res.data.status || 'unknown' }));
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = Number(err.response.headers?.['retry-after']) || 60
        crackThrottledUntil.current = Date.now() + retryAfter * 1000
        return   // leave it unset: a later page view (after the wait) checks it again
      }
      setCrackStatusMap(prev => ({ ...prev, [game.game_id]: 'unknown' }));
    } finally {
      crackInFlight.current.delete(id)
    }
  };

  // When showCrackStatus is toggled on, fetch crack status for visible games that don't have it yet
  useEffect(() => {
    if (!showCrackStatus || !user) return;
    if (Date.now() < crackThrottledUntil.current) return;   // the server asked us to wait
    currentGames.forEach(game => {
      const existing = game.crackStatus || crackStatusMap[game.game_id];
      if (!existing) {
        fetchCrackStatus(game);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCrackStatus, currentPageKey, user?.username])

  // Change status — optimistic update
  const setGameStatus = async (game, status) => {
    if (!user) return alert('Enter a username first!')
    setStatusError('')
    // Optimistically update local state immediately
    const sameGame = (g) => String(g.game_id) === String(game.game_id)
    const previousStatus = game.status
    setUserGames(prev => prev.map(g => sameGame(g) ? { ...g, status } : g))
    try {
      await api.post(`${API_BASE}/user/${user.username}/games`, {
        gameId: game.game_id,
        gameName: game.game_name,
        coverUrl: game.cover_url,
        releaseDate: game.release_date,
        status,
      })
      // AFTER the await: this write is what produced the status event, so reading the
      // stats before it returned would read the state the user just changed away from.
      refreshTimings()
    } catch (err) {
      // Roll back THIS game only, and only if nothing newer has changed it (FE-5).
      // Restoring a snapshot of the whole library undid every other game's change made
      // while this request was in flight.
      setUserGames(prev => prev.map(g =>
        sameGame(g) && g.status === status ? { ...g, status: previousStatus } : g
      ))
      showToast('error', 'Failed to update status. Please try again.')
    }
  }

  // Remove game — optimistic with 5-second undo window
  const removeGame = (gameId) => {
    if (!user) return
    setRemoveError('')
    const snapshot = userGames.find(g => String(g.game_id) === String(gameId))
    if (!snapshot) return

    // Optimistically remove from UI
    setUserGames(prev => prev.filter(g => String(g.game_id) !== String(gameId)))

    showToast('info', `Removed "${snapshot.game_name}"`, {
      duration: 5300,
      actionLabel: 'Undo',
      onAction: () => {
        // Cancel the pending delete
        if (pendingDeleteRef.current[gameId]) {
          pendingDeleteRef.current[gameId].forEach(t => clearTimeout(t))
          delete pendingDeleteRef.current[gameId]
        }
        // Restore the game to its original position
        setUserGames(prev => {
          const exists = prev.some(g => String(g.game_id) === String(gameId))
          if (exists) return prev
          return [...prev, snapshot].sort((a, b) => (a.backlog_order ?? 9999) - (b.backlog_order ?? 9999))
        })
        showToast('success', `"${snapshot.game_name}" restored.`)
      },
    })

    // After 5 seconds, execute the actual delete
    const deleteTimer = setTimeout(async () => {
      delete pendingDeleteRef.current[gameId]
      try {
        await api.delete(`${API_BASE}/user/${user.username}/games/${gameId}`)
        refreshTimings()
      } catch (err) {
        // Server delete failed — restore the game
        setUserGames(prev => {
          const exists = prev.some(g => String(g.game_id) === String(gameId))
          if (exists) return prev
          return [...prev, snapshot]
        })
        showToast('error', 'Failed to remove game. It has been restored.')
      }
    }, 5000)

    pendingDeleteRef.current[gameId] = [deleteTimer]
  }

  // Drag-and-drop reorder for backlog
  const handleBacklogDrop = async (targetGameId) => {
    if (!draggedGameId || draggedGameId === targetGameId) {
      setDraggedGameId(null)
      setDragOverGameId(null)
      return
    }
    const sorted = [...filteredUserGames]
    const fromIdx = sorted.findIndex(g => String(g.game_id) === String(draggedGameId))
    const toIdx   = sorted.findIndex(g => String(g.game_id) === String(targetGameId))
    if (fromIdx === -1 || toIdx === -1) return
    const newOrder = sorted.map(g => g.game_id)
    const [moved] = newOrder.splice(fromIdx, 1)
    newOrder.splice(toIdx, 0, moved)
    setDraggedGameId(null)
    setDragOverGameId(null)
    try {
      await api.put(`${API_BASE}/user/${user.username}/backlog-reorder`, { order: newOrder })
      const res = await api.get(`${API_BASE}/user/${user.username}/games?t=${Date.now()}`)
      setUserGames(res.data)
    } catch (err) {
      showToast('error', 'Failed to reorder backlog.')
    }
  }

  const handleMoveToTopOfBacklog = async (gameId) => {
    const sorted = [...filteredUserGames]
    const fromIdx = sorted.findIndex(g => String(g.game_id) === String(gameId))
    if (fromIdx <= 0) return
    const newOrder = sorted.map(g => g.game_id)
    const [moved] = newOrder.splice(fromIdx, 1)
    newOrder.unshift(moved)
    try {
      await api.put(`${API_BASE}/user/${user.username}/backlog-reorder`, { order: newOrder })
      const res = await api.get(`${API_BASE}/user/${user.username}/games?t=${Date.now()}`)
      setUserGames(res.data)
      setCurrentPage(1)
      showToast('success', `Moved to top of backlog.`)
    } catch (err) {
      showToast('error', 'Failed to move game to top.')
    }
  }

  // Refresh metadata for a single game
  const refreshGameMetadata = async (game) => {
    if (!user) return
    const id = game.game_id
    setRefreshingGameIds(prev => ({ ...prev, [id]: true }))
    try {
      await api.post(`${API_BASE}/user/${user.username}/games/${id}/refresh-metadata`)

      // Refresh the library data after successful metadata refresh for this game
      const timestamp = Date.now()
      const gamesRes = await api.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
      setUserGames(gamesRes.data)

      showToast('success', `Metadata refreshed for "${game.game_name}".`)
    } catch (err) {
      const errorMsg = err.response?.data?.error || 'Failed to refresh metadata for this game. Please try again.'
      showToast('error', errorMsg)
    }
    setRefreshingGameIds(prev => ({ ...prev, [id]: false }))
  }

  const handleSortClick = (value) => {
    if (sortBy === value) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(value)
      setSortDir('asc')
    }
  }

  // Refresh metadata for all games
  const refreshMetadata = async () => {
    if (!user) return
    setRefreshingMetadata(true)
    setRefreshMetadataResult(null)
    try {
      const res = await api.post(`${API_BASE}/user/${user.username}/refresh-metadata`, null, {
        timeout: 300000 // 5 minutes for bulk refresh (many games = many API calls)
      })
      setRefreshMetadataResult(res.data)
      showToast('success', `Metadata refreshed! ${res.data.results.updated} games updated.`)
      
      // Refresh the library data after successful metadata refresh
      const timestamp = Date.now()
      const gamesRes = await api.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
      setUserGames(gamesRes.data)
    } catch (err) {
      const errorMsg =
        err.response?.data?.error ||
        (err.code === 'ECONNABORTED' ? 'Refresh timed out. Try again or refresh fewer games.' : err.message) ||
        'Failed to refresh metadata. Please try again.'
      showToast('error', errorMsg)
    }
    setRefreshingMetadata(false)
  }

  const sortOptions = [
    { label: 'Name', value: 'name' },
    { label: 'Release Date', value: 'release' },
    { label: 'Status', value: 'status' },
  ]

  return (
    <div className="user-games-section">
      <div className="library-header">
        {/* No count while loading or after a failure: "(0)" is the same false claim
            as the empty state, just smaller. An unknown count shows nothing. */}
        <h2 className="library-title">My Library{loading || loadError ? '' : ` (${userGames.length})`}</h2>
        <div className="view-controls library-view-controls">
          <button
            className={`toggle-feature-btn${showPrices ? ' toggle-feature-btn--active' : ''}`}
            onClick={() => setShowPrices(v => !v)}
            aria-pressed={showPrices}
          >
            {showPrices ? 'Hide Prices' : 'Show Prices'}
          </button>
          <button
            className={`toggle-feature-btn${showCrackStatus ? ' toggle-feature-btn--active' : ''}`}
            onClick={() => setShowCrackStatus(v => !v)}
            aria-pressed={showCrackStatus}
            title="Show crack status from CrackWatch (green = cracked, red = not cracked)"
          >
            {showCrackStatus ? 'Hide crack status' : 'Show crack status'}
          </button>
          <div className="view-toggle">
            <button onClick={() => setViewMode('grid')} className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`} aria-label="Grid view" aria-pressed={viewMode === 'grid'}><FaTh /></button>
            <button onClick={() => setViewMode('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} aria-label="List view" aria-pressed={viewMode === 'list'}><FaList /></button>
          </div>
        </div>
      </div>
      {userGames.length > 0 && (
        <div className="library-stats-bar">
          <button type="button" className="stats-chip stats-chip--wishlist" onClick={() => { setFilter('wishlist'); setCurrentPage(1) }} title="Wishlist"
            aria-pressed={filter === 'wishlist'} aria-label={`Wishlist: ${statusCounts.wishlist} — show only these`}>
            <FaHeart aria-hidden="true" /> <span>{statusCounts.wishlist}</span>
          </button>
          <button type="button" className="stats-chip stats-chip--playing" onClick={() => { setFilter('playing'); setCurrentPage(1) }} title="Playing"
            aria-pressed={filter === 'playing'} aria-label={`Playing: ${statusCounts.playing} — show only these`}>
            <FaPlay aria-hidden="true" /> <span>{statusCounts.playing}</span>
          </button>
          <button type="button" className="stats-chip stats-chip--done" onClick={() => { setFilter('done'); setCurrentPage(1) }} title="Done"
            aria-pressed={filter === 'done'} aria-label={`Done: ${statusCounts.done} — show only these`}>
            <FaCheck aria-hidden="true" /> <span>{statusCounts.done}</span>
          </button>
          <button type="button" className="stats-chip stats-chip--backlog" onClick={() => { setFilter('backlog'); setCurrentPage(1) }} title="Backlog"
            aria-pressed={filter === 'backlog'} aria-label={`Backlog: ${statusCounts.backlog} — show only these`}>
            <FaList aria-hidden="true" /> <span>{statusCounts.backlog}</span>
          </button>
          <button type="button" className="stats-chip stats-chip--unreleased" onClick={() => { setFilter('unreleased'); setCurrentPage(1) }} title="Unreleased"
            aria-pressed={filter === 'unreleased'} aria-label={`Unreleased: ${statusCounts.unreleased} — show only these`}>
            <FaLock aria-hidden="true" /> <span>{statusCounts.unreleased}</span>
          </button>
          <button type="button" className="stats-chip stats-chip--total" onClick={() => { setFilter('all'); setCurrentPage(1) }} title="All games"
            aria-pressed={filter === 'all'} aria-label={`${userGames.length} total — show all games`}>
            <FaGamepad aria-hidden="true" /> <span>{userGames.length} total</span>
          </button>
        </div>
      )}
      <div className="library-search-bar">
        <input
          type="text"
          className="library-search-input"
          placeholder="Search your library..."
          value={searchTerm}
          onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
        />
        <button
          className={`refresh-metadata-btn${refreshingMetadata ? ' refresh-metadata-btn--active' : ''}`}
          onClick={refreshMetadata}
          disabled={refreshingMetadata || loading}
          title="Refresh metadata (release date and wallpaper) for all games"
        >
          <FaSync className={refreshingMetadata ? 'spin-icon' : ''} />
          {refreshingMetadata ? 'Refreshing...' : 'Refresh Metadata'}
        </button>
      </div>
      <div className="filter-bar">
        {FILTERS.map(f => (
          <button
            key={f.value}
            className={`filter-btn${filter === f.value ? ' active' : ''}`}
            aria-pressed={filter === f.value}
            onClick={() => { setFilter(f.value); setCurrentPage(1); }}
          >
            {f.label}
            {statusCounts[f.value] > 0 && (
              <span className="filter-count">{statusCounts[f.value]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="sort-bar">
        Sort by:
        {sortOptions.map(opt => (
          <button
            key={opt.value}
            className={`sort-btn${sortBy === opt.value ? ' active' : ''}`}
            onClick={() => handleSortClick(opt.value)}
            aria-label={`Sort by ${opt.label}${sortBy === opt.value ? `, ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`}
            aria-pressed={sortBy === opt.value}
          >
            {opt.label}
            {sortBy === opt.value && (
              <span style={{marginLeft: 4, fontWeight: 700}}>
                {sortDir === 'asc' ? '▲' : '▼'}
              </span>
            )}
          </button>
        ))}
      </div>

      {statusError && <div className="error-msg">{statusError}</div>}
      {removeError && <div className="error-msg">{removeError}</div>}
      {refreshMetadataResult && (
        <div style={{
          padding: '0.8em 1.2em',
          borderRadius: 8,
          background: 'var(--accent-soft)',
          border: '1.5px solid var(--accent-border)',
          color: 'var(--color-accent)',
          marginBottom: '1rem',
          fontSize: '0.95em'
        }}>
          <strong>Metadata refresh completed:</strong> {refreshMetadataResult.results.updated} out of {refreshMetadataResult.results.total} games updated.
        </div>
      )}
      
      {loading ? (
        <div className="games-list">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton-cover" />
              <div className="skeleton-line skeleton-line--med" />
              <div className="skeleton-line skeleton-line--short" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        // Checked BEFORE the empty state, deliberately: the failure is the more
        // specific fact, and telling someone their library is empty when the request
        // failed is worse than saying nothing. It states that the games are still
        // there, because the alarming reading is that they are not.
        // role="alert" because without it this entire fix is silent to a screen
        // reader — the failure would be conveyed only by pixels, to the one user who
        // cannot see them. ToastContext.jsx already establishes the pattern.
        <div className="empty-state" role="alert">
          <FaExclamationCircle className="empty-state-icon empty-state-icon--error" aria-hidden="true" />
          <p className="empty-state-title">Couldn&apos;t load your library</p>
          <p className="empty-state-sub">
            {/* Reassurance FIRST: "are my games gone" is the actual worry. The second
                sentence reports what happened WITHOUT asserting a cause nothing
                checked — a 500 is the server responding, not failing to. */}
            Your games are safe — nothing in your library has changed.{' '}
            {loadError.responded
              ? `The server returned an error${loadError.status ? ` (${loadError.status})` : ''}.`
              : 'The server didn’t respond.'}
          </p>
          <button
            type="button"
            className="retry-btn"
            onClick={retryFetchGames}
            disabled={retrying}
          >
            <FaSync className={retrying ? 'spin' : ''} aria-hidden="true" />
            {retrying ? ' Retrying…' : ' Try again'}
          </button>
        </div>
      ) : filteredUserGames.length === 0 ? (
        <div className="empty-state">
          {userGames.length === 0 ? (
            <>
              <FaGamepad className="empty-state-icon" />
              <p className="empty-state-title">Your library is empty</p>
              <p className="empty-state-sub">Search for games and add them to get started.</p>
            </>
          ) : (
            <>
              <FaSearch className="empty-state-icon" />
              <p className="empty-state-title">No games match this filter</p>
              <p className="empty-state-sub">Try a different status or clear your search.</p>
              <button className="filter-btn active" style={{marginTop:'0.5rem'}} onClick={() => { setFilter('all'); setSearchTerm('') }}>
                Show all games
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          {filter === 'backlog' && (
            <span id="backlog-reorder-hint" className="visually-hidden">
              Press Enter or Space to pick this game up, then on another game to move it there. Escape cancels.
            </span>
          )}
          {filter === 'backlog' && (
            <div aria-live="polite" aria-atomic="true" className="visually-hidden">
              {keyboardDragId
                ? `Selected game for reordering. Press Enter on another game to move it there, or Escape to cancel.`
                : ''}
            </div>
          )}
          <div key={`${filter}-${currentPage}`} ref={gamesListRef} tabIndex={-1} role="region" aria-label="Your games"
            className={`games-list ${viewMode === 'list' ? 'list-view' : ''}${isDraggingAny ? ' backlog-drag-active' : ''}`}>
            {currentGames.map((game, index) => {
              const isUnreleased = isGameUnreleased(game);
              const effectiveCrackStatus = game.crackStatus || crackStatusMap[game.game_id] || 'unknown';
              const isDragging  = filter === 'backlog' && String(draggedGameId) === String(game.game_id);
              const isDragOver  = filter === 'backlog' && String(dragOverGameId) === String(game.game_id);
              const isKbSelected = filter === 'backlog' && String(keyboardDragId) === String(game.game_id);
              return (
                <div
                  key={game.game_id}
                  className={`game-card status-${normalizeStatus(game.status)} ${viewMode === 'list' ? 'list-item' : ''}${isDragging ? ' card-dragging' : ''}${isDragOver ? ' card-drag-over' : ''}${isKbSelected ? ' card-keyboard-selected' : ''}`}
                  style={{ animationDelay: `${index * 0.04}s` }}
                  draggable={filter === 'backlog'}
                  // A labelled GROUP (FE-6, UI/UX review): an aria-label on a role-less div is
                  // invalid ARIA and, where honoured, hid the card's date, price and status.
                  // Details open from the TITLE button below, in every view. The card itself
                  // takes focus only in the backlog, where Enter/Space pick up and drop.
                  role="group"
                  aria-labelledby={`lib-title-${index}`}
                  aria-describedby={filter === 'backlog' ? 'backlog-reorder-hint' : undefined}
                  tabIndex={filter === 'backlog' ? 0 : undefined}
                  onClick={(e) => { if (e.target.closest('select,button,a,.status-select-wrapper')) return; setOpenGame(game) }}
                  onDragStart={() => { setDraggedGameId(game.game_id); setIsDraggingAny(true) }}
                  onDragOver={(e) => { if (filter === 'backlog') { e.preventDefault(); setDragOverGameId(game.game_id); } }}
                  onDrop={() => handleBacklogDrop(game.game_id)}
                  onDragEnd={() => { setDraggedGameId(null); setDragOverGameId(null); setIsDraggingAny(false) }}
                  onKeyDown={filter !== 'backlog' ? undefined : (e) => {
                    // Escape cancels a held card from ANYWHERE in it — including its title
                    // button or status select — so it comes before the guard below.
                    if (e.key === 'Escape') { setKeyboardDragId(null); return }
                    // Enter/Space on a control INSIDE the card (the status select, the
                    // title button) must do that control's job, not pick the card up.
                    if (e.target !== e.currentTarget) return
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault()
                      if (!keyboardDragId) {
                        setKeyboardDragId(game.game_id)
                      } else if (String(keyboardDragId) !== String(game.game_id)) {
                        handleBacklogDrop(game.game_id)
                        setKeyboardDragId(null)
                      }
                    }
                  }}
                >
                  {filter === 'backlog' && game.backlog_order != null && (
                    <div className="backlog-position-badge">#{game.backlog_order}</div>
                  )}
                  {filter === 'backlog' && viewMode === 'grid' && (
                    <div className="drag-handle" title="Drag to reorder"><FaGripVertical /></div>
                  )}
                  {showCrackStatus && (
                    <span
                      className={`crack-status-dot crack-status-dot--${effectiveCrackStatus}`}
                      title={
                        effectiveCrackStatus === 'cracked'
                          ? 'Cracked'
                          : effectiveCrackStatus === 'uncracked'
                            ? 'Not cracked'
                            : 'Unknown'
                      }
                      aria-hidden
                    />
                  )}
                  <div className="game-cover-container">
                    {game.cover_url ? (
                      <img src={game.cover_url} alt={game.game_name} className="game-cover" loading="lazy" decoding="async" onLoad={(e) => e.currentTarget.classList.add('cover-loaded')} />
                    ) : (
                      <div className="cover-placeholder">
                        <FaGamepad className="cover-placeholder-icon" />
                        <span className="cover-placeholder-name">{game.game_name}</span>
                      </div>
                    )}
                  </div>
                  <div className="game-info">
                    <div>
                      <div className="game-title">
                        {/* THE way to the details from the keyboard, in every view — including
                            the backlog, where Enter on the card reorders instead. A real
                            button also activates Space on key-UP natively, so the dialog can
                            no longer be opened and immediately closed by one Space press. */}
                        <button type="button" id={`lib-title-${index}`} className="game-title-btn"
                          onClick={(e) => { e.stopPropagation(); setOpenGame(game) }}>
                          {game.game_name}
                        </button>
                      </div>
                      <div className="game-release-date">Release: {game.release_date ? game.release_date : 'Unreleased'}</div>
                      {/* HOW LONG THIS GAME TOOK, on the card. The event log is the only
                          place that knows; the library row carries a status but never a
                          date for when it changed.

                          Rendered ONLY when there is a real measurement. A finished game
                          that never passed through `playing`, or one already in progress
                          before tracking began, has no duration — and the card shows
                          nothing at all rather than a 0 that would read as "finished the
                          same day". Absent is honest; zero is a claim. */}
                      {(() => {
                        const st = normalizeStatus(game.status)
                        const t = st === 'done' ? gameTimings.done[game.game_id]
                          : st === 'playing' ? gameTimings.playing[game.game_id]
                            : null
                        if (!t || t.days == null) {
                          // Hold the space while the measurement is still unknown; once
                          // it is known to be absent, collapse it in the SAME commit that
                          // fills the others, so the row settles once instead of twice.
                          return (st === 'done' || st === 'playing') && !timingsLoaded
                            ? <div className="game-timing game-timing--pending" aria-hidden="true"><span>&nbsp;</span></div>
                            : null
                        }
                        const short = formatDurationShort(t.days)
                        const long = formatDurationLong(t.days)
                        return st === 'done' ? (
                          <div className="game-timing game-timing--done"
                            title={`Took ${long} — started ${formatDateReadable(t.startedAt)}, finished ${formatDateReadable(t.finishedAt)}`}>
                            <FaHourglassHalf aria-hidden="true" />
                            <span>Took {short}</span>
                          </div>
                        ) : (
                          <div className="game-timing game-timing--playing"
                            title={`Playing for ${long} — started ${formatDateReadable(t.startedAt)}`}>
                            <FaPlay aria-hidden="true" />
                            <span>Playing {short}</span>
                          </div>
                        )
                      })()}
                      {showPrices && (
                        <div className="game-price" style={{ margin: '0.5em 0', color: 'var(--color-fg-muted)', fontWeight: 400, fontSize: '0.98em', letterSpacing: 0.1, lineHeight: 1.2 }}>
                          {game.last_price ? (
                            <>
                              Price: {game.last_price}
                              {game.last_price_updated && (
                                <span style={{ fontSize: '0.85em', color: 'var(--color-fg-subtle)', marginLeft: 8 }}>
                                  (updated {new Date(game.last_price_updated).toLocaleDateString()})
                                </span>
                              )}
                            </>
                          ) : game.steamAppId ? (
                            gamePrices[game.game_id]?.loading ? 'Price: ...'
                            : gamePrices[game.game_id]?.price ? `Price: ${gamePrices[game.game_id].price}`
                            : 'Price: Not found'
                          ) : 'Price: N/A'}
                        </div>
                      )}
                    </div>
                    <div className="game-card-actions">
                      {isUnreleased ? (
                        <div className="unreleased-indicator">
                          <FaLock /> Unreleased
                        </div>
                      ) : (
                        <div className="status-select-wrapper" onClick={(e) => e.stopPropagation()}>
                          <span className={`status-dot status-dot--${normalizeStatus(game.status)}`} aria-hidden="true" />
                          <select
                            className="status-select"
                            aria-label={`Status for ${game.game_name}`}
                            value={normalizeStatus(game.status)}
                            onChange={(e) => {
                              e.stopPropagation();
                              setGameStatus(game, e.target.value);
                            }}
                          >
                            {STATUSES.map(status => (
                              <option key={status} value={status}>{status}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {filter === 'backlog' && game.backlog_order !== 1 && (
                        <button
                          className="remove-btn-icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveToTopOfBacklog(game.game_id);
                          }}
                          title="Move to top of backlog"
                          aria-label={`Move ${game.game_name} to the top of the backlog`}
                        >
                          <FaArrowUp />
                        </button>
                      )}
                      <button
                        className="remove-btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshGameMetadata(game);
                        }}
                        disabled={!!refreshingGameIds[game.game_id]}
                        title="Refresh metadata for this game"
                        aria-label={`Refresh metadata for ${game.game_name}`}
                      >
                        <FaSync style={{ animation: refreshingGameIds[game.game_id] ? 'spin 1s linear infinite' : 'none' }} />
                      </button>
                      <button
                        className="remove-btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeGame(game.game_id);
                        }}
                        title="Remove game (undo available)"
                        aria-label={`Remove ${game.game_name}`}
                      >
                        <FaTrash />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          
          {/* Pagination Controls */}
          <div className="pagination-controls">
            <button 
              className="pagination-btn" 
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
            >
              Previous
            </button>
            <span className="pagination-info">
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="pagination-btn"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
            >
              Next
            </button>
          </div>
        </>
      )}
      {/* `username` is what turns the history on. The SEARCH page renders this same modal
          for games that are not in the library yet — those have no history by definition,
          so it deliberately passes none and the section never appears. */}
      <GameDetailModal
        game={modalGame}
        onClose={() => setOpenGame(null)}
        onSetStatus={setGameStatus}
        onRemove={(g) => removeGame(g.game_id)}
        username={user?.username}
        fallbackFocusRef={gamesListRef}
      />
    </div>
  )
}

// formatDateLocal moved to ./dateUtils so the calendar and the statistics page
// cannot disagree about which local day an instant belongs to.

function CalendarPage({ user }) {
  const [userGames, setUserGames] = useState([]);
  // Same defect as the library page had, on the same endpoint: a failed load rendered
  // an empty month with no releases marked, indistinguishable from "nothing is coming
  // out", plus an unhandled rejection. Fixing one of two instances would have left the
  // identical lie one nav click away.
  const [loadError, setLoadError] = useState(false);
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() };
  });

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoadError(false);
    api.get(`${API_BASE}/user/${user.username}/games`).then(res => {
      if (cancelled) return;
      if (!Array.isArray(res.data)) throw new Error('unexpected library response');
      setUserGames(res.data);
    }).catch(() => {
      if (cancelled) return;
      setUserGames([]);
      setLoadError(true);
    });
    return () => { cancelled = true; };
  }, [user]);

  // Build a map of release dates to games
  const dateMap = {};
  userGames.forEach(game => {
    if (game.release_date) {
      dateMap[game.release_date] = dateMap[game.release_date] || [];
      dateMap[game.release_date].push(game);
    }
  });

  // Calendar grid for selected month
  const year = month?.year ?? new Date().getFullYear();
  const m = month?.month ?? new Date().getMonth();
  const firstDay = new Date(year, m, 1);
  const startDay = firstDay.getDay();

  // Build a 6-row (max) calendar grid (7 days per week)
  const calendarCells = [];
  let dayNum = 1 - startDay;
  for (let week = 0; week < 6; week++) {
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(year, m, dayNum);
      calendarCells.push(cellDate);
      dayNum++;
    }
  }

  const today = new Date();
  const isToday = (date) =>
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  const isCurrentMonth = (date) => date.getMonth() === m && date.getFullYear() === year;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const handlePrevMonth = () => {
    setMonth(prev => {
      let newMonth = prev.month - 1;
      let newYear = prev.year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      }
      return { year: newYear, month: newMonth };
    });
  };
  const handleNextMonth = () => {
    setMonth(prev => {
      let newMonth = prev.month + 1;
      let newYear = prev.year;
      if (newMonth > 11) {
        newMonth = 0;
        newYear++;
      }
      return { year: newYear, month: newMonth };
    });
  };

  return (
    <div className="calendar-section">
      <div className="calendar-header">
        <button className="calendar-nav-btn" onClick={handlePrevMonth}>&lt;</button>
        <span className="calendar-month-label">{monthNames[m]} {year}</span>
        <button className="calendar-nav-btn" onClick={handleNextMonth}>&gt;</button>
      </div>
      {/* An empty calendar and an unreachable server look the same. Say which. */}
      {loadError && (
        <p className="calendar-load-error" role="alert">
          <FaExclamationCircle aria-hidden="true" /> Couldn&apos;t load your games — release
          dates below are incomplete. Your library is unchanged.
        </p>
      )}
      <div className="calendar-grid calendar-grid-full">
        {weekdayNames.map((wd) => (
          <div key={wd} className="calendar-cell calendar-weekday">{wd}</div>
        ))}
        {calendarCells.map((date, idx) => {
          const dateStr = formatDateLocal(date);
          const games = dateMap[dateStr] || [];
          return (
            <div
              key={idx}
              className={`calendar-cell${isCurrentMonth(date) ? '' : ' calendar-other-month'}${isToday(date) ? ' calendar-today' : ''}`}
            >
              <div className="calendar-date">{date.getDate()}</div>
              {games.length > 0 && (
                <div className="calendar-games-list">
                  {games.slice(0, 2).map(game => (
                    <div key={game.game_id} className="calendar-game-title-small">{game.game_name}</div>
                  ))}
                  {games.length > 2 && (
                    <div className="calendar-overflow-badge">+{games.length - 2} more</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

// ── AccountPage (all users) ─────────────────────────────────────────────────
const NOTIF_DAY_OPTIONS = [
  { days: 0,  label: 'On release day' },
  { days: 3,  label: '3 days before' },
  { days: 7,  label: '7 days before' },
  { days: 14, label: '14 days before' },
  { days: 30, label: '30 days before' },
  { days: 60, label: '60 days before' },
]

function AccountPage({ user }) {

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

// ── SystemStatusPage ────────────────────────────────────────────────────────
function SystemStatusPage() {
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
function SettingsPage() {
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

export default App
// Exported for its component tests (src/LoginPage.test.jsx) — not a second entry point.
export { LoginPage }
