import type { StateManager } from '../state/StateManager'
import { defaultLayer } from '../state/AppState'

interface KeyBindingsViewport {
  cyclePreviewMode(): void
  toggleTilePreview(): void
  focusCamera(): void
}

/** Owns the app-level keyboard shortcuts (layer ops, export dialog) plus the
 * view-local ones (Tab/T/F), delegating the latter to the viewport. */
export class KeyBindings {
  private handler = (e: KeyboardEvent) => this.handleKey(e)

  constructor(private state: StateManager, private viewport: KeyBindingsViewport) {
    window.addEventListener('keydown', this.handler)
  }

  destroy() {
    window.removeEventListener('keydown', this.handler)
  }

  private handleKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    const state = this.state
    // Tab = cycle preview mode
    if (e.key === 'Tab') {
      e.preventDefault()
      this.viewport.cyclePreviewMode()
    }
    // T = toggle tile preview
    if (e.key === 't' || e.key === 'T') {
      this.viewport.toggleTilePreview()
    }
    // F = focus/reset camera
    if (e.key === 'f' || e.key === 'F') {
      this.viewport.focusCamera()
    }
    // Delete = delete selected layer
    if (e.key === 'Delete') {
      const sel = state.get('selected')
      if (sel) state.removeLayer(sel)
    }
    // Ctrl+D = duplicate
    if (e.ctrlKey && e.key === 'd') {
      e.preventDefault()
      const sel = state.get('selected')
      if (sel) state.duplicateLayer(sel)
    }
    // Ctrl+Shift+N = add layer
    if (e.ctrlKey && e.shiftKey && e.key === 'N') {
      e.preventDefault()
      state.addLayer(defaultLayer())
    }
    // Ctrl+E = export
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('vol3d-show-export'))
    }
  }
}
