/**
 * Positions `popup` under `anchor`, clamped to the viewport, appends it to the
 * DOM, and wires the outside-mousedown-to-close pattern shared by the layer
 * blend-mode menu, the add-layer menu, and the presets menu.
 *
 * Returns a `close()` that removes the popup and its listener. Callers should
 * invoke it (instead of `popup.remove()`) when an item inside the popup is
 * picked, so the outside-click listener is cleaned up immediately.
 */
export function openAnchoredPopup(anchor: HTMLElement, popup: HTMLElement): () => void {
  document.body.appendChild(popup)

  const rect = anchor.getBoundingClientRect()
  const margin = 8
  const popupWidth = popup.offsetWidth
  const popupHeight = popup.offsetHeight
  const maxLeft = Math.max(margin, window.innerWidth - popupWidth - margin)
  const maxTop = Math.max(margin, window.innerHeight - popupHeight - margin)

  // Hug the anchor's left edge, but flip to hug its right edge if that would
  // run the popup off the right side of the viewport (e.g. an anchor sitting
  // near the window's right edge).
  // This flip's correctness relies on the app's fixed right-docked ~320px
  // sidebar geometry: popups anchored near the right edge flip to right-align.
  const fitsRight = rect.left + popupWidth + margin <= window.innerWidth
  const desiredLeft = fitsRight ? rect.left : rect.right - popupWidth
  const desiredTop = rect.bottom + 4

  popup.style.left = `${Math.min(Math.max(desiredLeft, margin), maxLeft)}px`
  popup.style.top = `${Math.min(desiredTop, maxTop)}px`

  const onOutsideMousedown = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node)) close()
  }

  function close() {
    popup.remove()
    document.removeEventListener('mousedown', onOutsideMousedown)
  }

  setTimeout(() => {
    document.addEventListener('mousedown', onOutsideMousedown)
  }, 10)

  return close
}
