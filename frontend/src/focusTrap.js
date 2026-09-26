// Keep Tab inside a dialog: from the last focusable element wrap to the first, and back.
// Attach as the dialog container's onKeyDown. Shared by App.jsx's dialogs and
// GameDetailModal (ROADMAP FE-7) — it lived inside App.jsx, which is why GameDetailModal,
// in its own file, had none. SharedLibrary's two dialogs do not use it yet (FE-19).
//
// Reads `document` when it RUNS, never at module scope — so helpers.test.js can import it
// in plain Node and stub `document` per test.
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'

export function handleModalFocusTrap(e) {
  if (e.key !== 'Tab') return
  const focusable = Array.from(e.currentTarget.querySelectorAll(FOCUSABLE)).filter(el => !el.disabled)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus() }
  } else if (document.activeElement === last) {
    e.preventDefault(); first.focus()
  }
}
