import type { StateManager } from '../../state/StateManager'
import type { Viewport } from '../viewport/Viewport'
import type { Layer } from '../../types/index'
import { NoiseType, WorleyMode, DistortionType, FeatherShape, isSdfSource, DEFAULT_SDF } from '../../types/index'
import { defaultLayer } from '../../state/AppState'
import { Slider } from '../components/Slider'
import { Select } from '../components/Select'
import { Toggle } from '../components/Toggle'
import { BezierCurveEditor } from '../components/BezierCurveEditor'
import { GradientEditor } from '../components/GradientEditor'
import { NOISE_LABELS, NOISE_COLORS } from '../../utils/colorMap'
import { RAMP_PRESETS, type RampStop } from '../../core/colorRamp'

// Single source of truth for slider/curve right-click reset defaults.
const D = defaultLayer()

function section(
  title: string,
  content: HTMLElement,
  isOpen: boolean,
  onToggle: (open: boolean) => void
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'prop-section'

  const header = document.createElement('div')
  header.className = 'prop-section-header'
  const arrow = document.createElement('span')
  arrow.className = 'prop-arrow'
  arrow.textContent = isOpen ? '▾' : '▸'
  header.appendChild(arrow)
  header.appendChild(document.createTextNode(title))

  const body = document.createElement('div')
  body.className = 'prop-section-body'
  if (!isOpen) body.classList.add('collapsed')
  body.appendChild(content)

  header.addEventListener('click', () => {
    const open = body.classList.contains('collapsed')
    body.classList.toggle('collapsed', !open)
    arrow.textContent = open ? '▾' : '▸'
    onToggle(open)
  })

  wrap.appendChild(header)
  wrap.appendChild(body)
  return wrap
}

export class PropertiesPanel {
  readonly el: HTMLElement
  private state: StateManager
  private contentEl: HTMLElement
  private sectionState = new Map<string, boolean>()
  private currentLayerSignature: string | null = null
  private viewport: Viewport
  private readonly colorSectionEl: HTMLElement

  private getLayerById(id: string): Layer | null {
    return this.state.get('layers').find(layer => layer.id === id) ?? null
  }

  private updateNoise(id: string, buildPatch: (layer: Layer) => Partial<Layer['noise']>) {
    const layer = this.getLayerById(id)
    if (!layer) return
    this.state.updateLayerNoise(id, buildPatch(layer))
  }

  private updateDistortion(id: string, buildPatch: (layer: Layer) => Partial<Layer['distortion']>) {
    const layer = this.getLayerById(id)
    if (!layer) return
    this.state.updateLayerDistortion(id, buildPatch(layer))
  }

  private updateRemap(id: string, buildPatch: (layer: Layer) => Partial<Layer['remap']>) {
    const layer = this.getLayerById(id)
    if (!layer) return
    this.state.updateLayerRemap(id, buildPatch(layer))
  }

