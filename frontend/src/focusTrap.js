// Keep Tab inside a dialog: from the last focusable element wrap to the first, and back.
// Attach as the dialog container's onKeyDown. Shared by App.jsx's dialogs and
// GameDetailModal (ROADMAP FE-7) — it lived inside App.jsx, which is why GameDetailModal,
// in its own file, had none. Every dialog reaches it through useDialogFocus (FE-19).
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
  // Focus on something that is not in the list — the dialog container itself (after a
  // click on a non-focusable area, or when it took the initial focus) — must still wrap
  // INSIDE: from there Shift+Tab used to walk straight out to the page behind (FE-19).
  if (!focusable.includes(document.activeElement)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus() }
  } else if (document.activeElement === last) {
    e.preventDefault(); first.focus()
  }
}
