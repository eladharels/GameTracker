// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect, useRef, useCallback } from 'react'
import { FaArrowUp, FaCheck, FaExclamationCircle, FaGamepad, FaGripVertical, FaHeart, FaHourglassHalf, FaList, FaLock, FaPlay, FaSearch, FaSync, FaTh, FaTrash } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { useToast } from '../contexts/ToastContext'
import GameDetailModal from '../GameDetailModal'
import { formatDurationShort, formatDurationLong, formatDateReadable } from '../dateUtils'
import { STATUSES, isGameUnreleased, normalizeStatus } from '../gameStatus'

export default function LibraryPage({ user }) {
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
