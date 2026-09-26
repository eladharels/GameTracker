// Keep Tab inside a dialog: from the last focusable element wrap to the first, and back.
// Attach as the dialog container's onKeyDown. Shared by every modal (ROADMAP FE-7) — it
// lived inside App.jsx, which is why GameDetailModal, in its own file, had none.
//
// Pure DOM-event logic, nothing at module scope.
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
