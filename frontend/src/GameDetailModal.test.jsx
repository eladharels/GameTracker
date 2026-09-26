// Behaviour tests for the detail dialog's focus handling (FE-7). These replace the
// source-text shape pins that stood in for them in test/runtime.test.js (ROADMAP UP-20).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import GameDetailModal from './GameDetailModal'

afterEach(cleanup)

const GAME = { game_id: 'igdb_1', game_name: 'Hades', status: 'playing', release_date: '2020-09-17' }

// A card that opens the dialog, and a list the dialog falls back to — the library's shape.
function Harness({ onRemoveCard }) {
  const [open, setOpen] = useState(null)
  const [cardShown, setCardShown] = useState(true)
  const listRef = useRef(null)
  return (
    <>
      <div ref={listRef} tabIndex={-1} role="region" aria-label="Your games">
        {cardShown && <button type="button" onClick={() => setOpen(GAME)}>Open Hades</button>}
      </div>
      <GameDetailModal
        game={open}
        onClose={() => setOpen(null)}
        onSetStatus={() => {}}
        onRemove={() => { setCardShown(false); onRemoveCard?.() }}
        fallbackFocusRef={listRef}
      />
    </>
  )
}

describe('GameDetailModal focus (FE-7)', () => {
  it('moves focus into the dialog on open', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open Hades' })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Hades' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('returns focus to the card that opened it on close', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open Hades' })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('falls back to the list when the opener is gone, never <body>', () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open Hades' })
    opener.focus()
    fireEvent.click(opener)
    // The dialog's Remove unmounts the card and closes, as the library's does.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByRole('button', { name: 'Open Hades' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Your games' }))
  })

  it('closes on Escape', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Hades' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps Tab inside the dialog', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Hades' }))
    // The dialog's buttons are its only focusable elements; a real key event starts at
    // the focused element and bubbles to the dialog's handler.
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button')
    // With one focusable element first === last and this test would pass with no trap.
    expect(buttons.length).toBeGreaterThan(1)
    const [first, last] = [buttons[0], buttons[buttons.length - 1]]
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('renders nothing when no game is open', () => {
    render(<GameDetailModal game={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
