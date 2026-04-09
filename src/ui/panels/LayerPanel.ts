import type { StateManager } from '../../state/StateManager'
import { LayerItem } from './LayerItem'
import { defaultLayer } from '../../state/AppState'
import { NoiseType } from '../../types/index'
import { NOISE_COLORS, NOISE_LABELS } from '../../utils/colorMap'

export class LayerPanel {
  readonly el: HTMLElement
  private listEl!: HTMLElement
  private state: StateManager
  private dragSrcIdx: number | null = null

  constructor(state: StateManager) {
    this.state = state
    this.el = this.build()
    this.state.subscribe('layers', () => this.render())
    this.state.subscribe('selected', () => this.render())
    this.render()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'layer-panel'

    const header = document.createElement('div')
    header.className = 'panel-header'
    header.innerHTML = `<span class="panel-title">Layers</span>`

    const addBtn = document.createElement('button')
    addBtn.className = 'btn-icon'
    addBtn.title = 'Add layer (Ctrl+Shift+N)'
    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    addBtn.addEventListener('click', () => this.showAddMenu(addBtn))
    header.appendChild(addBtn)
    el.appendChild(header)

    this.listEl = document.createElement('div')
    this.listEl.className = 'layer-list'
    el.appendChild(this.listEl)

    return el
  }

  private render() {
    const layers = [...this.state.get('layers')].reverse() // Display top-to-bottom
    const selected = this.state.get('selected')

    this.listEl.innerHTML = ''
    layers.forEach((layer, displayIdx) => {
      const realIdx = this.state.get('layers').length - 1 - displayIdx
      const item = new LayerItem(layer, this.state, layer.id === selected)

      // Drag and drop
      item.el.addEventListener('dragstart', (e) => {
        this.dragSrcIdx = realIdx
        item.el.classList.add('dragging')
        e.dataTransfer!.effectAllowed = 'move'
      })
      item.el.addEventListener('dragend', () => {
        item.el.classList.remove('dragging')
        this.listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove())
      })
      item.el.addEventListener('dragover', (e) => {
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'
        const indicator = this.listEl.querySelector('.drop-indicator')
        if (!indicator) {
          const ind = document.createElement('div')
          ind.className = 'drop-indicator'
          this.listEl.insertBefore(ind, item.el)
        }
      })
      item.el.addEventListener('drop', (e) => {
        e.preventDefault()
        if (this.dragSrcIdx !== null && this.dragSrcIdx !== realIdx) {
          this.state.reorderLayers(this.dragSrcIdx, realIdx)
        }
        this.dragSrcIdx = null
      })

      this.listEl.appendChild(item.el)
    })

    if (layers.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'layer-empty'
      empty.textContent = 'No layers. Click + to add one.'
      this.listEl.appendChild(empty)
    }
  }

  private showAddMenu(anchor: HTMLElement) {
    // Quick picker popup
    const popup = document.createElement('div')
    popup.className = 'add-layer-popup'

    const types = Object.values(NoiseType)
    for (const type of types) {
      const btn = document.createElement('button')
      btn.className = 'add-layer-option'
      const dot = document.createElement('span')
      dot.className = 'noise-dot'
      dot.style.background = NOISE_COLORS[type]
      btn.appendChild(dot)
      btn.appendChild(document.createTextNode(NOISE_LABELS[type]))
      btn.addEventListener('click', () => {
        const layerCount = this.state.get('layers').length
        this.state.addLayer(defaultLayer(`${NOISE_LABELS[type]} ${layerCount + 1}`, type))
        popup.remove()
      })
      popup.appendChild(btn)
    }

    document.body.appendChild(popup)
    const rect = anchor.getBoundingClientRect()
    popup.style.top = `${rect.bottom + 4}px`
    popup.style.left = `${rect.left}px`

    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          popup.remove()
          document.removeEventListener('mousedown', close)
        }
      }
      document.addEventListener('mousedown', close)
    }, 10)
  }
}
