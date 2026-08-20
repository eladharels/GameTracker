// GameDetailModal.jsx — reference implementation of the card-press popup.
//
// This is the ONE piece that is not yet in your source (the CSS/JSX refactor
// already is). Drop this component into your app and render it from the page
// that holds the game grid (LibraryPage / SearchPage). Styling lives in
// App.css under the "GAME DETAIL MODAL" section — see the README.
//
// It is intentionally self-contained and uses the same status values and
// fields your library cards already have (game_name, cover_url, release_date,
// status). Wire the status buttons to your existing setGameStatus / removeGame
// handlers.

import { useEffect, useState } from 'react'
import axios from 'axios'
import { FaGamepad, FaTimes, FaHourglassHalf } from 'react-icons/fa'
import { formatDurationLong } from './dateUtils'

const API_BASE = `${window.location.origin}/api`

// How a single transition reads in prose. `from` is null for the row that records the
// game being added, which is why that case is spelled out rather than left to render as
// "null → wishlist".
function describe(ev) {
  if (!ev.from) return `Added as ${ev.to}`
  return `${ev.from} → ${ev.to}`
}

// What performed the transition. `user` is the default and says nothing — a label on
// every row would be noise. The system sources are named, because "I never did that" is
// the reasonable reaction to seeing an unexplained status change in your own history.
const SOURCE_LABEL = {
  release_sweep: 'auto · released',
  metadata_refresh: 'auto · metadata',
  backfill: 'backfill',
}

// Maps a normalized status to the kicker line shown above the title.
const KICKER = {
  playing: 'Currently playing',
  done: 'Completed',
  wishlist: 'On your wishlist',
  backlog: 'In your backlog',
  unreleased: 'Unreleased',
}

export default function GameDetailModal({ game, onClose, onSetStatus, onRemove, username }) {
  // This game's status history. Fetched per-open rather than carried in the library
  // response: the timeline is unbounded per game and only ever one game is on screen.
  //
  // Failure is SILENT and the section simply does not render. A history is context on a
  // modal whose primary job — read the game, change its status — works without it.
  const [history, setHistory] = useState(null)
  useEffect(() => {
    if (!game || !username) { setHistory(null); return }
    const gameId = game.game_id || game.gameId
    if (!gameId) return
    let cancelled = false
    setHistory(null)
    axios.get(`${API_BASE}/user/${username}/games/${encodeURIComponent(gameId)}/history`)
      .then((res) => { if (!cancelled) setHistory(res.data) })
      .catch(() => { if (!cancelled) setHistory(null) })
    return () => { cancelled = true }
  }, [game, username])

  // Close on Escape + lock background scroll while open.
  useEffect(() => {
    if (!game) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [game, onClose])

  if (!game) return null

  const status = (game.status || 'wishlist').toLowerCase()
  const cover = game.cover_url || game.coverUrl
  const date = game.release_date || game.releaseDate || 'Unreleased'

  return (
    <div className="gdm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="gdm-modal" role="dialog" aria-modal="true" aria-label={game.game_name || game.name}>
        {cover && <img className="gdm-bg" src={cover} alt="" aria-hidden />}
        <div className="gdm-scrim" />
        <button className="gdm-close" onClick={onClose} aria-label="Close"><FaTimes /></button>

        <div className="gdm-body">
          <div className="gdm-cover">
            {cover
              ? <img src={cover} alt={game.game_name || game.name} />
              : <div className="gdm-cover-placeholder"><FaGamepad /></div>}
          </div>

          <div className="gdm-info">
            <div className="gdm-kicker">{KICKER[status] || 'In your library'}</div>
            <h1 className="gdm-title">{game.game_name || game.name}</h1>

            <div className="gdm-meta">
              <div><span className="meta-label">Released</span><span>{date}</span></div>
              <div><span className="meta-label">Status</span><span className="genre-tag">{status}</span></div>
            </div>

            {/* THE HISTORY. Shown only when there is something to show: a game added
                before tracking began has no events, and an empty spine under a "History"
                heading reads as a bug rather than as an absence. */}
            {history && history.events.length > 0 && (
              <div className="gdm-timeline">
                <h3>History</h3>
                {history.daysToFinish != null && (
                  <div className="gdm-timeline-headline">
                    <FaHourglassHalf aria-hidden="true" />
                    <span>Took {formatDurationLong(history.daysToFinish)} to finish</span>
                  </div>
                )}
                <ul className="gdm-timeline-list">
                  {history.events.map((ev, i) => (
                    <li
                      key={`${ev.at}-${i}`}
                      className={`gdm-timeline-item${ev.source !== 'user' ? ' gdm-timeline-item--system' : ''}`}
                    >
                      <span>{describe(ev)}</span>
                      <span className="gdm-timeline-when">
                        {new Date(ev.at).toLocaleDateString()}
                      </span>
                      {ev.source !== 'user' && (
                        <span className="gdm-timeline-src">{SOURCE_LABEL[ev.source] || ev.source}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {history.truncated && (
                  <p className="stats-note">Older entries are not shown.</p>
                )}
              </div>
            )}

            <div className="gdm-actions">
              <h3>Update Status</h3>
              <div className="action-buttons">
                <button className="action-btn wishlist-btn" onClick={() => onSetStatus(game, 'wishlist')}>Wishlist</button>
                <button className="action-btn playing-btn"  onClick={() => onSetStatus(game, 'playing')}>Playing</button>
                <button className="action-btn done-btn"     onClick={() => onSetStatus(game, 'done')}>Done</button>
                <button className="action-btn remove-btn"   onClick={() => { onRemove(game); onClose() }}>Remove</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/*  HOW TO TRIGGER IT (in LibraryPage / SearchPage):

    const [openGame, setOpenGame] = useState(null)

    // on each .game-card, add an onClick that ignores clicks on inner controls:
    <div className="game-card ..."
         onClick={(e) => { if (e.target.closest('select,button,a')) return; setOpenGame(game) }}>
      ...existing card content...
    </div>

    // render once, after the grid:
    <GameDetailModal
      game={openGame}
      onClose={() => setOpenGame(null)}
      onSetStatus={setGameStatus}   // your existing handler
      onRemove={removeGame}         // your existing handler
    />
*/
