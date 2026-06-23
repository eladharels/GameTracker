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

import { useEffect } from 'react'
import { FaGamepad, FaTimes } from 'react-icons/fa'

// Maps a normalized status to the kicker line shown above the title.
const KICKER = {
  playing: 'Currently playing',
  done: 'Completed',
  wishlist: 'On your wishlist',
  backlog: 'In your backlog',
  unreleased: 'Unreleased',
}

export default function GameDetailModal({ game, onClose, onSetStatus, onRemove }) {
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
