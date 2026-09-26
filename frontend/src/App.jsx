import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom'
import './App.css'
import { FaSearch, FaBook, FaUsers, FaSignOutAlt, FaCog, FaRegCalendarAlt, FaShareAlt, FaExpand, FaCompress, FaUser, FaServer, FaCode, FaChartBar } from 'react-icons/fa'
import { useToast } from './contexts/ToastContext'
import SharedLibrary from './SharedLibrary'
import StatsPage from './StatsPage'
import UserManagementPage from './pages/UserManagementPage'
import SystemStatusPage from './pages/SystemStatusPage'
import SettingsPage from './pages/SettingsPage'
import SearchPage from './pages/SearchPage'
import LibraryPage from './pages/LibraryPage'
import CalendarPage from './pages/CalendarPage'
import AccountPage from './pages/AccountPage'
import {
  msUntilExpiry, endSession, sessionFromView, setSession, writeHint, readHint, dropLegacyToken,
  markSignInUpdated, clearSignInUpdated, onSessionAnnounced,
} from './session'
import { probeSession } from './api'
import LoginPage from './pages/LoginPage'
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

// ${window.location.protocol} ${window.location.hostname}
// The session is an HttpOnly cookie this page cannot read (SEC-14), so who is signed in is
// the SERVER's answer: GET /api/auth/session, asked once at boot. Until it answers, the app
// shows neither the login page nor the library -- a flash of either would be a lie.
//
// Three outcomes, and the difference between the last two is the whole point of the
// loading state (sign-off condition 16):
//   200          -> signed in;
//   401          -> signed out. The "session ended" notice shows only when this browser
//                   knew of a session that has since EXPIRED (the hint); otherwise nobody
//                   was signed in and the login page says nothing;
//   anything else -> the server could not answer. That is NOT "signed out": an outage
//                   rendered as the login page, or as an empty library, is how a user once
//                   concluded their games had been deleted. It gets its own screen.
function useAuth() {
  const [state, setState] = useState({ status: 'loading', user: null })
  const probe = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }))
    return probeSession()
      .then((view) => {
        const session = setSession(sessionFromView(view))
        writeHint(session)
        clearSignInUpdated()   // signed in already: the "updated" line must not surface later
        setState({ status: 'ready', user: session })
      })
      .catch((err) => {
        if (err?.response?.status === 401) {
          const hint = readHint()
          const expired = !!hint && typeof hint.exp === 'number' && hint.exp * 1000 <= Date.now()
          endSession({ explain: expired, fromPath: window.location.pathname, announce: false, logout: false })
          setState({ status: 'ready', user: null })
        } else {
          setState({ status: 'unreachable', user: null })
        }
      })
  }, [])
  useEffect(() => {
    // The pre-SEC-14 token in localStorage: removed, and the login page says so once.
    if (dropLegacyToken()) markSignInUpdated()
    probe()
  }, [probe])
  const setUser = useCallback((user) => setState({ status: 'ready', user }), [])
  return [state, setUser, probe]
}

function App() {
  const [auth, setUser, probe] = useAuth()
  const user = auth.user
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
  //
  // No server logout and no announcement (CISO review): the cookie's Max-Age follows the
  // same exp, so when this fires the browser has already dropped it -- the only cookie a
  // logout could carry is a NEWER one another tab obtained, and a laptop waking up with a
  // late timer would clear it. Every tab runs its own timer on the server's expiresIn.
  const expireSession = useCallback(() => {
    endSession({ explain: true, fromPath: window.location.pathname, announce: false, logout: false })
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
    // The SERVER's expiresIn, not this device's clock (condition 17): a clock running hours
    // fast used to read a fresh session as expired.
    const ms = msUntilExpiry(user)
    if (ms === null) { expireSession(); return undefined }
    const WARN_AHEAD_MS = 2 * 60 * 1000
    // setTimeout overflows past ~24.8 days and fires at once; a 12-hour token never gets
    // near that, but a clamp costs nothing. A timer delayed by a suspended laptop or a
    // background tab fires late, not never — and until it does, the 401 interceptor is
    // the backstop for any request made on the expired token.
    //
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

  // Other tabs (condition 18). A sign-out elsewhere ends this tab's session too; a sign-in
  // elsewhere is re-asked of the server, and a DIFFERENT user reloads the page rather than
  // leave one account's data on screen under another's session.
  useEffect(() => onSessionAnnounced((msg) => {
    if (msg.type === 'logout') {
      if (!user) return
      endSession({ explain: false, announce: false, logout: false })
      setUser(null)
      navigate('/login')
    } else if (msg.type === 'login') {
      if (user && msg.username && msg.username.toLowerCase() !== user.username.toLowerCase()) {
        window.location.reload()
      } else if (!user) {
        probe()
      }
    }
  }), [user, setUser, navigate, probe])

  if (auth.status === 'loading') {
    return (
      <div className="login-page">
        <div className="login-form app-boot" role="status" aria-live="polite">
          <h1 className="login-wordmark-title">GameTracker</h1>
          <p className="app-boot-text">Loading…</p>
        </div>
      </div>
    )
  }
  if (auth.status === 'unreachable') {
    return (
      <div className="login-page">
        <div className="login-form app-boot" role="alert">
          <h1 className="login-wordmark-title">GameTracker</h1>
          <p className="app-boot-text">Can&apos;t reach the server. Your library is unchanged.</p>
          <button type="button" className="app-boot-retry" onClick={probe} autoFocus>Retry</button>
        </div>
      </div>
    )
  }

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

export default App
