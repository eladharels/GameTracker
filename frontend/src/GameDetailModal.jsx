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
import { formatDurationLong, formatDateTimeReadable, statusProse } from './dateUtils'

const API_BASE = `${window.location.origin}/api`

// How a single transition reads in prose. `from` is null for the row that records the
// game being added, which is why that case is spelled out rather than left to render as
// "null → wishlist".
function describe(ev) {
  if (!ev.from) return `Added as ${statusProse(ev.to)}`
  return `${statusProse(ev.from)} → ${statusProse(ev.to)}`
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
  // A failure SAYS SO. It used to store null, which renders exactly what "this game
  // predates tracking" renders — the one conflation CLAUDE.md and frontend/README.md
  // both single out, because an absence and a failure that look alike teach the user
  // their data is gone.
  //
  // The response is SHAPE-CHECKED before it is stored. `res.data` was trusted, so a 200
  // carrying a proxy's HTML error page (a String) or any object without `events` made
  // `history` truthy and `history.events.length` a TypeError thrown during render. There
  // is no error boundary anywhere in this app, so that empties #root: no sidebar, no nav,
  // no way back — from a modal opened by clicking any card.
  const [history, setHistory] = useState(null)
  const gameId = game ? (game.game_id || game.gameId) : null
  useEffect(() => {
    if (!gameId || !username) { setHistory(null); return }
    let cancelled = false
    setHistory(null)
    axios.get(`${API_BASE}/user/${encodeURIComponent(username)}/games/${encodeURIComponent(gameId)}/history`)
      .then((res) => {
        if (cancelled) return
        const d = res.data
        if (!d || typeof d !== 'object' || !Array.isArray(d.events)) {
          setHistory({ failed: true, events: [] })
          return
        }
        setHistory(d)
      })
      .catch(() => { if (!cancelled) setHistory({ failed: true, events: [] }) })
    return () => { cancelled = true }
    // Keyed on the game's ID and status, not the object: the library refetches produce a
    // new object for the same game on every poll, which would re-issue this request
    // while the modal sits open.
  }, [gameId, game?.status, username])

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
              <div><span className="meta-label">Status</span><span className="genre-tag">{statusProse(status)}</span></div>
            </div>

            {/* THE HISTORY. Shown when there is something to show OR something to say:
                a game added before tracking began has no events, and an empty spine under
                a "History" heading reads as a bug rather than as an absence — but a
                FAILED load must not render as that same absence. */}
            {history?.failed && (
              <div className="gdm-timeline">
                <h3>History</h3>
                <p className="stats-note">Couldn&rsquo;t load this game&rsquo;s history.</p>
              </div>
            )}
            {!history?.failed && history?.events?.length > 0 && (
              <div className="gdm-timeline">
                {/* The direction is STATED. Both statistics panels are newest-first and say
                    so in their headings; a bare "History" left the reader to infer it from
                    the content. Oldest-first here because a timeline is read as a story. */}
                <h3>History <span className="gdm-timeline-dir">oldest first</span></h3>
                {history.daysToFinish != null && (
                  <div className="gdm-timeline-headline">
                    <FaHourglassHalf aria-hidden="true" />
                    <span>Took {formatDurationLong(history.daysToFinish)} to finish</span>
                  </div>
                )}
                {/* role="list" because `list-style: none` strips the implicit role in
                    Safari/VoiceOver, so "list, 12 items" would never be announced. */}
                <ul className="gdm-timeline-list" role="list">
                  {history.events.map((ev, i) => (
                    <li
                      key={`${ev.at}-${i}`}
                      className={`gdm-timeline-item${ev.source !== 'user' ? ' gdm-timeline-item--system' : ''}`}
                    >
                      <span>{describe(ev)}</span>
                      {/* WITH the time: two transitions on the same day render as two
                          identical dates otherwise, which reads as a duplicated row. */}
                      <time className="gdm-timeline-when" dateTime={ev.at}>
                        {formatDateTimeReadable(ev.at)}
                      </time>
                      {ev.source !== 'user' && (
                        <span className="gdm-timeline-src">{SOURCE_LABEL[ev.source] || ev.source}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {/* OLDER, and that is now true: the query takes the newest rows and the
                    service reverses them, so truncation drops the old end. */}
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
