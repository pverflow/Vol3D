import type { StateManager } from '../../state/StateManager'
import type { ExportConfig } from '../../types/index'
import { EXPORT_FORMAT_OPTIONS, ExportFormat } from '../../types/index'

export class ExportModal {
  constructor(private readonly state: StateManager) {}

  open(): void {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'modal'

    modal.innerHTML = `
      <div class="modal-header">
        <h2>Export Volume</h2>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="prop-row">
          <span class="prop-label">Format</span>
          <select class="ui-select" id="exp-format" name="exp-format">
            ${EXPORT_FORMAT_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Filename</span>
          <input type="text" class="top-input" id="exp-name" name="exp-name" value="noise_volume" style="flex:1">
        </div>
        <div class="prop-row">
          <label class="ui-toggle" style="margin:0">
            <input type="checkbox" id="exp-flipy" name="exp-flipy">
            <span class="toggle-track"><span class="toggle-knob"></span></span>
            <span class="toggle-label">Flip Y</span>
          </label>
        </div>
        <div class="modal-info">
          Resolution: <strong id="exp-res">${this.state.get('settings').resolution}×${this.state.get('settings').resolution}×${this.state.get('settings').depth}</strong>
          voxels
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary modal-cancel">Cancel</button>
        <button class="top-btn accent modal-export">Export</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove())
    overlay.querySelector('.modal-cancel')?.addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('.modal-export')?.addEventListener('click', () => {
      const format = (overlay.querySelector('#exp-format') as HTMLSelectElement).value
      const filenameBase = (overlay.querySelector('#exp-name') as HTMLInputElement).value || 'noise_volume'
      const flipY = (overlay.querySelector('#exp-flipy') as HTMLInputElement).checked
      overlay.remove()
      if (!Object.values(ExportFormat).includes(format as ExportFormat)) return
      // Trigger export event
      window.dispatchEvent(new CustomEvent<ExportConfig>('vol3d-export', {
        detail: { format: format as ExportFormat, filenameBase, flipY }
      }))
    })
  }
}
