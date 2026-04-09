import { uid } from '../../utils/uid'

// High-quality slider: drag, shift-drag (fine), double-click text edit, scroll, right-click reset

export interface SliderOptions {
  min: number
  max: number
  step: number
  value: number
  label: string
  decimals?: number
  defaultValue?: number
  onChange?: (value: number) => void
  onInput?: (value: number) => void
}

export class Slider {
  readonly el: HTMLElement
  private track!: HTMLElement
  private fill!: HTMLElement
  private thumb!: HTMLElement
  private labelEl!: HTMLElement
  private valueEl!: HTMLElement
  private opts: SliderOptions
  private _value: number
  private readonly fieldId: string
  private dragStartX = 0
  private dragStartValue = 0

  constructor(opts: SliderOptions) {
    this.opts = opts
    this._value = opts.value
    this.fieldId = `slider-${uid()}`

    this.el = this.build()
    this.update()
    this.attachEvents()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'slider-row'

    this.labelEl = document.createElement('span')
    this.labelEl.className = 'slider-label'
    this.labelEl.textContent = this.opts.label

    this.track = document.createElement('div')
    this.track.className = 'slider-track'

    this.fill = document.createElement('div')
    this.fill.className = 'slider-fill'

    this.thumb = document.createElement('div')
    this.thumb.className = 'slider-thumb'

    this.track.appendChild(this.fill)
    this.track.appendChild(this.thumb)

    this.valueEl = document.createElement('span')
    this.valueEl.className = 'slider-value'
    this.valueEl.textContent = this.formatVal(this._value)

    el.appendChild(this.labelEl)
    el.appendChild(this.track)
    el.appendChild(this.valueEl)
    return el
  }

  private formatVal(v: number): string {
    const dec = this.opts.decimals ?? 2
    return v.toFixed(dec)
  }

  private pct(): number {
    const { min, max } = this.opts
    return Math.max(0, Math.min(1, (this._value - min) / (max - min)))
  }

  private update() {
    const p = this.pct() * 100
    this.fill.style.width = `${p}%`
    this.thumb.style.left = `${p}%`
    this.valueEl.textContent = this.formatVal(this._value)
  }

  private attachEvents() {
    // Track click
    this.track.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.startDrag(e)
    })

    // Double click on value = text edit
    this.valueEl.addEventListener('dblclick', () => this.startEdit())

    // Scroll wheel
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -this.opts.step : this.opts.step
      this.setValue(this._value + delta, true)
    }, { passive: false })

    // Right click = reset
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.opts.defaultValue !== undefined) {
        this.setValue(this.opts.defaultValue, true)
      }
    })
  }

  private startDrag(e: MouseEvent) {
    this.dragStartX = e.clientX
    this.dragStartValue = this._value

    const trackRect = this.track.getBoundingClientRect()
    // Click position maps to value directly
    const clickPct = (e.clientX - trackRect.left) / trackRect.width
    const clickVal = this.opts.min + clickPct * (this.opts.max - this.opts.min)
    this.setValue(clickVal, false)

    const onMove = (ev: MouseEvent) => {
      const fine = ev.shiftKey
      const dx = ev.clientX - this.dragStartX
      const range = this.opts.max - this.opts.min
      const pixelRange = trackRect.width
      let delta = (dx / pixelRange) * range
      if (fine) delta *= 0.05
      this.setValue(this.dragStartValue + delta, false)
    }

    const onUp = () => {
      this.opts.onChange?.(this._value)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  private startEdit() {
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'slider-edit-input'
    input.id = `${this.fieldId}-edit`
    input.name = `${this.fieldId}-edit`
    input.value = this.formatVal(this._value)
    input.min = String(this.opts.min)
    input.max = String(this.opts.max)
    input.step = String(this.opts.step)
    input.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.opts.defaultValue !== undefined) {
        input.value = this.formatVal(this.opts.defaultValue)
        this.setValue(this.opts.defaultValue, true)
      }
    })

    this.valueEl.replaceWith(input)
    input.select()

    const commit = () => {
      const v = parseFloat(input.value)
      if (!isNaN(v)) this.setValue(v, true)
      input.replaceWith(this.valueEl)
      this.update()
    }

    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') { input.replaceWith(this.valueEl); this.update() }
    })
  }

  setValue(v: number, emitChange: boolean) {
    const { min, max, step } = this.opts
    v = Math.round(v / step) * step
    v = Math.max(min, Math.min(max, v))
    this._value = v
    this.update()
    this.opts.onInput?.(v)
    if (emitChange) this.opts.onChange?.(v)
  }

  get value(): number { return this._value }

  setValueSilent(v: number) {
    this._value = Math.max(this.opts.min, Math.min(this.opts.max, v))
    this.update()
  }
}
