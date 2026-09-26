// Focus handling for EVERY modal dialog (ROADMAP FE-19). One hook, because each dialog had
// its own partial copy: the user-management dialogs focused an input after a 50 ms
// setTimeout and never gave focus back; the delete-confirm alertdialog got no initial
// focus at all (an alertdialog must have one); SharedLibrary's two aria-modal dialogs had
// no trap, no initial focus and no return. GameDetailModal had the complete version
// (FE-7), and this is that version, generalised.
//
//   isOpen        drives it. Keyed on open/closed, not on content, which refetches replace.
//   initialRef    what to focus on open. For an alertdialog, the LEAST destructive action.
//                 Without one, the dialog element itself (give it tabIndex={-1}).
//   dialogRef     the dialog element: the no-initialRef fallback.
//   fallbackRef   where focus goes on close when the opener is GONE (Remove deleted the
//                 card, a filter unmounted it). Then the page heading — never <body>.
//   onEscape      optional; called on Escape pressed inside the dialog.
//
// Returns { onKeyDown } for the dialog element: the Tab trap (focusTrap.js, kept React-free
// for its import() test) plus Escape.
import { useCallback, useEffect } from 'react'
import { handleModalFocusTrap } from './focusTrap'

export function useDialogFocus(isOpen, { initialRef, dialogRef, fallbackRef, onEscape } = {}) {
  useEffect(() => {
    if (!isOpen) return undefined
    const opener = document.activeElement
    // Focus INTO the dialog on open. It used to stay on the page behind, so the next Tab
    // walked the hidden page under an aria-modal dialog.
    const target = initialRef?.current || dialogRef?.current
    target?.focus()
    return () => {
      // Read at CLOSE time: the node that opened the dialog may have been replaced.
      if (opener && typeof opener.focus === 'function' && opener !== document.body && document.contains(opener)) {
        opener.focus()
      } else {
        // preventScroll: a mouse user's opener is <body>, so this runs for them too and
        // must not jump the page. fallbackRef is read HERE, at close, on purpose: the list
        // is re-keyed on filter/page while the dialog is open, so the node to fall back to
        // is the one that exists NOW, not the one captured on open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        ((fallbackRef && fallbackRef.current) || document.querySelector('.page-title'))
          ?.focus({ preventScroll: true })
      }
    }
    // The refs are stable objects; only open/closed should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape' && onEscape) {
      e.stopPropagation()
      onEscape()
      return
    }
    handleModalFocusTrap(e)
  }, [onEscape])

  return { onKeyDown }
}
