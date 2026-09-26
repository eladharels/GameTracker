// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useRef } from 'react'
import { FaGamepad, FaList, FaSearch, FaTh } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { useToast } from '../contexts/ToastContext'
import GameDetailModal from '../GameDetailModal'
import { libraryMatch } from '../libraryMatch'
import { isGameUnreleased } from '../gameStatus'

export default function SearchPage({ user }) {
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
