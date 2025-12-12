import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { FaUserPlus, FaUserTimes, FaShareAlt } from 'react-icons/fa';
import { useToast } from './src/contexts/ToastContext';
import { useNavigate } from 'react-router-dom';

const API_BASE =
window.location.hostname === "gametracker.etech.ink"
  ? "https://gametracker.etech.ink/api"
  : "http://10.0.0.30:3000/api";
//const API_BASE = "http://10.0.0.30:3000/api"
//const API_BASE = "/api"

// Helper to get token and user info from localStorage
function getAuth() {
  const token = localStorage.getItem('token');
  let user = null;
  if (token) {
    try {
      user = JSON.parse(atob(token.split('.')[1]));
    } catch {}
  }
  return { token, user };
}

// Helper to generate a color from a string (username)
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 80%)`;
}

const STATUS_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Wishlist', value: 'wishlist' },
  { label: 'Playing', value: 'playing' },
  { label: 'Done', value: 'done' },
  { label: 'Unreleased', value: 'unreleased' },
];

// Helper function to normalize status values
function normalizeStatus(status) {
  if (!status) return 'wishlist';
  return status.toLowerCase();
}

// This page will display user cards for every user who shares their library
function SharedLibrary() {
  const { token, user } = getAuth();
  const [allUsers, setAllUsers] = useState([]); // All users for sharing UI
  const [sharedWith, setSharedWith] = useState([]); // Who I share with
  const [sharedWithMe, setSharedWithMe] = useState([]); // Who shared with me
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toggleLoading, setToggleLoading] = useState(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalUser, setModalUser] = useState(null);
  const [modalGames, setModalGames] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState('');
  // Modal enhancements
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const GAMES_PER_PAGE = 12;

  const [shareModalOpen, setShareModalOpen] = useState(false);
  const shareModalRef = React.useRef();

  const { showToast } = useToast();
  const navigate = useNavigate();

  // Fetch all users and my sharing list on mount
  useEffect(() => {
    if (!token || !user) return;
    setLoading(true);
    setError('');
    Promise.all([
      axios.get(`${API_BASE}/all-users`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API_BASE}/user/${user.username}/shared-with-me`, { headers: { Authorization: `Bearer ${token}` } }),
      axios.get(`${API_BASE}/user/${user.username}/share`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })) // fallback
    ]).then(([allUsersRes, sharedWithMeRes, sharedWithRes]) => {
      setAllUsers(allUsersRes.data.filter(u => u.username !== user.username));
      setSharedWithMe(sharedWithMeRes.data.map(s => s.from_user));
      setSharedWith(sharedWithRes.data.toUsers || []);
      setLoading(false);
    }).catch((err) => {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        localStorage.removeItem('token');
        if (window.setUser) window.setUser(null); // fallback if setUser is not in context/props
        navigate('/login');
      } else {
        setError('Failed to load sharing data.');
      }
      setLoading(false);
    });
  }, [token, user?.username]);

  // Add or revoke sharing
  async function handleShareAdd(username) {
    const newSharedWith = [...sharedWith, username];
    setToggleLoading(true);
    try {
      await axios.post(`${API_BASE}/user/${user.username}/share`, { toUsers: newSharedWith }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const res = await axios.get(`${API_BASE}/user/${user.username}/share`, { headers: { Authorization: `Bearer ${token}` } });
      setSharedWith(res.data.toUsers || []);
      showToast('success', `Now sharing with @${username}`);
    } catch (err) {
      showToast('error', 'Failed to update sharing.');
    }
    setToggleLoading(false);
  }
  async function handleShareRevoke(username) {
    const newSharedWith = sharedWith.filter(u => u !== username);
    setToggleLoading(true);
    try {
      await axios.post(`${API_BASE}/user/${user.username}/share`, { toUsers: newSharedWith }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const res = await axios.get(`${API_BASE}/user/${user.username}/share`, { headers: { Authorization: `Bearer ${token}` } });
      setSharedWith(res.data.toUsers || []);
      showToast('error', `Revoked sharing from @${username}`);
    } catch (err) {
      showToast('error', 'Failed to update sharing.');
    }
    setToggleLoading(false);
  }

  // Open modal and fetch games
  async function handleViewLibrary(u) {
    setModalUser(u);
    setModalOpen(true);
    setModalGames([]);
    setModalLoading(true);
    setModalError('');
    setSearch('');
    setStatusFilter('all');
    setPage(1);
    try {
      const res = await axios.get(`${API_BASE}/user/${user.username}/shared/${u.username}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setModalGames(res.data);
    } catch (err) {
      setModalError('Failed to load shared games.');
    }
    setModalLoading(false);
  }

  function closeModal() {
    setModalOpen(false);
    setModalUser(null);
    setModalGames([]);
    setModalError('');
    setSearch('');
    setStatusFilter('all');
    setPage(1);
  }

  // Modal close on ESC or background click
  useEffect(() => {
    if (!modalOpen) return;
    function onKey(e) { if (e.key === 'Escape') closeModal(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  // Filter and paginate games in modal
  let filteredGames = modalGames;
  if (search.trim()) {
    filteredGames = filteredGames.filter(g => (g.game_name || '').toLowerCase().includes(search.trim().toLowerCase()));
  }
  if (statusFilter !== 'all') {
    filteredGames = filteredGames.filter(g => {
      if (statusFilter === 'unreleased') {
        return g.status === 'unreleased' || !g.release_date;
      }
      // Case-insensitive status comparison using helper function
      return normalizeStatus(g.status) === statusFilter;
    });
  }
  const totalGames = filteredGames.length;
  const totalPages = Math.max(1, Math.ceil(totalGames / GAMES_PER_PAGE));
  const pagedGames = filteredGames.slice((page - 1) * GAMES_PER_PAGE, page * GAMES_PER_PAGE);

  function handlePageChange(newPage) {
    if (newPage < 1 || newPage > totalPages) return;
    setPage(newPage);
  }

  // Only show libraries shared with me
  const visibleUsers = allUsers.filter(u => sharedWithMe.includes(u.username));

  // Modal close on ESC or background click
  useEffect(() => {
    if (!shareModalOpen) return;
    function onKey(e) { if (e.key === 'Escape') setShareModalOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shareModalOpen]);

  function handleShareModalBgClick(e) {
    if (e.target === shareModalRef.current) setShareModalOpen(false);
  }

  return (
    <div className="shared-library-page">
      <h2>Shared Library</h2>
      {user && (
        <div style={{ marginBottom: '2rem' }}>
          <button className="action-btn playing-btn" style={{marginBottom: 18, fontSize: '1.1em'}} onClick={() => setShareModalOpen(true)}>
            <FaShareAlt style={{marginRight: 8}} /> Manage Sharing
          </button>
          {shareModalOpen && (
            <div className="user-modal-bg" ref={shareModalRef} onClick={handleShareModalBgClick} tabIndex={-1} aria-modal="true" role="dialog">
              <div className="user-modal-window" style={{ maxWidth: 520, minWidth: 320, borderRadius: 18, background: 'rgba(36,44,60,0.95)', boxShadow: '0 8px 40px #0ea5e933', padding: '2.2rem 2.2rem 1.5rem 2.2rem' }}>
                <button className="user-modal-close" aria-label="Close" onClick={() => setShareModalOpen(false)}>&times;</button>
                <h3 style={{ marginTop: 0, marginBottom: 18, color: '#2196f3', fontWeight: 800, fontSize: '1.4em', letterSpacing: 0.5 }}>Manage Library Sharing</h3>
                {loading ? <p>Loading users...</p> : (
                  <>
                    {/* Currently sharing with */}
                    <div style={{ marginBottom: 22 }}>
                      <div style={{ fontWeight: 600, marginBottom: 8, color: '#fff' }}>Currently sharing with:</div>
                      {sharedWith.length === 0 ? (
                        <div style={{ color: '#aaa', fontSize: '0.98em' }}>No users selected.</div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                          {allUsers.filter(u => sharedWith.includes(u.username)).map(u => (
                            <div key={u.username} style={{ display: 'flex', alignItems: 'center', background: 'rgba(33,150,243,0.13)', borderRadius: 99, padding: '0.4em 1em', gap: 8, boxShadow: '0 2px 8px #2196f344' }}>
                              <div style={{ width: 28, height: 28, borderRadius: '50%', background: stringToColor(u.username), color: '#222', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{(u.display_name || u.username)[0].toUpperCase()}</div>
                              <span style={{ fontWeight: 600, color: '#fff' }}>{u.display_name || u.username}</span>
                              <span style={{ color: '#b0b8c9', fontSize: '0.9em' }}>@{u.username}</span>
                              <button
                                className="remove-btn"
                                style={{ marginLeft: 8, borderRadius: 99, padding: '0.2em 0.7em', fontWeight: 600, fontSize: 15, background: 'linear-gradient(135deg, #f44336 0%, #d32f2f 100%)', color: '#fff', border: 'none', boxShadow: '0 2px 8px #f4433644', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => handleShareRevoke(u.username)}
                                disabled={toggleLoading}
                                title="Revoke sharing"
                              ><FaUserTimes style={{marginRight: 3}}/> Revoke</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Available users to share with */}
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 8, color: '#fff' }}>Available users to share with:</div>
                      {allUsers.filter(u => !sharedWith.includes(u.username)).length === 0 ? (
                        <div style={{ color: '#aaa', fontSize: '0.98em' }}>No more users available.</div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                          {allUsers.filter(u => !sharedWith.includes(u.username)).map(u => (
                            <div key={u.username} style={{ display: 'flex', alignItems: 'center', background: 'rgba(76,175,80,0.13)', borderRadius: 99, padding: '0.4em 1em', gap: 8, boxShadow: '0 2px 8px #4caf5044' }}>
                              <div style={{ width: 28, height: 28, borderRadius: '50%', background: stringToColor(u.username), color: '#222', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>{(u.display_name || u.username)[0].toUpperCase()}</div>
                              <span style={{ fontWeight: 600, color: '#fff' }}>{u.display_name || u.username}</span>
                              <span style={{ color: '#b0b8c9', fontSize: '0.9em' }}>@{u.username}</span>
                              <button
                                className="action-btn wishlist-btn"
                                style={{ marginLeft: 8, borderRadius: 99, padding: '0.2em 0.7em', fontWeight: 600, fontSize: 15, background: 'linear-gradient(135deg, #2196f3 0%, #1976d2 100%)', color: '#fff', border: 'none', boxShadow: '0 2px 8px #2196f344', display: 'flex', alignItems: 'center', gap: 4 }}
                                onClick={() => handleShareAdd(u.username)}
                                disabled={toggleLoading}
                                title="Share library"
                              ><FaUserPlus style={{marginRight: 3}}/> Share</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {loading ? (
        <p>Loading shared libraries...</p>
      ) : error ? (
        <div className="error-msg">{error}</div>
      ) : (
        <div className="user-cards-section">
          <div className="user-cards-grid">
            {visibleUsers.length === 0 ? (
              <p>No users have shared their library with you yet.</p>
            ) : (
              visibleUsers.map(u => {
                const avatarBg = stringToColor(u.username || 'U');
                const avatarLetter = (u.display_name && u.display_name.length > 0)
                  ? u.display_name[0].toUpperCase()
                  : (u.username && u.username.length > 0 ? u.username[0].toUpperCase() : '?');
                return (
                  <div
                    className="user-card"
                    key={u.username}
                    style={{
                      boxShadow: '0 8px 32px #0ea5e922, 0 2px 0px #38bdf822',
                      borderRadius: 32,
                      background: 'linear-gradient(135deg, rgba(36,44,60,0.85) 60%, rgba(33,150,243,0.08) 100%)',
                      alignItems: 'center',
                      textAlign: 'center',
                      position: 'relative',
                      padding: '2.2rem 1.5rem 1.5rem 1.5rem',
                      margin: '1.2rem auto',
                      maxWidth: 340,
                      minWidth: 240,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      border: '1.5px solid #23293a',
                      transition: 'box-shadow 0.2s, transform 0.2s',
                    }}
                  >
                    <div
                      className="user-card-avatar"
                      title={u.username}
                      style={{
                        background: avatarBg,
                        width: 70,
                        height: 70,
                        borderRadius: '50%',
                        margin: '0 auto 1.1rem auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 34,
                        fontWeight: 800,
                        color: '#23293a',
                        boxShadow: '0 4px 24px #2196f344',
                        border: '4px solid #fff',
                        outline: '2.5px solid #2196f3',
                        outlineOffset: '-2px',
                        transition: 'outline 0.2s',
                      }}
                    >
                      {avatarLetter}
                    </div>
                    <div style={{ fontWeight: 800, fontSize: '1.35em', color: '#fff', marginBottom: 2, letterSpacing: 0.2 }}>{u.display_name || u.username}</div>
                    <div style={{ color: '#b0b8c9', fontSize: '1.05em', marginBottom: 18 }}>@{u.username}</div>
                    <div className="user-card-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
                      <button
                        className="action-btn playing-btn"
                        style={{ borderRadius: 99, fontWeight: 700, fontSize: 17, padding: '0.6em 2.2em', boxShadow: '0 2px 8px #2196f344', background: 'linear-gradient(135deg, #2196f3 0%, #1976d2 100%)', color: '#fff', border: 'none', letterSpacing: 0.2 }}
                        onClick={() => handleViewLibrary(u)}
                        title="View Library"
                      >
                        View Library
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
      {/* Modal for viewing shared library */}
      {modalOpen && (
        <div className="user-modal-bg" onClick={e => { if (e.target.className === 'user-modal-bg') closeModal(); }} tabIndex={-1} aria-modal="true" role="dialog">
          <div className="user-modal-window" style={{ maxWidth: 700, minWidth: 320 }}>
            <button className="user-modal-close" aria-label="Close" onClick={closeModal}>&times;</button>
            <h3 style={{ marginTop: 0, marginBottom: 16 }}>
              {modalUser && (modalUser.display_name || modalUser.username)}'s Library
            </h3>
            {modalLoading ? (
              <p>Loading games...</p>
            ) : modalError ? (
              <div className="error-msg">{modalError}</div>
            ) : modalGames.length === 0 ? (
              <p>No games in this library.</p>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                  <input
                    type="text"
                    placeholder="Search games..."
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPage(1); }}
                    style={{ padding: '0.6em 1em', borderRadius: 8, border: '1.5px solid #444b5a', background: '#23293a', color: '#e5e7eb', fontSize: '1em', minWidth: 180, marginRight: 8 }}
                  />
                  <select
                    value={statusFilter}
                    onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                    style={{ padding: '0.6em 1em', borderRadius: 8, border: '1.5px solid #444b5a', background: '#23293a', color: '#e5e7eb', fontSize: '1em', minWidth: 140 }}
                  >
                    {STATUS_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <span style={{ color: '#b0b8c9', fontSize: '0.98em', marginLeft: 8 }}>
                    {totalGames} game{totalGames !== 1 ? 's' : ''} found
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.2rem', justifyContent: 'center', marginTop: 12 }}>
                  {pagedGames.map(game => (
                    <div key={game.game_id || game.id} style={{ background: '#23293a', borderRadius: 12, padding: 12, minWidth: 160, maxWidth: 180, textAlign: 'center', boxShadow: '0 2px 8px #0002' }}>
                      {game.cover_url && (
                        <img src={game.cover_url} alt={game.game_name} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} />
                      )}
                      <div style={{ fontWeight: 700, color: '#fff', fontSize: '1.08em', marginBottom: 4 }}>{game.game_name}</div>
                      <div style={{ color: '#b0b8c9', fontSize: '0.95em' }}>
                        {game.status ? game.status.charAt(0).toUpperCase() + game.status.slice(1).toLowerCase() : ''}
                      </div>
                    </div>
                  ))}
                </div>
                {totalPages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, marginTop: 18 }}>
                    <button onClick={() => handlePageChange(page - 1)} disabled={page === 1} style={{ padding: '0.5em 1.2em', borderRadius: 8, border: 'none', background: '#23293a', color: '#e5e7eb', fontWeight: 700, cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.5 : 1 }}>Prev</button>
                    <span style={{ color: '#b0b8c9', fontSize: '1em' }}>Page {page} of {totalPages}</span>
                    <button onClick={() => handlePageChange(page + 1)} disabled={page === totalPages} style={{ padding: '0.5em 1.2em', borderRadius: 8, border: 'none', background: '#23293a', color: '#e5e7eb', fontWeight: 700, cursor: page === totalPages ? 'not-allowed' : 'pointer', opacity: page === totalPages ? 0.5 : 1 }}>Next</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SharedLibrary; 