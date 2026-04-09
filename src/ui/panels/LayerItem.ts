import type { Layer } from '../../types/index'
import type { StateManager } from '../../state/StateManager'
import { BlendMode } from '../../types/index'
import { NOISE_COLORS, NOISE_LABELS } from '../../utils/colorMap'
import { showContextMenu } from '../components/ContextMenu'

const BLEND_OPTIONS: Array<{ value: BlendMode, label: string }> = [
  { value: BlendMode.Normal, label: 'Normal' },
  { value: BlendMode.Add, label: 'Add' },
  { value: BlendMode.Multiply, label: 'Multiply' },
  { value: BlendMode.Screen, label: 'Screen' },
  { value: BlendMode.Overlay, label: 'Overlay' },
  { value: BlendMode.Subtract, label: 'Subtract' },
]

export class LayerItem {
  readonly el: HTMLElement
  private layer: Layer
  private state: StateManager
  private isSelected: boolean
  private pendingOpacity: number
  private eyeEl!: HTMLButtonElement
  private badgeEl!: HTMLElement
  private nameEl!: HTMLElement
  private opacityWrapEl!: HTMLElement
  private opacitySliderEl!: HTMLInputElement
  private blendBadgeEl!: HTMLButtonElement

  constructor(layer: Layer, state: StateManager, isSelected: boolean) {
    this.layer = layer
    this.state = state
    this.isSelected = isSelected
    this.pendingOpacity = layer.opacity
    this.el = this.build()
    this.syncUI()
  }

