import type { Layer } from '../../types/index'
import type { StateManager } from '../../state/StateManager'
import { NOISE_COLORS, NOISE_LABELS } from '../../utils/colorMap'
import { showContextMenu } from '../components/ContextMenu'

export class LayerItem {
  readonly el: HTMLElement
  private layer: Layer
  private state: StateManager
  private isSelected: boolean

  constructor(layer: Layer, state: StateManager, isSelected: boolean) {
    this.layer = layer
    this.state = state
    this.isSelected = isSelected
    this.el = this.build()
  }

  private build(): HTMLElement {
    const { layer } = this
    const el = document.createElement('div')
    el.className = 'layer-item' + (this.isSelected ? ' selected' : '') + (!layer.visible ? ' hidden' : '')
    el.dataset.id = layer.id
    el.draggable = true

    // Drag handle
    const handle = document.createElement('div')
    handle.className = 'layer-handle'
    handle.innerHTML = `<svg width="10" height="14" viewBox="0 0 10 14"><circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/><circle cx="3" cy="6" r="1.5"/><circle cx="7" cy="6" r="1.5"/><circle cx="3" cy="10" r="1.5"/><circle cx="7" cy="10" r="1.5"/></svg>`

    // Visibility eye
    const eye = document.createElement('button')
    eye.className = 'layer-eye' + (layer.visible ? '' : ' off')
    eye.title = 'Toggle visibility'
    eye.innerHTML = layer.visible
      ? `<svg width="14" height="10" viewBox="0 0 14 10"><path d="M7 0C4 0 1 2.5 0 5c1 2.5 4 5 7 5s6-2.5 7-5C13 2.5 10 0 7 0zm0 8A3 3 0 1 1 7 2a3 3 0 0 1 0 6z" fill="currentColor"/></svg>`
      : `<svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 0L13 10M7 0C4 0 1 2.5 0 5c.7 1.8 2 3.2 3.5 4.1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>`
    eye.addEventListener('click', (e) => {
      e.stopPropagation()
      this.state.updateLayer(layer.id, { visible: !layer.visible })
    })

    // Color badge (noise type indicator)
    const badge = document.createElement('div')
    badge.className = 'layer-badge'
    badge.style.background = NOISE_COLORS[layer.noise.type]
    badge.title = NOISE_LABELS[layer.noise.type]

    // Name
    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = layer.name
    name.addEventListener('dblclick', () => {
      const input = document.createElement('input')
      input.className = 'layer-name-input'
      input.id = `layer-name-${layer.id}`
      input.name = `layer-name-${layer.id}`
      input.value = layer.name
      name.replaceWith(input)
      input.focus()
      input.select()
      const commit = () => {
        const val = input.value.trim() || layer.name
        this.state.updateLayer(layer.id, { name: val })
        input.replaceWith(name)
        name.textContent = val
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') { input.replaceWith(name) }
      })
    })

    // Blend mode badge
    const blendBadge = document.createElement('span')
    blendBadge.className = 'layer-blend-badge'
    blendBadge.textContent = layer.blendMode.charAt(0).toUpperCase() + layer.blendMode.slice(1)
    blendBadge.title = 'Blend mode (click to cycle)'
    const blendModes = ['normal','add','multiply','screen','overlay','subtract']
    blendBadge.addEventListener('click', (e) => {
      e.stopPropagation()
      const idx = blendModes.indexOf(layer.blendMode)
      const next = blendModes[(idx + 1) % blendModes.length] as Layer['blendMode']
      this.state.updateLayer(layer.id, { blendMode: next })
    })

    el.appendChild(handle)
    el.appendChild(eye)
    el.appendChild(badge)
    el.appendChild(name)
    el.appendChild(blendBadge)

    // Select on click
    el.addEventListener('click', () => {
      this.state.update('selected', layer.id)
    })

    // Right click context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showContextMenu([
        { label: 'Duplicate', icon: '⧉', action: () => this.state.duplicateLayer(layer.id) },
        { label: 'Move Up', icon: '↑', action: () => this.state.moveLayerUp(layer.id) },
        { label: 'Move Down', icon: '↓', action: () => this.state.moveLayerDown(layer.id) },
        { separator: true, label: '', action: () => {} },
        { label: 'Delete', icon: '✕', danger: true, action: () => this.state.removeLayer(layer.id) },
      ], e.clientX, e.clientY)
    })

    return el
  }
}
