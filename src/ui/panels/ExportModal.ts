import type { StateManager } from '../../state/StateManager'
import type { ExportRequest } from '../../types/index'
import { EXPORT_FORMAT_OPTIONS, ExportFormat } from '../../types/index'
import { defaultFlipbookCols } from '../../core/export/flipbookGrid'

const DEFAULT_FLIPBOOK_FRAMES = 32
const FLIPBOOK_TILE_RES_OPTIONS = [128, 256, 512] as const

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
        <div class="prop-row" id="exp-flipy-row">
          <label class="ui-toggle" style="margin:0">
            <input type="checkbox" id="exp-flipy" name="exp-flipy">
            <span class="toggle-track"><span class="toggle-knob"></span></span>
            <span class="toggle-label">Flip Y</span>
          </label>
        </div>
        <div id="exp-flipbook-fields" style="display:none">
          <div class="prop-row">
            <span class="prop-label">Frames</span>
            <input type="number" class="top-input" id="exp-fb-frames" name="exp-fb-frames" value="${DEFAULT_FLIPBOOK_FRAMES}" min="1" max="256" step="1">
          </div>
          <div class="prop-row">
            <span class="prop-label">FPS</span>
            <input type="number" class="top-input" id="exp-fb-fps" name="exp-fb-fps" value="24" min="1" max="120" step="1">
          </div>
          <div class="prop-row">
            <span class="prop-label">Tile Res</span>
            <select class="ui-select" id="exp-fb-tileres" name="exp-fb-tileres">
              ${FLIPBOOK_TILE_RES_OPTIONS.map(r => `<option value="${r}"${r === 256 ? ' selected' : ''}>${r}×${r}</option>`).join('')}
            </select>
          </div>
          <div class="prop-row">
            <span class="prop-label">Columns</span>
            <input type="number" class="top-input" id="exp-fb-cols" name="exp-fb-cols" value="${defaultFlipbookCols(DEFAULT_FLIPBOOK_FRAMES)}" min="1" max="64" step="1">
          </div>
          <div class="prop-row">
            <label class="ui-toggle" style="margin:0">
              <input type="checkbox" id="exp-fb-pngseq" name="exp-fb-pngseq">
              <span class="toggle-track"><span class="toggle-knob"></span></span>
              <span class="toggle-label">Also export PNG sequence (ZIP)</span>
            </label>
          </div>
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

    const formatSelect = overlay.querySelector('#exp-format') as HTMLSelectElement
    const flipyRow = overlay.querySelector('#exp-flipy-row') as HTMLElement
    const flipbookFields = overlay.querySelector('#exp-flipbook-fields') as HTMLElement
    const syncFieldsForFormat = () => {
      const isFlipbook = formatSelect.value === ExportFormat.Flipbook
      flipbookFields.style.display = isFlipbook ? 'block' : 'none'
      flipyRow.style.display = isFlipbook ? 'none' : 'flex'
    }
    formatSelect.addEventListener('change', syncFieldsForFormat)
    syncFieldsForFormat()

    overlay.querySelector('.modal-export')?.addEventListener('click', () => {
      const format = formatSelect.value
      const filenameBase = (overlay.querySelector('#exp-name') as HTMLInputElement).value || 'noise_volume'
      if (!Object.values(ExportFormat).includes(format as ExportFormat)) return

      let detail: ExportRequest
      if (format === ExportFormat.Flipbook) {
        const frames = clampInt((overlay.querySelector('#exp-fb-frames') as HTMLInputElement).value, 1, 256, DEFAULT_FLIPBOOK_FRAMES)
        const fps = clampInt((overlay.querySelector('#exp-fb-fps') as HTMLInputElement).value, 1, 120, 24)
        const tileRes = clampInt((overlay.querySelector('#exp-fb-tileres') as HTMLSelectElement).value, 1, 4096, 256)
        const cols = clampInt((overlay.querySelector('#exp-fb-cols') as HTMLInputElement).value, 1, 64, defaultFlipbookCols(frames))
        const pngSequence = (overlay.querySelector('#exp-fb-pngseq') as HTMLInputElement).checked
        detail = { format: ExportFormat.Flipbook, filenameBase, frames, fps, tileRes, cols, pngSequence }
      } else {
        const flipY = (overlay.querySelector('#exp-flipy') as HTMLInputElement).checked
        detail = { format: format as Exclude<ExportFormat, ExportFormat.Flipbook>, filenameBase, flipY }
      }

      overlay.remove()
      window.dispatchEvent(new CustomEvent<ExportRequest>('vol3d-export', { detail }))
    })
  }
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