  update(layer: Layer, isSelected: boolean) {
    this.layer = layer
    this.isSelected = isSelected
    this.pendingOpacity = layer.opacity
    this.syncUI()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'layer-item'
    el.draggable = false

    const handleEl = document.createElement('div')
    handleEl.className = 'layer-handle'
    handleEl.draggable = true
    handleEl.title = 'Drag to reorder'
    handleEl.innerHTML = `<svg width="10" height="14" viewBox="0 0 10 14"><circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/><circle cx="3" cy="6" r="1.5"/><circle cx="7" cy="6" r="1.5"/><circle cx="3" cy="10" r="1.5"/><circle cx="7" cy="10" r="1.5"/></svg>`

    this.eyeEl = document.createElement('button')
    this.eyeEl.className = 'layer-eye'
    this.eyeEl.title = 'Toggle visibility'
    this.eyeEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.state.updateLayer(this.layer.id, { visible: !this.layer.visible })
    })

    this.badgeEl = document.createElement('div')
    this.badgeEl.className = 'layer-badge'

    this.nameEl = document.createElement('span')
    this.nameEl.className = 'layer-name'
    this.nameEl.title = 'Double-click to rename'
    this.nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.startRename()
    })

    this.opacityWrapEl = document.createElement('div')
    this.opacityWrapEl.className = 'layer-opacity-wrap'

    this.opacitySliderEl = document.createElement('input')
    this.opacitySliderEl.type = 'range'
    this.opacitySliderEl.className = 'layer-opacity-slider'
    this.opacitySliderEl.min = '0'
    this.opacitySliderEl.max = '100'
    this.opacitySliderEl.step = '1'
    const stopEvent = (e: Event) => e.stopPropagation()
    this.opacitySliderEl.addEventListener('pointerdown', stopEvent)
    this.opacitySliderEl.addEventListener('mousedown', stopEvent)
    this.opacitySliderEl.addEventListener('click', stopEvent)
    this.opacitySliderEl.addEventListener('dblclick', stopEvent)
    this.opacitySliderEl.addEventListener('input', (e) => {
      e.stopPropagation()
      this.pendingOpacity = parseInt(this.opacitySliderEl.value) / 100
      this.opacityWrapEl.title = `Opacity ${Math.round(this.pendingOpacity * 100)}%`
    })
    this.opacitySliderEl.addEventListener('change', (e) => {
      e.stopPropagation()
      this.state.updateLayer(this.layer.id, { opacity: this.pendingOpacity })
    })
    this.opacitySliderEl.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.pendingOpacity = 1
      this.opacitySliderEl.value = '100'
      this.opacityWrapEl.title = 'Opacity 100%'
      this.state.updateLayer(this.layer.id, { opacity: 1 })
    })
    this.opacityWrapEl.appendChild(this.opacitySliderEl)

    this.blendBadgeEl = document.createElement('button')
    this.blendBadgeEl.className = 'layer-blend-badge'
    this.blendBadgeEl.title = 'Select blend mode'
    this.blendBadgeEl.addEventListener('click', (e) => {
      e.stopPropagation()
      this.showBlendMenu(this.blendBadgeEl)
    })

    el.appendChild(handleEl)
    el.appendChild(this.eyeEl)
    el.appendChild(this.badgeEl)
    el.appendChild(this.nameEl)
    el.appendChild(this.opacityWrapEl)
    el.appendChild(this.blendBadgeEl)

    el.addEventListener('click', () => {
      if (!this.isSelected) {
        this.state.update('selected', this.layer.id)
      }
    })

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showContextMenu([
        { label: 'Duplicate', icon: '⧉', action: () => this.state.duplicateLayer(this.layer.id) },
        { label: 'Move Up', icon: '↑', action: () => this.state.moveLayerUp(this.layer.id) },
        { label: 'Move Down', icon: '↓', action: () => this.state.moveLayerDown(this.layer.id) },
        { separator: true, label: '', action: () => {} },
        { label: 'Delete', icon: '✕', danger: true, action: () => this.state.removeLayer(this.layer.id) },
      ], e.clientX, e.clientY)
    })

    return el
  }

  private startRename() {
    if (this.nameEl.parentElement === null) return

    const input = document.createElement('input')
    input.className = 'layer-name-input'
    input.id = `layer-name-${this.layer.id}`
    input.name = `layer-name-${this.layer.id}`
    input.value = this.layer.name.slice(0, 16)
    input.maxLength = 16
    this.nameEl.replaceWith(input)
    input.focus()
    input.select()

    const commit = () => {
      const fallback = this.layer.name.slice(0, 16)
      const val = input.value.trim().slice(0, 16) || fallback
      this.state.updateLayer(this.layer.id, { name: val })
      if (input.isConnected) input.replaceWith(this.nameEl)
      this.nameEl.textContent = val
    }

    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape' && input.isConnected) {
        input.replaceWith(this.nameEl)
      }
    })
  }

  private syncUI() {
    this.el.dataset.id = this.layer.id
    this.el.classList.toggle('selected', this.isSelected)
    this.el.classList.toggle('hidden', !this.layer.visible)

    this.eyeEl.classList.toggle('off', !this.layer.visible)
    this.eyeEl.innerHTML = this.layer.visible
      ? `<svg width="14" height="10" viewBox="0 0 14 10"><path d="M7 0C4 0 1 2.5 0 5c1 2.5 4 5 7 5s6-2.5 7-5C13 2.5 10 0 7 0zm0 8A3 3 0 1 1 7 2a3 3 0 0 1 0 6z" fill="currentColor"/></svg>`
      : `<svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 0L13 10M7 0C4 0 1 2.5 0 5c.7 1.8 2 3.2 3.5 4.1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`

    this.badgeEl.style.background = NOISE_COLORS[this.layer.noise.type]
    this.badgeEl.title = NOISE_LABELS[this.layer.noise.type]

    if (!this.el.querySelector('.layer-name-input')) {
      this.nameEl.textContent = this.layer.name
    }

    if (document.activeElement !== this.opacitySliderEl) {
      this.opacitySliderEl.id = `layer-opacity-${this.layer.id}`
      this.opacitySliderEl.name = `layer-opacity-${this.layer.id}`
      this.opacitySliderEl.value = String(Math.round(this.layer.opacity * 100))
    }
    this.opacityWrapEl.title = `Opacity ${Math.round((document.activeElement === this.opacitySliderEl ? this.pendingOpacity : this.layer.opacity) * 100)}%`

    this.blendBadgeEl.textContent = this.layer.blendMode.charAt(0).toUpperCase() + this.layer.blendMode.slice(1)
  }

  private showBlendMenu(anchor: HTMLElement) {
    document.querySelectorAll('.layer-blend-popup').forEach(el => el.remove())

    const popup = document.createElement('div')
    popup.className = 'layer-blend-popup'

    for (const option of BLEND_OPTIONS) {
      const btn = document.createElement('button')
      btn.className = 'layer-blend-option'
      btn.textContent = option.label
      if (this.layer.blendMode === option.value) btn.classList.add('active')
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.state.updateLayer(this.layer.id, { blendMode: option.value })
        popup.remove()
      })
      popup.appendChild(btn)
    }

    document.body.appendChild(popup)
    const rect = anchor.getBoundingClientRect()
    const margin = 8
    const popupWidth = popup.offsetWidth
    const popupHeight = popup.offsetHeight
    const desiredLeft = rect.right - popupWidth
    const desiredTop = rect.bottom + 4
    const maxLeft = Math.max(margin, window.innerWidth - popupWidth - margin)
    const maxTop = Math.max(margin, window.innerHeight - popupHeight - margin)

    popup.style.left = `${Math.min(Math.max(desiredLeft, margin), maxLeft)}px`
    popup.style.top = `${Math.min(desiredTop, maxTop)}px`

    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (e.target === anchor) return
        if (!popup.contains(e.target as Node)) {
          popup.remove()
          document.removeEventListener('mousedown', close)
        }
      }
      document.addEventListener('mousedown', close)
    }, 10)
  }
}
