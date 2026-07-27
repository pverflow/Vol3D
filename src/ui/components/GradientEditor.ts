// Color-ramp (transfer function) editor (VFX-0 Task 4). Renders a horizontal
// gradient bar with draggable stop markers: drag a marker to retime it,
// click empty bar to add a stop, right-click a marker to remove it, and edit
// the selected stop's color/alpha below the bar. Every edit is normalized
// (sorted, clamped) and pushed out via onChange. Bound to the selected
// layer's `colorRamp` (VFX-2): edits write via updateLayer, so they DO trigger
// a volume regeneration (color is baked into the RGBA8 volume at generation).
import type { ColorRamp, RampStop } from '../../core/colorRamp'
import { sampleStops, normalizeRampStops } from '../../core/colorRamp'
import { Slider } from './Slider'

const MIN_STOPS = 2
const MIN_GAP = 0.001 // keeps adjacent stops distinguishable while dragging

export class GradientEditor {
  readonly el: HTMLElement
  private readonly bar: HTMLElement
  private readonly pickerRow: HTMLElement
  private readonly onChangeCb: (ramp: ColorRamp) => void
  private ramp: ColorRamp
  private selected: number | null = null

  constructor(ramp: ColorRamp, onChange: (ramp: ColorRamp) => void) {
    this.onChangeCb = onChange
    this.ramp = { ...ramp, stops: normalizeRampStops(ramp.stops) }

    this.el = document.createElement('div')
    this.el.className = 'gradient-editor'

    this.bar = document.createElement('div')
    this.bar.className = 'gradient-bar'
    this.bar.addEventListener('mousedown', (e) => this.handleBarMouseDown(e))
    this.el.appendChild(this.bar)

    this.pickerRow = document.createElement('div')
    this.pickerRow.className = 'gradient-picker-row'
    this.el.appendChild(this.pickerRow)

    this.renderBar()
    this.renderPicker()
  }

  // External sync (preset dropdown, enabled toggle, layer switch, project
  // load, undo/...) -- updates this.ramp and redraws; never emits onChange.
  setRamp(ramp: ColorRamp) {
    this.ramp = { ...ramp, stops: normalizeRampStops(ramp.stops) }
    if (this.selected !== null && this.selected >= this.ramp.stops.length) this.selected = null
    this.renderBar()
    this.renderPicker()
  }

  private select(index: number | null) {
    this.selected = index
    this.renderBar()
    this.renderPicker()
  }

  // Applies a new stop list; `nextSelected` is only passed when the selected
  // index itself changes (add/remove) so the picker (color input + alpha
  // slider) is rebuilt. Left undefined during drag/recolor edits so the
  // picker's own live inputs -- e.g. a native <input type=color> with its
  // popup open -- are never torn down mid-interaction.
  private commitStops(stops: RampStop[], nextSelected?: number | null) {
    this.ramp = { ...this.ramp, stops: normalizeRampStops(stops) }
    if (nextSelected !== undefined) this.selected = nextSelected
    this.renderBar()
    if (nextSelected !== undefined) this.renderPicker()
    this.onChangeCb(this.ramp)
  }

  private handleBarMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    const rect = this.bar.getBoundingClientRect()
    const t = clamp01((e.clientX - rect.left) / Math.max(rect.width, 1))
    this.addStop(t)
  }

  private addStop(t: number) {
    const [r, g, b, a] = sampleStops(this.ramp.stops, t)
    const stop: RampStop = { t, color: [r, g, b], alpha: a }
    const stops = [...this.ramp.stops]
    const insertIndex = stops.filter((s) => s.t <= t).length
    stops.splice(insertIndex, 0, stop)
    this.commitStops(stops, insertIndex)
  }

  private removeStop(index: number) {
    if (this.ramp.stops.length <= MIN_STOPS) return
    const stops = this.ramp.stops.filter((_, i) => i !== index)
    this.commitStops(stops, null)
  }

  private startDragStop(index: number, e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation() // don't let the bar's own mousedown treat this as "add stop"
    this.select(index)
    const rect = this.bar.getBoundingClientRect()

    const onMove = (moveEv: MouseEvent) => {
      const raw = clamp01((moveEv.clientX - rect.left) / Math.max(rect.width, 1))
      const stops = this.ramp.stops
      const lo = index > 0 ? stops[index - 1].t + MIN_GAP : 0
      const hi = index < stops.length - 1 ? stops[index + 1].t - MIN_GAP : 1
      const t = Math.min(Math.max(raw, lo), Math.max(lo, hi))
      const next = stops.map((s, i) => (i === index ? { ...s, t } : s))
      this.commitStops(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  private updateSelectedColor(hex: string) {
    if (this.selected === null) return
    const rgb = hexToRgb(hex)
    const stops = this.ramp.stops.map((s, i) => (i === this.selected ? { ...s, color: rgb } : s))
    this.commitStops(stops)
  }

  private updateSelectedAlpha(alpha: number) {
    if (this.selected === null) return
    const stops = this.ramp.stops.map((s, i) => (i === this.selected ? { ...s, alpha } : s))
    this.commitStops(stops)
  }

  private renderBar() {
    this.bar.innerHTML = ''
    this.bar.style.background = buildGradientCss(this.ramp.stops)
    this.ramp.stops.forEach((stop, index) => {
      const marker = document.createElement('div')
      // "curve-handle" is reused here purely for its drag-marker styling; it
      // also lets PropertiesPanel's capture-phase mousedown guard engage the
      // volume drag-proxy on a stop drag, like every other regen control (a
      // per-layer ramp edit IS a REGEN_TRIGGERS field via updateLayer).
      marker.className = 'curve-handle gradient-stop' + (index === this.selected ? ' selected' : '')
      marker.style.left = `${(stop.t * 100).toFixed(3)}%`
      marker.style.setProperty(
        '--stop-color',
        `rgba(${stop.color[0]}, ${stop.color[1]}, ${stop.color[2]}, ${(stop.alpha / 255).toFixed(3)})`
      )
      marker.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        this.startDragStop(index, e)
      })
      marker.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.removeStop(index)
      })
      this.bar.appendChild(marker)
    })
  }

  private renderPicker() {
    this.pickerRow.innerHTML = ''
    if (this.selected === null) {
      const msg = document.createElement('span')
      msg.className = 'gradient-picker-empty'
      msg.textContent = 'Click a stop to edit · drag to move · right-click to remove'
      this.pickerRow.appendChild(msg)
      return
    }

    const stop = this.ramp.stops[this.selected]

    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    colorInput.className = 'gradient-color-input'
    colorInput.value = rgbToHex(stop.color)
    colorInput.addEventListener('input', () => this.updateSelectedColor(colorInput.value))
    this.pickerRow.appendChild(colorInput)

    const alpha = new Slider({
      label: 'Alpha',
      min: 0,
      max: 255,
      step: 1,
      value: stop.alpha,
      decimals: 0,
      onInput: (v) => this.updateSelectedAlpha(v),
      onChange: (v) => this.updateSelectedAlpha(v),
    })
    this.pickerRow.appendChild(alpha.el)
  }
}

function buildGradientCss(stops: RampStop[]): string {
  const colorStops = stops
    .map((s) => `rgba(${s.color[0]},${s.color[1]},${s.color[2]},${(s.alpha / 255).toFixed(3)}) ${(s.t * 100).toFixed(2)}%`)
    .join(', ')
  // Checkerboard behind the ramp so low/zero-alpha regions read as transparent.
  const checker = 'repeating-conic-gradient(var(--bg-control) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px'
  return `linear-gradient(90deg, ${colorStops}), ${checker}`
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
