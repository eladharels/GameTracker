import { useState, useEffect, useRef } from 'react'
import { Routes, Route, Link, useLocation, Navigate, useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import './App.css'
import { FaSearch, FaBook, FaUsers, FaSignOutAlt, FaLock, FaSortAlphaDown, FaSortNumericDown, FaSortAmountDown, FaCog, FaEnvelope, FaBell, FaCheckCircle, FaRegCalendarAlt, FaArrowLeft, FaPlay, FaHeart, FaEye, FaCheck, FaTh, FaList, FaTrash, FaExclamationCircle, FaShareAlt } from 'react-icons/fa'
import { useToast } from './contexts/ToastContext'
import SharedLibrary from '../SharedLibrary'

// Dynamic API base URL that works from any device
const API_BASE =
window.location.hostname === "gametracker.etech.ink"
  ? "https://gametracker.etech.ink/api"
  : "http://10.0.0.30:3000/api";
//const API_BASE = "http://10.0.0.30:3000/api"
//const API_BASE = "/api"

const STATUSES = ['wishlist', 'playing', 'done']

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
    <div className="container">
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
      // For demo: mock a Steam App ID for the first result (e.g., Cyberpunk 2077 = 1091500)
      const resultsWithSteam = res.data.map((g, i) => i === 0 ? { ...g, steamAppId: '1091500' } : g)
      setSearchResults(resultsWithSteam)
      // Fetch price for games with a Steam App ID
      resultsWithSteam.forEach(game => {
        if (game.steamAppId) {
          fetchGamePrice(game.id, game.steamAppId)
        }
      })
    } catch (err) {
      setSearchResults([])
      setSearchError('Failed to search games. Please try again.')
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
                <div key={game.id} className={`game-card ${viewMode === 'list' ? 'list-item' : ''}`} >
                  {game.coverUrl && (
                    <div className="game-cover-container">
                      <img src={game.coverUrl} alt={game.name} className="game-cover" />
                    </div>
                  )}
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
  const [searchTerm, setSearchTerm] = useState('')
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
  }, [user, statusUpdating])

  const FILTERS = [
    { label: 'All', value: 'all' },
    { label: 'Wishlist', value: 'wishlist' },
    { label: 'Playing', value: 'playing' },
    { label: 'Done', value: 'done' },
    { label: 'Unreleased', value: 'unreleased' },
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

  // Change status
  const setGameStatus = async (game, status) => {
    if (!user) return alert('Enter a username first!')
    setStatusUpdating(true)
    setStatusError('')
    try {
      await axios.post(`${API_BASE}/user/${user.username}/games`, {
        gameId: game.game_id,
        gameName: game.game_name,
        coverUrl: game.cover_url,
        releaseDate: game.release_date,
        status,
      })
      
      // Refresh the library data after successful status update
      const timestamp = Date.now()
      const res = await axios.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
      setUserGames(res.data)
    } catch (err) {
      setStatusError('Failed to update status. Please try again.')
    }
    setStatusUpdating(false)
  }

  // Remove game
  const removeGame = async (gameId) => {
    if (!user) return
    setStatusUpdating(true)
    setRemoveError('')
    try {
      await axios.delete(`${API_BASE}/user/${user.username}/games/${gameId}`)
      
      // Refresh the library data after successful removal
      const timestamp = Date.now()
      const res = await axios.get(`${API_BASE}/user/${user.username}/games?t=${timestamp}`)
      setUserGames(res.data)
    } catch (err) {
      setRemoveError('Failed to remove game. Please try again.')
    }
    setStatusUpdating(false)
  }

  const handleSortClick = (value) => {
    if (sortBy === value) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(value)
      setSortDir('asc')
    }
  }

  const sortOptions = [
    { label: 'Name', value: 'name' },
    { label: 'Release Date', value: 'release' },
    { label: 'Status', value: 'status' },
  ]

  return (
    <div className="user-games-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h2 style={{margin: 0}}>My Library ({userGames.length})</h2>
        <div className="view-controls" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="toggle-price-btn"
            style={{
              background: showPrices ? 'var(--color-accent)' : 'var(--color-card)',
              color: showPrices ? 'var(--color-accent-contrast)' : 'var(--color-fg-muted)',
              border: '1.5px solid var(--color-border)',
              borderRadius: 12,
              padding: '0.5em 1.2em',
              fontWeight: 600,
              fontSize: '1em',
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: showPrices ? '0 4px 15px #0ea5e933' : 'none',
            }}
            onClick={() => setShowPrices(v => !v)}
            aria-pressed={showPrices}
          >
            {showPrices ? 'Hide Prices' : 'Show Prices'}
          </button>
          <div className="view-toggle">
            <button onClick={() => setViewMode('grid')} className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}><FaTh /></button>
            <button onClick={() => setViewMode('list')} className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}><FaList /></button>
          </div>
        </div>
      </div>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          type="text"
          placeholder="Search your library..."
          value={searchTerm}
          onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
          style={{
            padding: '0.5em 1em',
            borderRadius: 8,
            border: '1.5px solid var(--color-border)',
            fontSize: '1em',
            width: 260,
            background: 'var(--color-card)',
            color: 'var(--color-fg)',
          }}
        />
      </div>
      <div className="filter-bar">
        {FILTERS.map(f => (
          <button
            key={f.value}
            className={`filter-btn${filter === f.value ? ' active' : ''}`}
            onClick={() => { setFilter(f.value); setCurrentPage(1); }}
            disabled={statusUpdating}
          >
            {f.label}
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
      
      {loading ? (
        <p>Loading...</p>
      ) : filteredUserGames.length === 0 ? (
        <p>No games in your library yet.</p>
      ) : (
        <>
          <div className={`games-list ${viewMode === 'list' ? 'list-view' : ''}`}>
            {currentGames.map(game => {
              const isUnreleased = game.status === 'unreleased' || !game.release_date;
              return (
                <div key={game.game_id} className={`game-card ${viewMode === 'list' ? 'list-item' : ''}`} >
                  {game.cover_url && (
                    <div className="game-cover-container">
                      <img src={game.cover_url} alt={game.game_name} className="game-cover" />
                    </div>
                  )}
                  <div className="game-info">
                    <div>
                      <div className="game-title">{game.game_name}</div>
                      <div className="game-release-date">Release: {game.release_date ? game.release_date : 'Unreleased'}</div>
                      {showPrices && (
                        <div className="game-price" style={{ margin: '0.5em 0', color: 'var(--color-fg-muted)', fontWeight: 400, fontSize: '0.98em', letterSpacing: 0.1, lineHeight: 1.2 }}>
                          {/* Prefer cached price, fallback to live fetch */}
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
                        <select 
                          className="status-select" 
                          value={normalizeStatus(game.status)} 
                          onChange={(e) => {
                            e.stopPropagation();
                            setGameStatus(game, e.target.value);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {STATUSES.map(status => (
                            <option key={status} value={status}>{status}</option>
                          ))}
                        </select>
                      )}
                      <button 
                        className="remove-btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeGame(game.game_id);
                        }}
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

function SettingsPage() {
  const [smtp, setSmtp] = useState(() => JSON.parse(localStorage.getItem('smtp_settings') || '{}'));
  const [ntfy, setNtfy] = useState(() => JSON.parse(localStorage.getItem('ntfy_settings') || '{}'));
  const [ldap, setLdap] = useState(() => JSON.parse(localStorage.getItem('ldap_settings') || '{}'));
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [userGames, setUserGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState('');
  const [selectedService, setSelectedService] = useState('both');
  const [testNotificationLoading, setTestNotificationLoading] = useState(false);
  const [testNotificationResult, setTestNotificationResult] = useState(null);
  const [activeTab, setActiveTab] = useState('email');
  const user = JSON.parse(localStorage.getItem('token_payload') || '{}');
  const isAdmin = user && user.can_manage_users;

  const handleSmtpChange = e => setSmtp({ ...smtp, [e.target.name]: e.target.value });
  const handleNtfyChange = e => setNtfy({ ...ntfy, [e.target.name]: e.target.value });
  const handleLdapChange = e => setLdap({ ...ldap, [e.target.name]: e.target.value });

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await axios.post(`${API_BASE}/settings`, { smtp, ntfy, ldap });
      localStorage.setItem('smtp_settings', JSON.stringify(smtp));
      localStorage.setItem('ntfy_settings', JSON.stringify(ntfy));
      localStorage.setItem('ldap_settings', JSON.stringify(ldap));
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError('Failed to save settings.');
    }
  };

  // Load user's games for notification testing
  useEffect(() => {
    if (isAdmin) {
      const token = localStorage.getItem('token');
      console.log('Loading user games for notification testing...');
      axios.get(`${API_BASE}/user/me/games`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(response => {
        console.log('User games loaded:', response.data);
        setUserGames(response.data);
      }).catch(err => {
        console.error('Failed to load user games:', err);
        setError('Failed to load your games for testing');
      });
    }
  }, [isAdmin]);

  const handleTestNotification = async () => {
    if (!selectedGame) {
      setError('Please select a game to test notifications');
      return;
    }

    setTestNotificationLoading(true);
    setError('');
    setTestNotificationResult(null);

    try {
      const token = localStorage.getItem('token');
      const game = userGames.find(g => g.game_id.toString() === selectedGame);
      
      const response = await axios.post(`${API_BASE}/admin/test-notification`, {
        service: selectedService,
        gameId: selectedGame,
        gameName: game.game_name,
        releaseDate: game.release_date
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setTestNotificationResult(response.data);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      setError(err.response?.data?.error || 'Test notification failed');
    } finally {
      setTestNotificationLoading(false);
    }
  };

  // Decode token to check admin
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        localStorage.setItem('token_payload', JSON.stringify(payload));
      } catch {}
    }
  }, []);

  // Define tabs configuration
  const tabs = [
    { id: 'email', label: 'Email Settings', icon: FaEnvelope, adminOnly: true },
    { id: 'ntfy', label: 'NTFY Settings', icon: FaBell, adminOnly: true },
    { id: 'ldap', label: 'LDAP Settings', icon: FaLock, adminOnly: true },
    { id: 'testing', label: 'Test Notifications', icon: FaCheckCircle, adminOnly: true }
  ];

  // Filter tabs based on admin status
  const availableTabs = tabs.filter(tab => !tab.adminOnly || isAdmin);

  return (
    <div className="settings-page">
      <h2><FaCog style={{marginRight:8}}/>Settings</h2>
      
      {/* Tab Navigation */}
      <div className="settings-tabs">
        {availableTabs.map(tab => {
          const IconComponent = tab.icon;
          return (
            <button
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <IconComponent className="tab-icon" />
              <span className="tab-label">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="settings-content">
        <form className="settings-form" onSubmit={handleSave}>
          {/* Email Settings Tab */}
          {activeTab === 'email' && isAdmin && (
            <div className="tab-panel">
              <div className="tab-header">
                <FaEnvelope className="tab-header-icon" />
                <h3>Email (SMTP) Notifications</h3>
                <p>Configure SMTP settings for email notifications</p>
              </div>
              <div className="settings-grid">
                <div className="input-group">
                  <label htmlFor="smtp-host">SMTP Host</label>
                  <input id="smtp-host" name="host" value={smtp.host || ''} onChange={handleSmtpChange} placeholder="e.g. smtp.example.com" />
                </div>
                <div className="input-group">
                  <label htmlFor="smtp-port">SMTP Port</label>
                  <input id="smtp-port" name="port" value={smtp.port || ''} onChange={handleSmtpChange} placeholder="e.g. 587" type="number" />
                </div>
                <div className="input-group">
                  <label htmlFor="smtp-user">SMTP Username</label>
                  <input id="smtp-user" name="user" value={smtp.user || ''} onChange={handleSmtpChange} placeholder="e.g. user@example.com" />
                </div>
                <div className="input-group">
                  <label htmlFor="smtp-pass">SMTP Password</label>
                  <input id="smtp-pass" name="pass" value={smtp.pass || ''} onChange={handleSmtpChange} placeholder="Password" type="password" />
                </div>
                <div className="input-group">
                  <label htmlFor="smtp-from">From Email</label>
                  <input id="smtp-from" name="from" value={smtp.from || ''} onChange={handleSmtpChange} placeholder="e.g. noreply@example.com" />
                </div>
                <div className="input-group">
                  <label htmlFor="smtp-to">Your Email (to receive notifications)</label>
                  <input id="smtp-to" name="to" value={smtp.to || ''} onChange={handleSmtpChange} placeholder="e.g. you@example.com" />
                </div>
              </div>
            </div>
          )}

          {/* NTFY Settings Tab */}
          {activeTab === 'ntfy' && isAdmin && (
            <div className="tab-panel">
              <div className="tab-header">
                <FaBell className="tab-header-icon" />
                <h3>NTFY Notifications</h3>
                <p>Configure NTFY server and topic for push notifications</p>
              </div>
              <div className="settings-grid">
                <div className="input-group">
                  <label htmlFor="ntfy-url">NTFY Server URL</label>
                  <input id="ntfy-url" name="url" value={ntfy.url || ''} onChange={handleNtfyChange} placeholder="e.g. https://ntfy.example.com" />
                </div>
                <div className="input-group">
                  <label htmlFor="ntfy-topic">NTFY Topic</label>
                  <input id="ntfy-topic" name="topic" value={ntfy.topic || ''} onChange={handleNtfyChange} placeholder="e.g. mytopic" />
                </div>
              </div>
            </div>
          )}

          {/* LDAP Settings Tab */}
          {activeTab === 'ldap' && isAdmin && (
            <div className="tab-panel">
              <div className="tab-header">
                <FaLock className="tab-header-icon" />
                <h3>LDAP Settings</h3>
                <p>Configure LDAP server for user authentication</p>
              </div>
              <div className="settings-grid">
                <div className="input-group">
                  <label htmlFor="ldap-url">LDAP Server URL</label>
                  <input id="ldap-url" name="url" value={ldap.url || ''} onChange={handleLdapChange} placeholder="e.g. ldap://dc01.example.com" />
                </div>
                <div className="input-group">
                  <label htmlFor="ldap-base">Base DN</label>
                  <input id="ldap-base" name="base" value={ldap.base || ''} onChange={handleLdapChange} placeholder="e.g. dc=example,dc=com" />
                </div>
                <div className="input-group">
                  <label htmlFor="ldap-userdn">User DN Pattern</label>
                  <input id="ldap-userdn" name="userDn" value={ldap.userDn || ''} onChange={handleLdapChange} placeholder="e.g. cn={username},ou=Users,{baseDN}" />
                </div>
                <div className="input-group">
                  <label htmlFor="ldap-binddn">Bind DN (optional)</label>
                  <input id="ldap-binddn" name="bindDn" value={ldap.bindDn || ''} onChange={handleLdapChange} placeholder="e.g. cn=readonly,dc=example,dc=com" />
                </div>
                <div className="input-group">
                  <label htmlFor="ldap-bindpass">Bind Password (optional)</label>
                  <input id="ldap-bindpass" name="bindPass" value={ldap.bindPass || ''} onChange={handleLdapChange} placeholder="Password" type="password" />
                </div>
                <div className="input-group">
                  <label htmlFor="ldap-requiredgroup">Required Group</label>
                  <input id="ldap-requiredgroup" name="requiredGroup" value={ldap.requiredGroup || ''} onChange={handleLdapChange} placeholder="e.g. GameTrackerUsers or cn=..." />
                </div>
              </div>
            </div>
          )}

          {/* Test Notifications Tab */}
          {activeTab === 'testing' && isAdmin && (
            <div className="tab-panel">
              <div className="tab-header">
                <FaCheckCircle className="tab-header-icon" />
                <h3>Test Notifications</h3>
                <p>Send test notifications to verify your configuration</p>
              </div>
              <div className="settings-grid">
                <div className="input-group">
                  <label htmlFor="notification-service">Notification Service</label>
                  <select 
                    id="notification-service" 
                    value={selectedService} 
                    onChange={(e) => setSelectedService(e.target.value)}
                    className="settings-select"
                  >
                    <option value="both">Both Email & NTFY</option>
                    <option value="email">Email Only</option>
                    <option value="ntfy">NTFY Only</option>
                  </select>
                </div>
                <div className="input-group">
                  <label htmlFor="test-game">Select Game for Testing</label>
                  <select 
                    id="test-game" 
                    value={selectedGame} 
                    onChange={(e) => setSelectedGame(e.target.value)}
                    className="settings-select"
                  >
                    <option value="">Choose a game from your library...</option>
                    {userGames.length === 0 ? (
                      <option value="" disabled>Loading your games...</option>
                    ) : (
                      userGames.map(game => {
                        const releaseDate = game.release_date ? new Date(game.release_date).toLocaleDateString() : 'Date N/A';
                        return (
                          <option key={game.game_id} value={game.game_id}>
                            {game.game_name} ({releaseDate})
                          </option>
                        );
                      })
                    )}
                  </select>
                  {userGames.length > 0 && (
                    <small style={{color: '#666', fontSize: '12px', marginTop: '4px'}}>
                      Found {userGames.length} games in your library
                    </small>
                  )}
                </div>
                <div className="input-group">
                  <button 
                    type="button" 
                    onClick={handleTestNotification}
                    disabled={testNotificationLoading || !selectedGame}
                    className="test-notification-btn"
                  >
                    {testNotificationLoading ? (
                      <>
                        <span style={{marginRight: '8px'}}>⏳</span>
                        Sending Test Notification...
                      </>
                    ) : (
                      <>
                        <span style={{marginRight: '8px'}}>📧</span>
                        Send Test Notification
                      </>
                    )}
                  </button>
                  <p className="test-notification-help">
                    This will send a test notification using your configured email and/or NTFY settings. 
                    The notification will include the exact days until release for the selected game.
                  </p>
                </div>
              </div>
              
              {/* Test Notification Results */}
              {testNotificationResult && (
                <div className="test-notification-results">
                  <h4>
                    <span style={{marginRight: '8px'}}>📊</span>
                    Test Notification Results
                  </h4>
                  
                  <div className="test-game-info">
                    <h5>Game Information:</h5>
                    <div className="game-info-content">
                      <p><strong>Game:</strong> {testNotificationResult.gameInfo.name}</p>
                      <p><strong>Release Date:</strong> {testNotificationResult.gameInfo.releaseDate}</p>
                      <p><strong>Release Status:</strong> {testNotificationResult.gameInfo.releaseText}</p>
                    </div>
                  </div>
                  
                  <div className="test-results-section">
                    <h5>Notification Results:</h5>
                    
                    {/* Email Results */}
                    <div className={`test-result-card ${testNotificationResult.results.email.sent ? 'success' : 'error'}`}>
                      <span className="result-icon">📧</span>
                      <div className="result-content">
                        <strong>Email: {testNotificationResult.results.email.sent ? 'Sent Successfully' : 'Failed'}</strong>
                        {testNotificationResult.results.email.error && (
                          <p>Error: {testNotificationResult.results.email.error}</p>
                        )}
                      </div>
                    </div>
                    
                    {/* NTFY Results */}
                    <div className={`test-result-card ${testNotificationResult.results.ntfy.sent ? 'success' : 'error'}`}>
                      <span className="result-icon">🔔</span>
                      <div className="result-content">
                        <strong>NTFY: {testNotificationResult.results.ntfy.sent ? 'Sent Successfully' : 'Failed'}</strong>
                        {testNotificationResult.results.ntfy.error && (
                          <p>Error: {testNotificationResult.results.ntfy.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Save Button and Status Messages */}
          <div className="settings-actions">
            <button type="submit" className="save-settings-btn enhanced-btn">Save Settings</button>
            {success && <div className="settings-success"><FaCheckCircle style={{color:'#43a047',marginRight:6}}/>Settings saved!</div>}
            {error && <div className="error-msg">{error}</div>}
          </div>
        </form>
      </div>
    </div>
  );
}

export default App
