// The shared dialog focus hook (FE-19). GameDetailModal's own tests still cover it in
// situ; these pin the hook's contract for every other dialog that now depends on it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { useDialogFocus } from './useDialogFocus'

afterEach(cleanup)

function Harness({ withInitial = true, onEscape, removeOpenerOnClose = false }) {
  const [open, setOpen] = useState(false)
  const [openerShown, setOpenerShown] = useState(true)
  const initialRef = useRef(null)
  const dialogRef = useRef(null)
  const listRef = useRef(null)
  const { onKeyDown } = useDialogFocus(open, {
    initialRef: withInitial ? initialRef : undefined, dialogRef, fallbackRef: listRef, onEscape,
  })
  const close = () => { if (removeOpenerOnClose) setOpenerShown(false); setOpen(false) }
  return (
    <>
      <div ref={listRef} tabIndex={-1} aria-label="the list">
        {openerShown && <button onClick={() => setOpen(true)}>Open</button>}
      </div>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="Test dialog" ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
          <button ref={initialRef} onClick={close}>Cancel</button>
          <input aria-label="Name" />
          <button onClick={close}>Delete</button>
        </div>
      )}
    </>
  )
}
const open = () => { const b = screen.getByRole('button', { name: 'Open' }); b.focus(); fireEvent.click(b) }

describe('useDialogFocus (FE-19)', () => {
  it('focuses the initial element on open — the SAFE action for an alertdialog', () => {
    render(<Harness />); open()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })
  it('without an initial element, focuses the dialog itself', () => {
    render(<Harness withInitial={false} />); open()
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
  it('gives focus back to the opener on close', () => {
    render(<Harness />); open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }))
  })
  it('falls back to the list when the opener is gone — never <body>', () => {
    render(<Harness removeOpenerOnClose />); open()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(document.activeElement).toBe(screen.getByLabelText('the list'))
  })
  it('keeps Tab inside, including from the dialog container itself', () => {
    render(<Harness withInitial={false} />); open()
    const dialog = screen.getByRole('dialog')
    const [first, last] = [screen.getByRole('button', { name: 'Cancel' }), screen.getByRole('button', { name: 'Delete' })]
    // Focus is on the container (not in the focusable list): Shift+Tab used to leave.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
  it('calls onEscape for Escape pressed inside', () => {
    const onEscape = vi.fn()
    render(<Harness onEscape={onEscape} />); open()
    fireEvent.keyDown(document.activeElement, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})
