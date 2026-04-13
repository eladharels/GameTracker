import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, Navigate, useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import './App.css'
import { FaSearch, FaBook, FaUsers, FaSignOutAlt, FaLock, FaSortAlphaDown, FaSortNumericDown, FaSortAmountDown, FaCog, FaEnvelope, FaBell, FaCheckCircle, FaRegCalendarAlt, FaArrowLeft, FaPlay, FaHeart, FaEye, FaCheck, FaTh, FaList, FaTrash, FaExclamationCircle, FaShareAlt, FaSync, FaArrowUp, FaArrowDown, FaGamepad, FaGripVertical, FaExpand, FaCompress, FaUser, FaTelegram } from 'react-icons/fa'
import { useToast } from './contexts/ToastContext'
import SharedLibrary from '../SharedLibrary'

const ACCENT_PRESETS = [
  { name: 'Sky',    value: '#0ea5e9' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Green',  value: '#22c55e' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Pink',   value: '#ec4899' },
]

// Dynamic API base URL: always hit the current origin's /api
const API_BASE = `${window.location.origin}/api`;

const STATUSES = ['wishlist', 'playing', 'done', 'backlog']

// Helper function to normalize status values
function normalizeStatus(status) {
  if (!status) return 'wishlist';
  return status.toLowerCase();
}

// ${window.location.protocol} ${window.location.hostname}
function useAuth() {
  const [user, setUser] = useState(null)
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]))
        setUser(payload)
      } catch {
        setUser(null)
      }
    } else {
      setUser(null)
    }
  }, [])
  return [user, setUser]
}

function App() {
  const [user, setUser] = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [accentColor, setAccentColor] = useState(
    () => localStorage.getItem('accent_color') || '#0ea5e9'
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
  const logout = () => {
    localStorage.removeItem('token')
    setUser(null)
    navigate('/login')
  }

  // Determine page title
  let pageTitle = ''
  if (location.pathname.startsWith('/search')) pageTitle = 'Search Games'
  else if (location.pathname.startsWith('/library')) pageTitle = 'My Library'
  else if (location.pathname.startsWith('/calendar')) pageTitle = 'Calendar'
  else if (location.pathname.startsWith('/users')) pageTitle = 'User Management'
  else if (location.pathname.startsWith('/settings')) pageTitle = 'Settings'
  else if (location.pathname.startsWith('/account')) pageTitle = 'My Account'
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
          {(user.can_manage_users || user.can_create_users) && (
            <Link to="/users" className={location.pathname === '/users' ? 'active' : ''}>
              <FaUsers className="nav-icon" />
              <span className="nav-label">User Management</span>
            </Link>
          )}
          <Link to="/account" className={location.pathname === '/account' ? 'active' : ''}>
            <FaUser className="nav-icon" />
            <span className="nav-label">My Account</span>
          </Link>
          {user.can_manage_users && (
            <Link to="/settings" className={location.pathname === '/settings' ? 'active' : ''}>
              <FaCog className="nav-icon" />
              <span className="nav-label">Settings</span>
            </Link>
          )}
          <button className="logout-btn" onClick={logout}>
            <FaSignOutAlt className="nav-icon" />
            <span className="nav-label">Logout</span>
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
              />
            ))}
          </div>
        </nav>
      </aside>
      <main className="main-content">
        {pageTitle && <div className="page-title">{pageTitle}</div>}
        <Routes>
          <Route path="/search" element={<SearchPage user={user} />} />
          <Route path="/library" element={<LibraryPage user={user} />} />
          <Route path="/shared-library" element={<SharedLibrary />} />
          <Route path="/calendar" element={<CalendarPage user={user} />} />
          <Route path="/users" element={<UserManagementPage user={user} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/account" element={<AccountPage />} />
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

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    
    // Client-side validation to prevent empty credentials
    if (!username.trim() || !password.trim()) {
      setError('Username and password are required')
      return
    }
    
    try {
      // Convert username to lowercase to prevent case sensitivity issues
      const normalizedUsername = username.toLowerCase()
      const res = await axios.post(`${API_BASE}/auth/login`, { username: normalizedUsername, password })
      localStorage.setItem('token', res.data.token)
      const payload = JSON.parse(atob(res.data.token.split('.')[1]))
      setUser(payload)
      navigate('/search')
    } catch (err) {
      setError('Invalid username or password')
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleLogin}>
        <h2>Login</h2>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          onBlur={e => setUsername(e.target.value.toLowerCase())}
          autoFocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        <button type="submit">Login</button>
        {error && <div className="error-msg">{error}</div>}
      </form>
    </div>
  )
}

