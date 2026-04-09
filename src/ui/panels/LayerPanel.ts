import type { StateManager } from '../../state/StateManager'
import { LayerItem } from './LayerItem'
import { defaultLayer } from '../../state/AppState'
import { NoiseType } from '../../types/index'
import { NOISE_COLORS, NOISE_LABELS } from '../../utils/colorMap'

export class LayerPanel {
  readonly el: HTMLElement
  private listEl!: HTMLElement
  private state: StateManager
  private items = new Map<string, LayerItem>()
  private dragSrcId: string | null = null

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
    header.className = 'panel-header layer-panel-header'

    const addBtn = document.createElement('button')
    addBtn.className = 'btn-icon'
    addBtn.title = 'Add layer (Ctrl+Shift+N)'
    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    addBtn.addEventListener('click', () => this.showAddMenu(addBtn))
    header.appendChild(addBtn)

    const title = document.createElement('span')
    title.className = 'panel-title'
    title.textContent = 'Layers'
    header.appendChild(title)
    el.appendChild(header)

    this.listEl = document.createElement('div')
    this.listEl.className = 'layer-list'
    this.attachDragDrop()
    el.appendChild(this.listEl)

    return el
  }

  private attachDragDrop() {
    this.listEl.addEventListener('dragstart', (e) => {
      const handle = (e.target as HTMLElement | null)?.closest('.layer-handle') as HTMLElement | null
      const row = handle?.closest('.layer-item') as HTMLElement | null
      const id = row?.dataset.id
      if (!row || !id || !e.dataTransfer) return

      this.dragSrcId = id
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    this.listEl.addEventListener('dragend', () => {
      this.dragSrcId = null
      this.listEl.querySelectorAll('.layer-item.dragging').forEach(el => el.classList.remove('dragging'))
      this.listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove())
    })

    this.listEl.addEventListener('dragover', (e) => {
      const row = (e.target as HTMLElement | null)?.closest('.layer-item') as HTMLElement | null
      if (!row || !this.dragSrcId || row.dataset.id === this.dragSrcId || !e.dataTransfer) return

      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      let indicator = this.listEl.querySelector('.drop-indicator') as HTMLElement | null
      if (!indicator) {
        indicator = document.createElement('div')
        indicator.className = 'drop-indicator'
      }
      this.listEl.insertBefore(indicator, row)
    })

    this.listEl.addEventListener('drop', (e) => {
      const row = (e.target as HTMLElement | null)?.closest('.layer-item') as HTMLElement | null
      const targetId = row?.dataset.id
      if (!row || !targetId || !this.dragSrcId) return

      e.preventDefault()
      const displayedLayers = [...this.state.get('layers')].reverse()
      const from = displayedLayers.findIndex(layer => layer.id === this.dragSrcId)
      const to = displayedLayers.findIndex(layer => layer.id === targetId)
      if (from >= 0 && to >= 0 && from !== to) {
        const reordered = [...displayedLayers]
        const [moved] = reordered.splice(from, 1)
        const insertAt = from < to ? to - 1 : to
        reordered.splice(insertAt, 0, moved)
        this.state.update('layers', reordered.reverse())
      }
      this.dragSrcId = null
      this.listEl.querySelectorAll('.layer-item.dragging').forEach(el => el.classList.remove('dragging'))
      this.listEl.querySelectorAll('.drop-indicator').forEach(el => el.remove())
    })
  }

  private render() {
    const layers = [...this.state.get('layers')].reverse() // Display top-to-bottom
    const selected = this.state.get('selected')

    const activeIds = new Set(layers.map(layer => layer.id))

    if (layers.length === 0) {
      this.items.forEach(item => item.el.remove())
      this.items.clear()

      const empty = document.createElement('div')
      empty.className = 'layer-empty'
      empty.textContent = 'No layers. Click + to add one.'
      this.listEl.replaceChildren(empty)
      return
    }

    this.listEl.querySelector('.layer-empty')?.remove()

    layers.forEach((layer, index) => {
      let item = this.items.get(layer.id)
      if (!item) {
        item = new LayerItem(layer, this.state, layer.id === selected)
        this.items.set(layer.id, item)
      } else {
        item.update(layer, layer.id === selected)
      }
      const currentChild = this.listEl.children[index] ?? null
      if (currentChild !== item.el) {
        this.listEl.insertBefore(item.el, currentChild)
      }
    })

    for (const [id, item] of this.items.entries()) {
      if (!activeIds.has(id)) {
        item.el.remove()
        this.items.delete(id)
      }
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
    const margin = 8
    const desiredTop = rect.bottom + 4
    const desiredLeft = rect.left
    const popupWidth = popup.offsetWidth
    const popupHeight = popup.offsetHeight
    const maxLeft = Math.max(margin, window.innerWidth - popupWidth - margin)
    const maxTop = Math.max(margin, window.innerHeight - popupHeight - margin)

    popup.style.top = `${Math.min(desiredTop, maxTop)}px`
    popup.style.left = `${Math.min(Math.max(desiredLeft, margin), maxLeft)}px`

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
