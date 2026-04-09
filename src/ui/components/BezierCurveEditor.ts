import { uid } from '../../utils/uid'
import type { BezierCurve } from '../../types/index'

export interface BezierCurveEditorOptions {
  label: string
  value: BezierCurve
  defaultValue?: BezierCurve
  onInput?: (value: BezierCurve) => void
  onChange?: (value: BezierCurve) => void
}

const VIEWBOX_SIZE = 100
const HANDLE_RADIUS = 4

export class BezierCurveEditor {
  readonly el: HTMLElement
  private readonly opts: BezierCurveEditorOptions
  private readonly fieldId: string
  private _value: BezierCurve
  private svg!: SVGSVGElement
  private path!: SVGPathElement
  private guide1!: SVGLineElement
  private guide2!: SVGLineElement
  private handle1!: SVGCircleElement
  private handle2!: SVGCircleElement
  private valueEl!: HTMLElement

  constructor(opts: BezierCurveEditorOptions) {
    this.opts = opts
    this.fieldId = `curve-${uid()}`
    this._value = [...opts.value] as BezierCurve
    this.el = this.build()
    this.update()
    this.attachEvents()
  }

  private build(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'curve-editor'

    const header = document.createElement('div')
    header.className = 'curve-editor-header'

    const label = document.createElement('span')
    label.className = 'curve-editor-label'
    label.textContent = this.opts.label
    header.appendChild(label)

    this.valueEl = document.createElement('span')
    this.valueEl.className = 'curve-editor-value'
    header.appendChild(this.valueEl)

    wrap.appendChild(header)

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.svg.classList.add('curve-editor-canvas')
    this.svg.setAttribute('viewBox', `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`)
    this.svg.setAttribute('role', 'img')
    this.svg.setAttribute('aria-labelledby', this.fieldId)

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.id = this.fieldId
    title.textContent = `${this.opts.label} cubic bezier curve editor`
    this.svg.appendChild(title)

    for (let i = 1; i < 4; i++) {
      const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      grid.classList.add('curve-grid-line')
      const p = (VIEWBOX_SIZE / 4) * i
      grid.setAttribute('x1', '0')
      grid.setAttribute('y1', String(p))
      grid.setAttribute('x2', String(VIEWBOX_SIZE))
      grid.setAttribute('y2', String(p))
      this.svg.appendChild(grid)

      const gridV = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      gridV.classList.add('curve-grid-line')
      gridV.setAttribute('x1', String(p))
      gridV.setAttribute('y1', '0')
      gridV.setAttribute('x2', String(p))
      gridV.setAttribute('y2', String(VIEWBOX_SIZE))
      this.svg.appendChild(gridV)
    }

    const diagonal = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    diagonal.classList.add('curve-diagonal')
    diagonal.setAttribute('x1', '0')
    diagonal.setAttribute('y1', String(VIEWBOX_SIZE))
    diagonal.setAttribute('x2', String(VIEWBOX_SIZE))
    diagonal.setAttribute('y2', '0')
    this.svg.appendChild(diagonal)

    this.guide1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    this.guide1.classList.add('curve-guide-line')
    this.svg.appendChild(this.guide1)

    this.guide2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    this.guide2.classList.add('curve-guide-line')
    this.svg.appendChild(this.guide2)

    this.path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    this.path.classList.add('curve-path')
    this.svg.appendChild(this.path)

    this.handle1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    this.handle1.classList.add('curve-handle')
    this.handle1.dataset.index = '0'
    this.handle1.setAttribute('r', String(HANDLE_RADIUS))
    this.svg.appendChild(this.handle1)

    this.handle2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    this.handle2.classList.add('curve-handle')
    this.handle2.dataset.index = '1'
    this.handle2.setAttribute('r', String(HANDLE_RADIUS))
    this.svg.appendChild(this.handle2)

    wrap.appendChild(this.svg)

    const footer = document.createElement('div')
    footer.className = 'curve-editor-footer'
    footer.innerHTML = '<span>0</span><span>1</span>'
    wrap.appendChild(footer)

    return wrap
  }

  private attachEvents() {
    const startDrag = (index: 0 | 1, ev: MouseEvent) => {
      ev.preventDefault()
      const onMove = (moveEv: MouseEvent) => {
        const next = this.readEventPoint(moveEv, index)
        this.setValue(next, false)
      }
      const onUp = (upEv: MouseEvent) => {
        const next = this.readEventPoint(upEv, index)
        this.setValue(next, true)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    this.handle1.addEventListener('mousedown', (ev) => startDrag(0, ev))
    this.handle2.addEventListener('mousedown', (ev) => startDrag(1, ev))

    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.opts.defaultValue) return
      this.setValue(this.opts.defaultValue, true)
    })
  }

  private readEventPoint(ev: MouseEvent, index: 0 | 1): BezierCurve {
    const rect = this.svg.getBoundingClientRect()
    const x = clamp01((ev.clientX - rect.left) / Math.max(rect.width, 1))
    const y = clamp01(1 - (ev.clientY - rect.top) / Math.max(rect.height, 1))

    const next = [...this._value] as BezierCurve
    if (index === 0) {
      next[0] = Math.min(x, next[2])
      next[1] = y
    } else {
      next[2] = Math.max(x, next[0])
      next[3] = y
    }
    return next
  }

  private setValue(value: BezierCurve, emitChange: boolean) {
    this._value = normalizeCurve(value)
    this.update()
    this.opts.onInput?.([...this._value] as BezierCurve)
    if (emitChange) this.opts.onChange?.([...this._value] as BezierCurve)
  }

  private update() {
    const [x1, y1, x2, y2] = this._value
    const p1 = toSvgPoint(x1, y1)
    const p2 = toSvgPoint(x2, y2)

    this.guide1.setAttribute('x1', '0')
    this.guide1.setAttribute('y1', String(VIEWBOX_SIZE))
    this.guide1.setAttribute('x2', String(p1.x))
    this.guide1.setAttribute('y2', String(p1.y))

    this.guide2.setAttribute('x1', String(VIEWBOX_SIZE))
    this.guide2.setAttribute('y1', '0')
    this.guide2.setAttribute('x2', String(p2.x))
    this.guide2.setAttribute('y2', String(p2.y))

    this.path.setAttribute('d', `M 0 ${VIEWBOX_SIZE} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${VIEWBOX_SIZE} 0`)
    this.handle1.setAttribute('cx', String(p1.x))
    this.handle1.setAttribute('cy', String(p1.y))
    this.handle2.setAttribute('cx', String(p2.x))
    this.handle2.setAttribute('cy', String(p2.y))

    this.valueEl.textContent = `${x1.toFixed(2)}, ${y1.toFixed(2)} · ${x2.toFixed(2)}, ${y2.toFixed(2)}`
  }
}

function toSvgPoint(x: number, y: number) {
  return {
    x: x * VIEWBOX_SIZE,
    y: (1 - y) * VIEWBOX_SIZE,
  }
}

function normalizeCurve(value: BezierCurve): BezierCurve {
  const x1 = clamp01(value[0])
  const y1 = clamp01(value[1])
  const x2 = Math.max(x1, clamp01(value[2]))
  const y2 = clamp01(value[3])
  return [x1, y1, x2, y2]
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