function UserManagementPage({ user }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newUser, setNewUser] = useState({ username: '', password: '', can_manage_users: false })
  const [success, setSuccess] = useState('')
  const [ldapSyncLoading, setLdapSyncLoading] = useState(false)
  const token = localStorage.getItem('token')
  const [formError, setFormError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const modalRef = useRef()
  const navigate = useNavigate()

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await axios.get(`${API_BASE}/users`, { headers: { Authorization: `Bearer ${token}` } })
      setUsers(res.data)
      setLoading(false)
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        // Token expired or invalid, log out
        localStorage.removeItem('token');
        setUser(null);
        navigate('/login');
      } else {
        setError('Failed to load users')
      }
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
      await axios.post(`${API_BASE}/users`, newUser, { headers: { Authorization: `Bearer ${token}` } })
      setSuccess('User created!')
      setNewUser({ username: '', password: '', can_manage_users: false })
      fetchUsers()
    } catch (err) {
      setError('Failed to create user')
    }
  }
  const handleDelete = async (id) => {
    if (!window.confirm('Delete this user?')) return
    setError('')
    setSuccess('')
    try {
      await axios.delete(`${API_BASE}/users/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      setSuccess('User deleted!')
      fetchUsers()
    } catch (err) {
      setError('Failed to delete user')
    }
  }
  const handleEdit = async (id, updates) => {
    setError('')
    setSuccess('')
    try {
      await axios.put(`${API_BASE}/users/${id}`, updates, { headers: { Authorization: `Bearer ${token}` } })
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
      const response = await axios.post(`${API_BASE}/admin/ldap-sync`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      })
      
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

  // Modal close on ESC or background click
  useEffect(() => {
    if (!modalOpen) return;
    function onKey(e) { if (e.key === 'Escape') setModalOpen(false); }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen])

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
            style={{
              backgroundColor: ldapSyncLoading ? '#ccc' : '#28a745',
              color: 'white',
              padding: '8px 16px',
              border: 'none',
              borderRadius: '4px',
              cursor: ldapSyncLoading ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
              marginRight: '10px'
            }}
          >
            {ldapSyncLoading ? (
              <>
                <span style={{marginRight: '6px'}}>⏳</span>
                Syncing...
              </>
            ) : (
              <>
                <span style={{marginRight: '6px'}}>🔄</span>
                Sync LDAP Users
              </>
            )}
          </button>
          <button className="add-user-btn" onClick={() => setModalOpen(true)}>Add User</button>
        </div>
      </div>
      {modalOpen && (
        <div className="user-modal-bg" ref={modalRef} onClick={handleModalBgClick} tabIndex={-1} aria-modal="true" role="dialog">
          <div className="user-modal-window">
            <button className="user-modal-close" aria-label="Close" onClick={() => setModalOpen(false)}>&times;</button>
            <form className="user-form-modern user-form-vertical user-form-enhanced" onSubmit={handleCreate} autoFocus>
              <div className="user-form-group">
                <label>Username
                  <input
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
                      <button className="icon-btn enhanced-icon-btn" title="Change Password" aria-label="Change Password" onClick={() => handleEdit(u.id, { password: prompt('New password:') })}><FaLock /></button>
                      <button className="icon-btn enhanced-icon-btn" title="Delete User" aria-label="Delete User" onClick={() => handleDelete(u.id)} disabled={u.username === 'root'}><FaTrash /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
  const navigate = useNavigate()
  const { showToast } = useToast();

  // Fetch price for a game by Steam App ID
  const fetchGamePrice = async (gameId, steamAppId) => {
    setGamePrices(prev => ({ ...prev, [gameId]: { loading: true } }))
    try {
      const res = await axios.get(`${API_BASE}/game-price/${steamAppId}`)
      setGamePrices(prev => ({ ...prev, [gameId]: { price: res.data.price, loading: false } }))
    } catch (err) {
      setGamePrices(prev => ({ ...prev, [gameId]: { price: null, loading: false, error: true } }))
    }
  }

  // Search games
  const handleSearch = async (e) => {
    e.preventDefault()
    if (!search) return
    setLoading(true)
    setSearchError('')
    try {
      const res = await axios.get(`${API_BASE}/games/search?q=${encodeURIComponent(search)}`)
      // Ensure res.data is an array
      const results = Array.isArray(res.data) ? res.data : []
      setSearchResults(results)
      // Fetch price for games with a Steam App ID
      results.forEach(game => {
        if (game.steamAppId) {
          fetchGamePrice(game.id, game.steamAppId)
        }
      })
      if (results.length === 0) {
        setSearchError('No games found. Try a different search term.')
      }
    } catch (err) {
      console.error('Search error:', err)
      setSearchResults([])
      const errorMsg = err.response?.data?.error || err.message || 'Failed to search games. Please try again.'
      setSearchError(errorMsg)
      showToast('error', errorMsg)
    }
    setLoading(false)
  }

  // Add to library
  const addToLibrary = async (game, unreleased = false) => {
    if (!user) {
      showToast('error', 'You must be logged in to add games.');
      return;
    }
    try {
      // Check for duplicate
      const res = await axios.get(`${API_BASE}/user/${user.username}/games`);
      const alreadyInLibrary = res.data.some(g => {
        const gId = g.gameId || g.game_id;
        const gName = (g.gameName || g.game_name || '').trim().toLowerCase();
        const gameId = game.id || game.game_id;
        const gameName = (game.name || game.game_name || '').trim().toLowerCase();
        return gId === gameId || gName === gameName;
      });
      if (alreadyInLibrary) {
        showToast('error', 'You already have this game in your library!');
        return;
      }
      await axios.post(`${API_BASE}/user/${user.username}/games`, {
        gameId: game.id,
        gameName: game.name,
        coverUrl: game.coverUrl,
        releaseDate: game.releaseDate,
        status: (!game.releaseDate || unreleased) ? 'unreleased' : 'wishlist',
        steamAppId: game.steamAppId || null,
      })
      showToast('success', `Added ${game.name} to your library!`);
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
            <button onClick={() => setViewMode('grid')} className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}><FaTh /></button>
            <button onClick={() => setViewMode('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}><FaList /></button>
          </div>
        </div>
      </div>
      {loading && <p>Searching...</p>}
      {searchError && <div className="error-msg">{searchError}</div>}
      {searchResults.length > 0 && (
        <>
          <h2>Search Results</h2>
          <div className={`games-list ${viewMode === 'list' ? 'list-view' : 'grid-view'}`}>
            {searchResults.map(game => {
              // Determine if unreleased
              let unreleased = false;
              if (!game.releaseDate) {
                unreleased = true;
              } else {
                const today = new Date();
                const release = new Date(game.releaseDate);
                unreleased = release > today;
              }
              // Price display logic
              let priceDisplay = 'Price: N/A';
              if (game.steamAppId) {
                const priceInfo = gamePrices[game.id];
                if (priceInfo?.loading) priceDisplay = 'Price: ...';
                else if (priceInfo?.price) priceDisplay = `Price: ${priceInfo.price}`;
                else if (priceInfo && priceInfo.price === null) priceDisplay = 'Price: Not found';
              }
              return (
                <div key={game.id} className={`game-card ${viewMode === 'list' ? 'list-item' : ''}`} style={{ animationDelay: `${searchResults.indexOf(game) * 0.04}s` }}>
                  <div className="game-cover-container">
                    {game.coverUrl ? (
                      <img src={game.coverUrl} alt={game.name} className="game-cover" />
                    ) : (
                      <div className="cover-placeholder">
                        <FaGamepad className="cover-placeholder-icon" />
                        <span className="cover-placeholder-name">{game.name}</span>
                      </div>
                    )}
                  </div>
                  <div className="game-info">
                    <div className="game-title">{game.name}</div>
                    <div className="game-release-date">
                      Release: {game.releaseDate ? game.releaseDate : 'Unreleased'}
                      {unreleased && <span className="unreleased-pill">Unreleased</span>}
                    </div>
                    <div className="game-price" style={{ margin: '0.5em 0', color: '#0ea5e9', fontWeight: 600 }}>{priceDisplay}</div>
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
    </div>
  )
}

function LibraryPage({ user }) {
  const [userGames, setUserGames] = useState([])
  const [loading, setLoading] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
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
  const { showToast, dismissToast } = useToast()
  const pendingDeleteRef = useRef({})
  const gamesPerPage = 15

  useEffect(() => {
    if (user) {
      setLoading(true)
      // Add timestamp to prevent caching
      const timestamp = Date.now()
      axios.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`).then(res => {
        setUserGames(res.data)
        setLoading(false)
      })
    } else {
      setUserGames([])
    }
  }, [user])

  const statusCounts = {
    all:        userGames.length,
    wishlist:   userGames.filter(g => normalizeStatus(g.status) === 'wishlist').length,
    playing:    userGames.filter(g => normalizeStatus(g.status) === 'playing').length,
    done:       userGames.filter(g => normalizeStatus(g.status) === 'done').length,
    unreleased: userGames.filter(g => g.status === 'unreleased' || !g.release_date).length,
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
          return game.status === 'unreleased' || !game.release_date;
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

  // Fetch price for a game by Steam App ID
  const fetchGamePrice = async (gameId, steamAppId) => {
    setGamePrices(prev => ({ ...prev, [gameId]: { loading: true } }))
    try {
      const res = await axios.get(`${API_BASE}/game-price/${steamAppId}`)
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
  }, [showPrices, currentGames])

  const fetchCrackStatus = async (game) => {
    try {
      const res = await axios.post(`${API_BASE}/user/${user.username}/games/${game.game_id}/crackrelease-status`)
      setCrackStatusMap(prev => ({ ...prev, [game.game_id]: res.data.status || 'unknown' }))
      setUserGames(prev => prev.map(g => g.game_id === game.game_id ? { ...g, crackStatus: res.data.status } : g))
    } catch (err) {
      setCrackStatusMap(prev => ({ ...prev, [game.game_id]: 'unknown' }))
    }
  }

  // When showCrackStatus is toggled on, fetch crack status for visible games that don't have it yet
  useEffect(() => {
    if (!showCrackStatus || !user) return
    currentGames.forEach(game => {
      const existing = game.crackStatus || crackStatusMap[game.game_id]
      if (!existing) fetchCrackStatus(game)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCrackStatus, currentGames, user])

  // Change status — optimistic update
  const setGameStatus = async (game, status) => {
    if (!user) return alert('Enter a username first!')
    setStatusError('')
    const previousGames = userGames
    setUserGames(prev => prev.map(g =>
      String(g.game_id) === String(game.game_id) ? { ...g, status } : g
    ))
    try {
      await axios.post(`${API_BASE}/user/${user.username}/games`, {
        gameId: game.game_id,
        gameName: game.game_name,
        coverUrl: game.cover_url,
        releaseDate: game.release_date,
        status,
      })
    } catch (err) {
      setUserGames(previousGames)
      showToast('error', 'Failed to update status. Please try again.')
    }
  }

  // Remove game — optimistic with 5-second undo window
  const removeGame = (gameId) => {
    if (!user) return
    setRemoveError('')
    const snapshot = userGames.find(g => String(g.game_id) === String(gameId))
    if (!snapshot) return

    setUserGames(prev => prev.filter(g => String(g.game_id) !== String(gameId)))

    showToast('info', `Removed "${snapshot.game_name}"`, {
      duration: 5300,
      actionLabel: 'Undo',
      onAction: () => {
        if (pendingDeleteRef.current[gameId]) {
          pendingDeleteRef.current[gameId].forEach(t => clearTimeout(t))
          delete pendingDeleteRef.current[gameId]
        }
        setUserGames(prev => {
          const exists = prev.some(g => String(g.game_id) === String(gameId))
          if (exists) return prev
          return [...prev, snapshot].sort((a, b) => (a.backlog_order ?? 9999) - (b.backlog_order ?? 9999))
        })
        showToast('success', `"${snapshot.game_name}" restored.`)
      },
    })

    const deleteTimer = setTimeout(async () => {
      delete pendingDeleteRef.current[gameId]
      try {
        await axios.delete(`${API_BASE}/user/${user.username}/games/${gameId}`)
      } catch (err) {
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
      await axios.put(`${API_BASE}/user/${user.username}/backlog-reorder`, { order: newOrder })
      const res = await axios.get(`${API_BASE}/user/${user.username}/games?t=${Date.now()}`)
      setUserGames(res.data)
    } catch (err) {
      showToast('error', 'Failed to reorder backlog.')
    }
  }

  // Refresh metadata for a single game
  const refreshGameMetadata = async (game) => {
    if (!user) return
    const id = game.game_id
    setRefreshingGameIds(prev => ({ ...prev, [id]: true }))
    try {
      await axios.post(`${API_BASE}/user/${user.username}/games/${id}/refresh-metadata`)

      // Refresh the library data after successful metadata refresh for this game
      const timestamp = Date.now()
      const gamesRes = await axios.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
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
      const res = await axios.post(`${API_BASE}/user/${user.username}/refresh-metadata`, null, {
        timeout: 300000 // 5 minutes for bulk refresh (many games = many API calls)
      })
      setRefreshMetadataResult(res.data)
      showToast('success', `Metadata refreshed! ${res.data.results.updated} games updated.`)
      
      // Refresh the library data after successful metadata refresh
      const timestamp = Date.now()
      const gamesRes = await axios.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
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
        <h2 className="library-title">My Library ({userGames.length})</h2>
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
            title="Show crack status from CrackRelease (green = cracked, red = not cracked)"
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
          <div className="stats-chip stats-chip--wishlist" onClick={() => setFilter('wishlist')} title="Wishlist">
            <FaHeart /> <span>{statusCounts.wishlist}</span>
          </div>
          <div className="stats-chip stats-chip--playing" onClick={() => setFilter('playing')} title="Playing">
            <FaPlay /> <span>{statusCounts.playing}</span>
          </div>
          <div className="stats-chip stats-chip--done" onClick={() => setFilter('done')} title="Done">
            <FaCheck /> <span>{statusCounts.done}</span>
          </div>
          <div className="stats-chip stats-chip--backlog" onClick={() => setFilter('backlog')} title="Backlog">
            <FaList /> <span>{statusCounts.backlog}</span>
          </div>
          <div className="stats-chip stats-chip--unreleased" onClick={() => setFilter('unreleased')} title="Unreleased">
            <FaLock /> <span>{statusCounts.unreleased}</span>
          </div>
          <div className="stats-chip stats-chip--total" onClick={() => setFilter('all')} title="All games">
            <FaGamepad /> <span>{userGames.length} total</span>
          </div>
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
          background: 'rgba(33, 150, 243, 0.1)',
          border: '1.5px solid rgba(33, 150, 243, 0.3)',
          color: '#2196f3',
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
          <div key={`${filter}-${currentPage}`} className={`games-list ${viewMode === 'list' ? 'list-view' : ''}`}>
            {currentGames.map((game, index) => {
              const isUnreleased = game.status === 'unreleased' || !game.release_date;
              const effectiveCrackStatus = game.crackStatus || crackStatusMap[game.game_id] || 'unknown';
              const isDragging  = filter === 'backlog' && String(draggedGameId) === String(game.game_id);
              const isDragOver  = filter === 'backlog' && String(dragOverGameId) === String(game.game_id);
              return (
                <div
                  key={game.game_id}
                  className={`game-card status-${normalizeStatus(game.status)} ${viewMode === 'list' ? 'list-item' : ''}${isDragging ? ' card-dragging' : ''}${isDragOver ? ' card-drag-over' : ''}`}
                  style={{ animationDelay: `${index * 0.04}s` }}
                  draggable={filter === 'backlog'}
                  onDragStart={() => setDraggedGameId(game.game_id)}
                  onDragOver={(e) => { if (filter === 'backlog') { e.preventDefault(); setDragOverGameId(game.game_id); } }}
                  onDrop={() => handleBacklogDrop(game.game_id)}
                  onDragEnd={() => { setDraggedGameId(null); setDragOverGameId(null); }}
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
                      <div className="game-title">{game.game_name}</div>
                      <div className="game-release-date">Release: {game.release_date ? game.release_date : 'Unreleased'}</div>
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
                      <button
                        className="remove-btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshGameMetadata(game);
                        }}
                        disabled={!!refreshingGameIds[game.game_id]}
                        title="Refresh metadata for this game"
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
    </div>
  )
}

// Helper to format date as YYYY-MM-DD in local time
function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function CalendarPage({ user }) {
  const [userGames, setUserGames] = useState([]);
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() };
  });

  useEffect(() => {
    if (user) {
      axios.get(`${API_BASE}/user/${user.username}/games`).then(res => {
        setUserGames(res.data);
      });
    }
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
  const lastDay = new Date(year, m + 1, 0);
  const daysInMonth = lastDay.getDate();
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
      <div className="calendar-grid calendar-grid-full">
        {weekdayNames.map((wd, i) => (
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
                  {games.map(game => (
                    <div key={game.game_id} className="calendar-game-title-small">{game.game_name}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsSection({ icon: Icon, title, description, configured, children }) {
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

function SectionSaveBar({ sectionKey, saving, saveStatus, dirty, onSave, label }) {
  const status = saveStatus[sectionKey]
  return (
    <div className="ent-save-bar">
      <span className={`ent-unsaved-hint${dirty ? ' visible' : ''}`}>
        <FaExclamationCircle /> Unsaved changes
      </span>
      <button
        type="button"
        className={`ent-save-btn${dirty ? ' ent-save-btn--dirty' : ''}${status === 'saved' ? ' ent-save-btn--saved' : ''}${status === 'error' ? ' ent-save-btn--error' : ''}`}
        onClick={onSave}
        disabled={saving[sectionKey]}
      >
        {saving[sectionKey] ? <><FaSync className="ent-spin" /> Saving…</>
          : status === 'saved'  ? <><FaCheckCircle /> Saved</>
          : status === 'error'  ? <><FaExclamationCircle /> Failed — retry</>
          : <>Save {label}</>}
      </button>
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

function AccountPage() {
  const token = localStorage.getItem('token')
  const authH = { headers: { Authorization: `Bearer ${token}` } }

  const [profile, setProfile] = useState({ email: '', ntfy_topic: '', gotify_token: '', telegram_chat_id: '', notification_days: [0, 7, 30] })
  const [saved, setSaved] = useState({})   // { channels: true/null, schedule: true/null }
  const [saving, setSaving] = useState({})
  const [error, setError] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    axios.get(`${API_BASE}/user/me`, authH)
      .then(res => setProfile({
        email:             res.data.email || '',
        ntfy_topic:        res.data.ntfy_topic || '',
        gotify_token:      res.data.gotify_token || '',
        telegram_chat_id:  res.data.telegram_chat_id || '',
        notification_days: Array.isArray(res.data.notification_days) ? res.data.notification_days : [0, 7, 30],
      }))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const saveSection = async (section, body) => {
    setSaving(p => ({ ...p, [section]: true }))
    setError(p => ({ ...p, [section]: null }))
    setSaved(p => ({ ...p, [section]: null }))
    try {
      await axios.put(`${API_BASE}/user/me/settings`, body, authH)
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
              <label className="ent-label">NTFY Topic</label>
              <input className="ent-input" value={profile.ntfy_topic} onChange={e => setProfile(p => ({ ...p, ntfy_topic: e.target.value }))} placeholder="my-gametracker-alerts" />
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
              onClick={() => saveSection('channels', { email: profile.email, ntfy_topic: profile.ntfy_topic, gotify_token: profile.gotify_token, telegram_chat_id: profile.telegram_chat_id })}
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
  const [saving, setSaving]       = useState({})
  const [saveStatus, setSaveStatus] = useState({})

  // Testing tab state (preserved)
  const [userGames, setUserGames]             = useState([])
  const [selectedGame, setSelectedGame]       = useState('')
  const [selectedService, setSelectedService] = useState('both')
  const [testLoading, setTestLoading]         = useState(false)
  const [testResult, setTestResult]           = useState(null)
  const [crackLoading, setCrackLoading]       = useState(false)
  const [crackInfo, setCrackInfo]             = useState(null)
  const [crackError, setCrackError]           = useState('')
  const [testError, setTestError]             = useState('')

  const [activeTab, setActiveTab] = useState('email')

  const token   = localStorage.getItem('token')
  const isAdmin = (() => { try { return JSON.parse(atob(token.split('.')[1])).can_manage_users } catch { return false } })()
  const authH   = { headers: { Authorization: `Bearer ${token}` } }

  // ── Load from server on mount
  useEffect(() => {
    axios.get(`${API_BASE}/settings`)
      .then(res => {
        const s = res.data || {}
        setServerSettings(s)
        setSmtp(s.smtp       || {})
        setNtfy(s.ntfy       || {})
        setGotify(s.gotify   || {})
        setLdap(s.ldap       || {})
        setTelegram(s.telegram || {})
      })
      .finally(() => setLoadingSettings(false))
  }, [])

  // ── Load user games for testing tab
  useEffect(() => {
    if (!isAdmin) return
    axios.get(`${API_BASE}/user/me/games`, authH)
      .then(r => setUserGames(r.data))
      .catch(() => {})
  }, [isAdmin])

  // ── Helpers
  const isConfigured = data => Object.values(data || {}).some(v => v && String(v).trim())
  const isDirty = key => {
    const curr = key === 'smtp' ? smtp : key === 'ntfy' ? ntfy : key === 'gotify' ? gotify : key === 'telegram' ? telegram : ldap
    return JSON.stringify(curr) !== JSON.stringify(serverSettings[key] || {})
  }

  const saveSection = async (key) => {
    const data = key === 'smtp' ? smtp : key === 'ntfy' ? ntfy : key === 'gotify' ? gotify : key === 'telegram' ? telegram : ldap
    setSaving(p => ({ ...p, [key]: true }))
    setSaveStatus(p => ({ ...p, [key]: null }))
    try {
      await axios.post(`${API_BASE}/settings`, { [key]: data })
      setServerSettings(p => ({ ...p, [key]: { ...data } }))
      setSaveStatus(p => ({ ...p, [key]: 'saved' }))
      setTimeout(() => setSaveStatus(p => ({ ...p, [key]: null })), 3000)
    } catch {
      setSaveStatus(p => ({ ...p, [key]: 'error' }))
    }
    setSaving(p => ({ ...p, [key]: false }))
  }

  // ── Test handlers (preserved)
  const handleCrackTest = async () => {
    if (!selectedGame) return
    setCrackLoading(true); setCrackError(''); setCrackInfo(null)
    try {
      const game = userGames.find(g => g.game_id.toString() === selectedGame)
      if (!game) { setCrackError('Game not found'); return }
      const r = await axios.post(`${API_BASE}/admin/crackrelease-status`, { gameName: game.game_name }, authH)
      setCrackInfo(r.data)
    } catch (err) { setCrackError(err.response?.data?.error || err.message || 'Failed') }
    finally { setCrackLoading(false) }
  }

  const handleTestNotification = async () => {
    if (!selectedGame) return
    setTestLoading(true); setTestError(''); setTestResult(null)
    try {
      const game = userGames.find(g => g.game_id.toString() === selectedGame)
      const r = await axios.post(`${API_BASE}/admin/test-notification`, {
        service: selectedService, gameId: selectedGame,
        gameName: game.game_name, releaseDate: game.release_date,
        coverUrl: game.cover_url,
      }, authH)
      setTestResult(r.data)
    } catch (err) { setTestError(err.response?.data?.error || 'Test notification failed') }
    finally { setTestLoading(false) }
  }

  // ── Nav definition
  const NAV = [
    { key: 'email',    label: 'Email',       sub: 'SMTP',         icon: FaEnvelope,    data: smtp },
    { key: 'ntfy',     label: 'Push',        sub: 'NTFY',         icon: FaBell,        data: ntfy },
    { key: 'gotify',   label: 'Gotify',      sub: 'Gotify Push',  icon: FaBell,        data: gotify },
    { key: 'telegram', label: 'Telegram',    sub: 'Telegram Bot', icon: FaTelegram,    data: telegram },
    { key: 'ldap',     label: 'Directory',   sub: 'LDAP / AD',    icon: FaLock,        data: ldap },
    { key: 'testing',  label: 'Diagnostics', sub: 'Testing',      icon: FaCheckCircle, data: null },
  ]

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

        {NAV.map(s => {
          const configured = s.data !== null ? isConfigured(s.data) : null
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
              </div>
            </button>
          )
        })}
      </nav>

      {/* ── Right panel ── */}
      <div className="ent-panel">

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
            <SectionSaveBar sectionKey="smtp" saving={saving} saveStatus={saveStatus} dirty={isDirty('smtp')} onSave={() => saveSection('smtp')} label="Email Settings" />
          </SettingsSection>
        )}

        {/* NTFY */}
        {activeTab === 'ntfy' && (
          <SettingsSection icon={FaBell} title="Push Notifications (NTFY)" description="Set the NTFY server URL. Each user subscribes using their own topic configured in My Account." configured={isConfigured(ntfy)}>
            <div className="ent-fields">
              <SettingsField label="NTFY Server URL" saved={!!serverSettings.ntfy?.url} wide hint="Self-hosted or ntfy.sh">
                <input className="ent-input" value={ntfy.url   || ''} onChange={e => setNtfy(p => ({ ...p, url:   e.target.value }))} placeholder="https://ntfy.sh" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="ntfy" saving={saving} saveStatus={saveStatus} dirty={isDirty('ntfy')} onSave={() => saveSection('ntfy')} label="NTFY Settings" />
          </SettingsSection>
        )}

        {/* Gotify */}
        {activeTab === 'gotify' && (
          <SettingsSection icon={FaBell} title="Push Notifications (Gotify)" description="Set the Gotify server URL. Each user provides their own app token configured in My Account." configured={isConfigured(gotify)}>
            <div className="ent-fields">
              <SettingsField label="Gotify Server URL" saved={!!serverSettings.gotify?.url} wide hint="Your self-hosted Gotify server">
                <input className="ent-input" value={gotify.url   || ''} onChange={e => setGotify(p => ({ ...p, url:   e.target.value }))} placeholder="https://gotify.example.com" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="gotify" saving={saving} saveStatus={saveStatus} dirty={isDirty('gotify')} onSave={() => saveSection('gotify')} label="Gotify Settings" />
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
            <SectionSaveBar sectionKey="telegram" saving={saving} saveStatus={saveStatus} dirty={isDirty('telegram')} onSave={() => saveSection('telegram')} label="Telegram Settings" />
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
              <SettingsField label="Required Group"     saved={!!serverSettings.ldap?.requiredGroup} hint="Optional — only members of this group can log in">
                <input className="ent-input" value={ldap.requiredGroup || ''} onChange={e => setLdap(p => ({ ...p, requiredGroup: e.target.value }))} placeholder="GameTrackerUsers" />
              </SettingsField>
            </div>
            <SectionSaveBar sectionKey="ldap" saving={saving} saveStatus={saveStatus} dirty={isDirty('ldap')} onSave={() => saveSection('ldap')} label="LDAP Settings" />
          </SettingsSection>
        )}

        {/* Diagnostics */}
        {activeTab === 'testing' && isAdmin && (
          <SettingsSection icon={FaCheckCircle} title="Diagnostics & Testing" description="Verify your notification pipeline and inspect crack status data." configured={null}>
            <div className="ent-fields">
              <SettingsField label="Notification Service">
                <select className="ent-input ent-select" value={selectedService} onChange={e => setSelectedService(e.target.value)}>
                  <option value="both">All (Email, NTFY, Gotify &amp; Telegram)</option>
                  <option value="email">Email only</option>
                  <option value="ntfy">NTFY only</option>
                  <option value="gotify">Gotify only</option>
                  <option value="telegram">Telegram only</option>
                  <option value="crackwatch">CrackRelease status only</option>
                </select>
              </SettingsField>
              <SettingsField label="Game" hint={userGames.length ? `${userGames.length} games in library` : 'Loading…'}>
                <select className="ent-input ent-select" value={selectedGame} onChange={e => setSelectedGame(e.target.value)}>
                  <option value="">Choose a game…</option>
                  {userGames.map(g => (
                    <option key={g.game_id} value={g.game_id}>
                      {g.game_name} {g.release_date ? `(${new Date(g.release_date).toLocaleDateString()})` : '(no date)'}
                    </option>
                  ))}
                </select>
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
                {crackInfo.url && (
                  <div className="ent-result-row">
                    <span className="ent-result-label">Source</span>
                    <a href={crackInfo.url} target="_blank" rel="noreferrer" className="ent-result-link">CrackRelease ↗</a>
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
                {testResult.results?.gotify && (
                  <div className="ent-result-row">
                    <span className="ent-result-label">Gotify</span>
                    <span className={`ent-service-status ent-service-status--${testResult.results.gotify.sent ? 'ok' : 'fail'}`}>
                      {testResult.results.gotify.sent ? '✓ Sent' : `✗ ${testResult.results.gotify.error || 'Failed'}`}
                    </span>
                  </div>
                )}
                {testResult.results?.telegram && (
                  <div className="ent-result-row">
                    <span className="ent-result-label">Telegram</span>
                    <span className={`ent-service-status ent-service-status--${testResult.results.telegram.sent ? 'ok' : 'fail'}`}>
                      {testResult.results.telegram.sent ? '✓ Sent' : `✗ ${testResult.results.telegram.error || 'Failed'}`}
                    </span>
                  </div>
                )}
              </div>
            )}
          </SettingsSection>
        )}
      </div>
    </div>
  )
}

export default App