  constructor(state: StateManager, viewport: Viewport) {
    this.state = state
    this.viewport = viewport
    this.el = document.createElement('div')
    this.el.className = 'properties-panel'

    const header = document.createElement('div')
    header.className = 'panel-header'
    header.innerHTML = `<span class="panel-title">Properties</span>`
    this.el.appendChild(header)

    this.contentEl = document.createElement('div')
    this.contentEl.className = 'properties-content'
    this.el.appendChild(this.contentEl)

    // Drag-proxy interaction signal (Task 4): a single delegated listener
    // covers every Slider/BezierCurveEditor in this panel instead of
    // touching each call site individually, but it must only fire for an
    // actual drag start on those two controls' own drag targets -- the
    // slider track (Slider.ts's `track`, class "slider-track") and a bezier
    // handle (BezierCurveEditor.ts's `handle1`/`handle2`, class
    // "curve-handle"). A mousedown anywhere else in the panel -- opening a
    // native <select>, a Toggle, a section header, a right-click reset --
    // must NOT set interacting, otherwise closing a <select> popup (which
    // doesn't reliably deliver a matching window mouseup) leaves interacting
    // stuck true and every later edit renders proxy-only forever.
    // Capture phase so this still fires even though BezierCurveEditor's
    // handle mousedown calls stopPropagation() (capture runs on the way
    // down, before that stopPropagation takes effect during target/bubble).
    this.contentEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return  // left-drag only; right-click is the slider reset gesture
      const target = e.target as Element | null
      if (!target?.closest('.slider-track, .curve-handle')) return
      // GradientEditor (VFX-0 Task 4) reuses "curve-handle"/"slider-track" for
      // its stop markers and alpha slider, but it only ever touches
      // `preview.colorRamp` -- never a REGEN_TRIGGERS field -- so it must not
      // engage the volume drag-proxy. Exclude its subtree here rather than
      // renaming its classes, so it keeps the same marker/slider styling.
      if (target.closest('.gradient-editor')) return
      this.viewport.setInteracting(true)
    }, { capture: true })
    // mouseup is listened on window (not contentEl) because Slider and
    // BezierCurveEditor both track drags via a window-level mouseup, so a
    // release can land anywhere on the page, not just back over the panel.
    window.addEventListener('mouseup', () => this.viewport.setInteracting(false))
    // Safety net: if focus/the window is lost mid-drag (alt-tab, devtools
    // stealing focus, ...) the mouseup above may never arrive. Clearing on
    // blur too keeps the invariant that interacting can't stay stuck true
    // once the pointer or focus is gone, without rewriting Slider/
    // BezierCurveEditor's mouse-event drag tracking to pointer capture.
    window.addEventListener('blur', () => this.viewport.setInteracting(false))

    // Color (VFX-0 Task 4): built once and re-appended (not rebuilt) on every
    // render() -- it's a `preview.colorRamp` control, not per-layer, and its
    // GradientEditor holds live drag state that a teardown/rebuild would lose.
    this.colorSectionEl = this.buildColorSection()

    this.state.subscribe('selected', () => this.render())
    this.state.subscribe('layers', () => this.handleLayersChange())
    this.render()
  }

  private render() {
    const id = this.state.get('selected')
    const layers = this.state.get('layers')
    const layer = id ? layers.find(l => l.id === id) ?? null : null
    this.currentLayerSignature = getLayerEditorSignature(layer)

    this.contentEl.innerHTML = ''

    if (!layer) {
      const msg = document.createElement('div')
      msg.className = 'prop-empty'
      msg.textContent = 'Select a layer to edit properties'
      this.contentEl.appendChild(msg)
      this.contentEl.appendChild(this.colorSectionEl)
      return
    }

    this.contentEl.appendChild(this.buildNoiseSection(layer))
    if (layer.noise.type === NoiseType.FBM) {
      this.contentEl.appendChild(this.buildFBMSection(layer))
    }
    this.contentEl.appendChild(this.buildTransformSection(layer))
    this.contentEl.appendChild(this.buildDistortionSection(layer))
    this.contentEl.appendChild(this.buildRemapSection(layer))
    this.contentEl.appendChild(this.colorSectionEl)
  }

  private handleLayersChange() {
    const id = this.state.get('selected')
    const layer = id ? this.state.get('layers').find(l => l.id === id) ?? null : null
    const nextSignature = getLayerEditorSignature(layer)

    if (nextSignature !== this.currentLayerSignature) {
      this.render()
    }
  }

  private getSectionOpen(layerId: string, sectionName: string, defaultOpen: boolean): boolean {
    const key = `${layerId}:${sectionName}`
    if (!this.sectionState.has(key)) {
      this.sectionState.set(key, defaultOpen)
    }
    return this.sectionState.get(key)!
  }

  private setSectionOpen(layerId: string, sectionName: string, open: boolean) {
    this.sectionState.set(`${layerId}:${sectionName}`, open)
  }

  private buildNoiseSection(layer: Layer): HTMLElement {
    const id = layer.id
    const body = document.createElement('div')
    body.className = 'prop-body'

    // Noise type selector
    const typeOptions = Object.values(NoiseType).map(t => ({
      value: t, label: NOISE_LABELS[t], color: NOISE_COLORS[t]
    }))
    const typeRow = document.createElement('div')
    typeRow.className = 'prop-row'
    const typeLabel = document.createElement('span')
    typeLabel.className = 'prop-label'
    typeLabel.textContent = 'Type'

    const typeSel = new Select(typeOptions, layer.noise.type, (v) => {
      this.updateNoise(id, () => ({ type: v as NoiseType }))
    })
    typeRow.appendChild(typeLabel)
    typeRow.appendChild(typeSel.el)
    body.appendChild(typeRow)

    // Worley mode (only for Worley)
    if (layer.noise.type === NoiseType.Worley) {
      const wRow = document.createElement('div')
      wRow.className = 'prop-row'
      const wLabel = document.createElement('span')
      wLabel.className = 'prop-label'
      wLabel.textContent = 'Mode'
      const wSel = new Select([
        { value: WorleyMode.F1, label: 'F1 (closest)' },
        { value: WorleyMode.F2, label: 'F2 (second)' },
        { value: WorleyMode.F2F1, label: 'F2-F1 (edge)' },
      ], layer.noise.worleyMode, (v) => {
        this.updateNoise(id, () => ({ worleyMode: v as WorleyMode }))
      })
      wRow.appendChild(wLabel)
      wRow.appendChild(wSel.el)
      body.appendChild(wRow)
    }

    // Radius/softness (only for SDF sources)
    if (isSdfSource(layer.noise.type)) {
      const sdf = layer.noise.sdf ?? DEFAULT_SDF
      body.appendChild(new Slider({
        label: 'Radius', min: 0.05, max: 1, step: 0.01, value: sdf.radius,
        defaultValue: DEFAULT_SDF.radius, decimals: 2,
        onInput: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), radius: v } })),
        onChange: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), radius: v } })),
      }).el)
      body.appendChild(new Slider({
        label: 'Softness', min: 0.001, max: 1, step: 0.001, value: sdf.softness,
        defaultValue: DEFAULT_SDF.softness, decimals: 3,
        onInput: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), softness: v } })),
        onChange: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), softness: v } })),
      }).el)
      // Shown for all SDF shapes, not just the elongated three -- harmless
      // no-op for sphere/box/cone since their GLSL never reads u_sdfHeight,
      // and this keeps the block a single shared list instead of branching
      // on which SDF shape is selected.
      body.appendChild(new Slider({
        label: 'Height', min: 0.1, max: 2, step: 0.01, value: sdf.height,
        defaultValue: DEFAULT_SDF.height, decimals: 2,
        onInput: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), height: v } })),
        onChange: (v) => this.updateNoise(id, (current) => ({ sdf: { ...(current.noise.sdf ?? DEFAULT_SDF), height: v } })),
      }).el)
    }

    // Scale XYZ
    body.appendChild(new Slider({
      label: 'Scale X', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[0],
      defaultValue: D.noise.scale[0], decimals: 2,
      onInput: (v) => this.updateNoise(id, (current) => ({ scale: [v, current.noise.scale[1], current.noise.scale[2]] })),
      onChange: (v) => this.updateNoise(id, (current) => ({ scale: [v, current.noise.scale[1], current.noise.scale[2]] })),
    }).el)
    body.appendChild(new Slider({
      label: 'Scale Y', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[1],
      defaultValue: D.noise.scale[1], decimals: 2,
      onInput: (v) => this.updateNoise(id, (current) => ({ scale: [current.noise.scale[0], v, current.noise.scale[2]] })),
      onChange: (v) => this.updateNoise(id, (current) => ({ scale: [current.noise.scale[0], v, current.noise.scale[2]] })),
    }).el)
    body.appendChild(new Slider({
      label: 'Scale Z', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[2],
      defaultValue: D.noise.scale[2], decimals: 2,
      onInput: (v) => this.updateNoise(id, (current) => ({ scale: [current.noise.scale[0], current.noise.scale[1], v] })),
      onChange: (v) => this.updateNoise(id, (current) => ({ scale: [current.noise.scale[0], current.noise.scale[1], v] })),
    }).el)

    body.appendChild(new Slider({
      label: 'Amplitude', min: 0, max: 2, step: 0.01, value: layer.noise.amplitude,
      defaultValue: D.noise.amplitude, decimals: 2,
      onInput: (v) => this.updateNoise(id, () => ({ amplitude: v })),
      onChange: (v) => this.updateNoise(id, () => ({ amplitude: v })),
    }).el)

    body.appendChild(new Slider({
      label: 'Seed', min: 0, max: 100, step: 1, value: layer.noise.seed,
      defaultValue: 0, decimals: 0,
      onInput: (v) => this.updateNoise(id, () => ({ seed: v })),
      onChange: (v) => this.updateNoise(id, () => ({ seed: v })),
    }).el)

    body.appendChild(new Slider({
      label: 'Temperature', min: 0, max: 1, step: 0.01, value: layer.noise.temperature ?? 0,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateNoise(id, () => ({ temperature: v })),
      onChange: (v) => this.updateNoise(id, () => ({ temperature: v })),
    }).el)

    return section(
      'Noise',
      body,
      this.getSectionOpen(id, 'Noise', true),
      (open) => this.setSectionOpen(id, 'Noise', open)
    )
  }

  private buildFBMSection(layer: Layer): HTMLElement {
    const id = layer.id
    const fbm = layer.noise.fbm
    const body = document.createElement('div')
    body.className = 'prop-body'

    if (layer.noise.type === NoiseType.FBM) {
      const baseOptions = Object.values(NoiseType)
        // FBM base must be a procedural noise field, not FBM itself and not
        // an SDF shape (a shape isn't a fractal base and has no controls here).
        .filter(t => t !== NoiseType.FBM && !isSdfSource(t))
        .map(t => ({ value: t, label: NOISE_LABELS[t] }))
      const baseRow = document.createElement('div')
      baseRow.className = 'prop-row'
      const baseLabel = document.createElement('span')
      baseLabel.className = 'prop-label'
      baseLabel.textContent = 'Base Noise'
      const baseSel = new Select(baseOptions, fbm.baseNoise, (v) => {
        this.updateNoise(id, (current) => ({
          fbm: { ...current.noise.fbm, baseNoise: v as NoiseType },
        }))
      })
      baseRow.appendChild(baseLabel)
      baseRow.appendChild(baseSel.el)
      body.appendChild(baseRow)
    }

    body.appendChild(new Slider({
      label: 'Octaves', min: 1, max: 8, step: 1, value: fbm.octaves,
      defaultValue: D.noise.fbm.octaves, decimals: 0,
      onInput: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, octaves: v },
      })),
      onChange: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, octaves: v },
      })),
    }).el)
    body.appendChild(new Slider({
      label: 'Persistence', min: 0.1, max: 1.0, step: 0.01, value: fbm.persistence,
      defaultValue: D.noise.fbm.persistence, decimals: 2,
      onInput: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, persistence: v },
      })),
      onChange: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, persistence: v },
      })),
    }).el)
    body.appendChild(new Slider({
      label: 'Lacunarity', min: 1.0, max: 4.0, step: 0.05, value: fbm.lacunarity,
      defaultValue: D.noise.fbm.lacunarity, decimals: 2,
      onInput: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, lacunarity: v },
      })),
      onChange: (v) => this.updateNoise(id, (current) => ({
        fbm: { ...current.noise.fbm, lacunarity: v },
      })),
    }).el)

    return section(
      'FBM',
      body,
      this.getSectionOpen(id, 'FBM', true),
      (open) => this.setSectionOpen(id, 'FBM', open)
    )
  }

  private buildTransformSection(layer: Layer): HTMLElement {
    const id = layer.id
    const body = document.createElement('div')
    body.className = 'prop-body'

    const axes = ['X', 'Y', 'Z'] as const
    axes.forEach((ax, i) => {
      body.appendChild(new Slider({
        label: `Rot ${ax}`, min: -180, max: 180, step: 1, value: layer.noise.rotation[i],
        defaultValue: 0, decimals: 0,
        onInput: (v) => {
          const current = this.getLayerById(id)
          if (!current) return
          const r: [number,number,number] = [...current.noise.rotation] as [number,number,number]
          r[i] = v
          this.state.updateLayerNoise(id, { rotation: r })
        },
        onChange: (v) => {
          const current = this.getLayerById(id)
          if (!current) return
          const r: [number,number,number] = [...current.noise.rotation] as [number,number,number]
          r[i] = v
          this.state.updateLayerNoise(id, { rotation: r })
        },
      }).el)
    })

    axes.forEach((ax, i) => {
      body.appendChild(new Slider({
        label: `Offset ${ax}`, min: -10, max: 10, step: 0.1, value: layer.noise.offset[i],
        defaultValue: 0, decimals: 2,
        onInput: (v) => {
          const current = this.getLayerById(id)
          if (!current) return
          const o: [number,number,number] = [...current.noise.offset] as [number,number,number]
          o[i] = v
          this.state.updateLayerNoise(id, { offset: o })
        },
        onChange: (v) => {
          const current = this.getLayerById(id)
          if (!current) return
          const o: [number,number,number] = [...current.noise.offset] as [number,number,number]
          o[i] = v
          this.state.updateLayerNoise(id, { offset: o })
        },
      }).el)
    })

    return section(
      'Transform',
      body,
      this.getSectionOpen(id, 'Transform', false),
      (open) => this.setSectionOpen(id, 'Transform', open)
    )
  }

  private buildDistortionSection(layer: Layer): HTMLElement {
    const id = layer.id
    const dist = layer.distortion
    const body = document.createElement('div')
    body.className = 'prop-body'

    const typeRow = document.createElement('div')
    typeRow.className = 'prop-row'
    const typeLabel = document.createElement('span')
    typeLabel.className = 'prop-label'
    typeLabel.textContent = 'Type'
    const typeSel = new Select([
      { value: DistortionType.None, label: 'None' },
      { value: DistortionType.DomainWarp, label: 'Domain Warp' },
      { value: DistortionType.Curl, label: 'Curl' },
      { value: DistortionType.Swirl, label: 'Swirl' },
      { value: DistortionType.Polar, label: 'Polar' },
    ], dist.type, (v) => {
      this.updateDistortion(id, () => ({ type: v as DistortionType }))
    })
    typeRow.appendChild(typeLabel)
    typeRow.appendChild(typeSel.el)
    body.appendChild(typeRow)

    if (dist.type !== DistortionType.None) {
      body.appendChild(new Slider({
        label: 'Strength', min: 0, max: 2, step: 0.01, value: dist.strength,
        defaultValue: D.distortion.strength, decimals: 2,
        onInput: (v) => this.updateDistortion(id, () => ({ strength: v })),
        onChange: (v) => this.updateDistortion(id, () => ({ strength: v })),
      }).el)

      if (dist.type === DistortionType.DomainWarp) {
        body.appendChild(new Slider({
          label: 'Warp Freq', min: 0.5, max: 10, step: 0.1, value: dist.warpFrequency,
          defaultValue: D.distortion.warpFrequency, decimals: 2,
          onInput: (v) => this.updateDistortion(id, () => ({ warpFrequency: v })),
          onChange: (v) => this.updateDistortion(id, () => ({ warpFrequency: v })),
        }).el)
      }

      if (dist.type === DistortionType.Swirl) {
        body.appendChild(new Slider({
          label: 'Swirl Amt', min: -5, max: 5, step: 0.1, value: dist.swirlAmount,
          defaultValue: D.distortion.swirlAmount, decimals: 2,
          onInput: (v) => this.updateDistortion(id, () => ({ swirlAmount: v })),
          onChange: (v) => this.updateDistortion(id, () => ({ swirlAmount: v })),
        }).el)
      }
    }

    return section(
      'Distortion',
      body,
      this.getSectionOpen(id, 'Distortion', false),
      (open) => this.setSectionOpen(id, 'Distortion', open)
    )
  }

  private buildRemapSection(layer: Layer): HTMLElement {
    const id = layer.id
    const remap = layer.remap
    const body = document.createElement('div')
    body.className = 'prop-body'

    body.appendChild(new Slider({
      label: 'In Min', min: 0, max: 1, step: 0.01, value: remap.inputMin,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ inputMin: v })),
      onChange: (v) => this.updateRemap(id, () => ({ inputMin: v })),
    }).el)
    body.appendChild(new Slider({
      label: 'In Max', min: 0, max: 1, step: 0.01, value: remap.inputMax,
      defaultValue: 1, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ inputMax: v })),
      onChange: (v) => this.updateRemap(id, () => ({ inputMax: v })),
    }).el)
    body.appendChild(new Slider({
      label: 'Out Min', min: 0, max: 1, step: 0.01, value: remap.outputMin,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ outputMin: v })),
      onChange: (v) => this.updateRemap(id, () => ({ outputMin: v })),
    }).el)
    body.appendChild(new Slider({
      label: 'Out Max', min: 0, max: 1, step: 0.01, value: remap.outputMax,
      defaultValue: 1, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ outputMax: v })),
      onChange: (v) => this.updateRemap(id, () => ({ outputMax: v })),
    }).el)

    body.appendChild(new BezierCurveEditor({
      label: 'Remap Curve',
      value: remap.remapCurve,
      defaultValue: D.remap.remapCurve,
      onInput: (v) => this.updateRemap(id, () => ({ remapCurve: v })),
      onChange: (v) => this.updateRemap(id, () => ({ remapCurve: v })),
    }).el)

    const featherShapeRow = document.createElement('div')
    featherShapeRow.className = 'prop-row'
    const featherShapeLabel = document.createElement('span')
    featherShapeLabel.className = 'prop-label'
    featherShapeLabel.textContent = 'Feather Shape'
    const featherShapeSel = new Select([
      { value: FeatherShape.Box, label: 'Box' },
      { value: FeatherShape.Sphere, label: 'Sphere' },
    ], remap.featherShape, (v) => {
      this.updateRemap(id, () => ({ featherShape: v as FeatherShape }))
    })
    featherShapeRow.appendChild(featherShapeLabel)
    featherShapeRow.appendChild(featherShapeSel.el)
    body.appendChild(featherShapeRow)

    body.appendChild(new Slider({
      label: 'Feather X', min: 0, max: 0.5, step: 0.01, value: remap.featherX,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ featherX: v })),
      onChange: (v) => this.updateRemap(id, () => ({ featherX: v })),
    }).el)
    body.appendChild(new Slider({
      label: 'Feather Y', min: 0, max: 0.5, step: 0.01, value: remap.featherY,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ featherY: v })),
      onChange: (v) => this.updateRemap(id, () => ({ featherY: v })),
    }).el)
    body.appendChild(new Slider({
      label: 'Feather Z', min: 0, max: 0.5, step: 0.01, value: remap.featherZ,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.updateRemap(id, () => ({ featherZ: v })),
      onChange: (v) => this.updateRemap(id, () => ({ featherZ: v })),
    }).el)
    body.appendChild(new BezierCurveEditor({
      label: 'Feather Curve',
      value: remap.featherCurve,
      defaultValue: D.remap.featherCurve,
      onInput: (v) => this.updateRemap(id, () => ({ featherCurve: v })),
      onChange: (v) => this.updateRemap(id, () => ({ featherCurve: v })),
    }).el)

    const invertToggle = new Toggle('Invert', layer.invert, (v) => {
      this.state.updateLayer(id, { invert: v })
    })
    body.appendChild(invertToggle.el)

    return section(
      'Remap',
      body,
      this.getSectionOpen(id, 'Remap', false),
      (open) => this.setSectionOpen(id, 'Remap', open)
    )
  }

  // Color ramp (VFX-0 Task 4): enable toggle + preset dropdown + the full
  // GradientEditor. Layer-independent (writes `preview.colorRamp`, which is
  // not a regen trigger -- see StateManager.REGEN_TRIGGERS), so this is built
  // once in the constructor and shown regardless of layer selection. This
  // replaces the Task-3 placeholder toggle+select that lived in
  // ViewportOverlay -- that duplicate control was removed so there's a single
  // place to edit the ramp instead of two competing ones.
  private buildColorSection(): HTMLElement {
    const body = document.createElement('div')
    body.className = 'prop-body'
    const preview = this.state.get('preview')

    const enableToggle = new Toggle('Enabled', preview.colorRamp.enabled, (v) => {
      const p = this.state.get('preview')
      this.state.update('preview', { ...p, colorRamp: { ...p.colorRamp, enabled: v } })
    })
    body.appendChild(enableToggle.el)

    const presetRow = document.createElement('div')
    presetRow.className = 'prop-row'
    const presetLabel = document.createElement('span')
    presetLabel.className = 'prop-label'
    presetLabel.textContent = 'Preset'
    const presetOptions = [
      ...Object.keys(RAMP_PRESETS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
      { value: 'custom', label: 'Custom' },
    ]
    const presetSelect = new Select(presetOptions, matchPreset(preview.colorRamp.stops), (v) => {
      if (v === 'custom') return // "Custom" isn't a loadable preset -- it only ever appears as a readout
      const p = this.state.get('preview')
      const stops = RAMP_PRESETS[v as keyof typeof RAMP_PRESETS]
      this.state.update('preview', { ...p, colorRamp: { ...p.colorRamp, stops } })
    })
    presetRow.appendChild(presetLabel)
    presetRow.appendChild(presetSelect.el)
    body.appendChild(presetRow)

    // Guards against the editor's own onChange (fired live on every drag
    // tick) echoing back into editor.setRamp() and tearing down its picker
    // mid-edit (e.g. closing an open native color-picker popup). External
    // changes -- preset load, project load, undo -- still sync normally.
    let selfUpdate = false
    const editor = new GradientEditor(preview.colorRamp, (ramp) => {
      const p = this.state.get('preview')
      selfUpdate = true
      this.state.update('preview', { ...p, colorRamp: { ...p.colorRamp, stops: ramp.stops } })
      selfUpdate = false
    })
    body.appendChild(editor.el)

    this.state.subscribe('preview', (p) => {
      enableToggle.setValue(p.colorRamp.enabled)
      presetSelect.setValue(matchPreset(p.colorRamp.stops))
      if (!selfUpdate) editor.setRamp(p.colorRamp)
    })

    return section(
      'Color',
      body,
      this.getSectionOpen('global', 'Color', true),
      (open) => this.setSectionOpen('global', 'Color', open)
    )
  }

}

// Resolves the preset <select>'s displayed value from actual state (VFX-0
// Task 4 fix for the Task-3 minor: a stale-looking dropdown after a preset
// load or undo). Falls back to "custom" whenever the stops don't exactly
// match a known preset -- e.g. after any manual edit in the GradientEditor.
function matchPreset(stops: RampStop[]): string {
  for (const [key, preset] of Object.entries(RAMP_PRESETS)) {
    if (stopsEqual(stops, preset)) return key
  }
  return 'custom'
}

function stopsEqual(a: RampStop[], b: RampStop[]): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) =>
    s.t === b[i].t && s.alpha === b[i].alpha &&
    s.color[0] === b[i].color[0] && s.color[1] === b[i].color[1] && s.color[2] === b[i].color[2]
  )
}

function getLayerEditorSignature(layer: Layer | null): string | null {
  if (!layer) return null
  return [
    layer.id,
    layer.noise.type,
    layer.noise.worleyMode,
    layer.noise.fbm.baseNoise,
    layer.distortion.type,
    layer.remap.featherShape,
    String(layer.invert),
  ].join('|')
}

