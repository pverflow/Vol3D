import type { StateManager } from '../../state/StateManager'
import type { Layer } from '../../types/index'
import { NoiseType, WorleyMode, DistortionType, FeatherShape } from '../../types/index'
import { Slider } from '../components/Slider'
import { Select } from '../components/Select'
import { Toggle } from '../components/Toggle'
import { BezierCurveEditor } from '../components/BezierCurveEditor'
import { NOISE_LABELS, NOISE_COLORS } from '../../utils/colorMap'

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

  constructor(state: StateManager) {
    this.state = state
    this.el = document.createElement('div')
    this.el.className = 'properties-panel'

    const header = document.createElement('div')
    header.className = 'panel-header'
    header.innerHTML = `<span class="panel-title">Properties</span>`
    this.el.appendChild(header)

    this.contentEl = document.createElement('div')
    this.contentEl.className = 'properties-content'
    this.el.appendChild(this.contentEl)

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
      return
    }

    this.contentEl.appendChild(this.buildNoiseSection(layer))
    if (layer.noise.type === NoiseType.FBM) {
      this.contentEl.appendChild(this.buildFBMSection(layer))
    }
    this.contentEl.appendChild(this.buildTransformSection(layer))
    this.contentEl.appendChild(this.buildDistortionSection(layer))
    this.contentEl.appendChild(this.buildRemapSection(layer))
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
      this.state.updateLayerNoise(id, { type: v as NoiseType })
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
        this.state.updateLayerNoise(id, { worleyMode: v as WorleyMode })
      })
      wRow.appendChild(wLabel)
      wRow.appendChild(wSel.el)
      body.appendChild(wRow)
    }

    // Scale XYZ
    body.appendChild(new Slider({
      label: 'Scale X', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[0],
      defaultValue: 3.0, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { scale: [v, layer.noise.scale[1], layer.noise.scale[2]] }),
      onChange: (v) => this.state.updateLayerNoise(id, { scale: [v, layer.noise.scale[1], layer.noise.scale[2]] }),
    }).el)
    body.appendChild(new Slider({
      label: 'Scale Y', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[1],
      defaultValue: 3.0, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { scale: [layer.noise.scale[0], v, layer.noise.scale[2]] }),
      onChange: (v) => this.state.updateLayerNoise(id, { scale: [layer.noise.scale[0], v, layer.noise.scale[2]] }),
    }).el)
    body.appendChild(new Slider({
      label: 'Scale Z', min: 0.1, max: 20, step: 0.1, value: layer.noise.scale[2],
      defaultValue: 3.0, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { scale: [layer.noise.scale[0], layer.noise.scale[1], v] }),
      onChange: (v) => this.state.updateLayerNoise(id, { scale: [layer.noise.scale[0], layer.noise.scale[1], v] }),
    }).el)

    body.appendChild(new Slider({
      label: 'Amplitude', min: 0, max: 2, step: 0.01, value: layer.noise.amplitude,
      defaultValue: 1.0, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { amplitude: v }),
      onChange: (v) => this.state.updateLayerNoise(id, { amplitude: v }),
    }).el)

    body.appendChild(new Slider({
      label: 'Seed', min: 0, max: 100, step: 1, value: layer.noise.seed,
      defaultValue: 0, decimals: 0,
      onInput: (v) => this.state.updateLayerNoise(id, { seed: v }),
      onChange: (v) => this.state.updateLayerNoise(id, { seed: v }),
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
        .filter(t => t !== NoiseType.FBM)
        .map(t => ({ value: t, label: NOISE_LABELS[t] }))
      const baseRow = document.createElement('div')
      baseRow.className = 'prop-row'
      const baseLabel = document.createElement('span')
      baseLabel.className = 'prop-label'
      baseLabel.textContent = 'Base Noise'
      const baseSel = new Select(baseOptions, fbm.baseNoise, (v) => {
        this.state.updateLayerNoise(id, { fbm: { ...fbm, baseNoise: v as NoiseType } })
      })
      baseRow.appendChild(baseLabel)
      baseRow.appendChild(baseSel.el)
      body.appendChild(baseRow)
    }

    body.appendChild(new Slider({
      label: 'Octaves', min: 1, max: 8, step: 1, value: fbm.octaves,
      defaultValue: 4, decimals: 0,
      onInput: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, octaves: v } }),
      onChange: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, octaves: v } }),
    }).el)
    body.appendChild(new Slider({
      label: 'Persistence', min: 0.1, max: 1.0, step: 0.01, value: fbm.persistence,
      defaultValue: 0.5, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, persistence: v } }),
      onChange: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, persistence: v } }),
    }).el)
    body.appendChild(new Slider({
      label: 'Lacunarity', min: 1.0, max: 4.0, step: 0.05, value: fbm.lacunarity,
      defaultValue: 2.0, decimals: 2,
      onInput: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, lacunarity: v } }),
      onChange: (v) => this.state.updateLayerNoise(id, { fbm: { ...fbm, lacunarity: v } }),
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
          const r: [number,number,number] = [...layer.noise.rotation] as [number,number,number]
          r[i] = v
          this.state.updateLayerNoise(id, { rotation: r })
        },
        onChange: (v) => {
          const r: [number,number,number] = [...layer.noise.rotation] as [number,number,number]
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
          const o: [number,number,number] = [...layer.noise.offset] as [number,number,number]
          o[i] = v
          this.state.updateLayerNoise(id, { offset: o })
        },
        onChange: (v) => {
          const o: [number,number,number] = [...layer.noise.offset] as [number,number,number]
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
      this.state.updateLayerDistortion(id, { type: v as DistortionType })
    })
    typeRow.appendChild(typeLabel)
    typeRow.appendChild(typeSel.el)
    body.appendChild(typeRow)

    if (dist.type !== DistortionType.None) {
      body.appendChild(new Slider({
        label: 'Strength', min: 0, max: 2, step: 0.01, value: dist.strength,
        defaultValue: 0.3, decimals: 2,
        onInput: (v) => this.state.updateLayerDistortion(id, { strength: v }),
        onChange: (v) => this.state.updateLayerDistortion(id, { strength: v }),
      }).el)

      if (dist.type === DistortionType.DomainWarp) {
        body.appendChild(new Slider({
          label: 'Warp Freq', min: 0.5, max: 10, step: 0.1, value: dist.warpFrequency,
          defaultValue: 2.0, decimals: 2,
          onInput: (v) => this.state.updateLayerDistortion(id, { warpFrequency: v }),
          onChange: (v) => this.state.updateLayerDistortion(id, { warpFrequency: v }),
        }).el)
      }

      if (dist.type === DistortionType.Swirl) {
        body.appendChild(new Slider({
          label: 'Swirl Amt', min: -5, max: 5, step: 0.1, value: dist.swirlAmount,
          defaultValue: 1.0, decimals: 2,
          onInput: (v) => this.state.updateLayerDistortion(id, { swirlAmount: v }),
          onChange: (v) => this.state.updateLayerDistortion(id, { swirlAmount: v }),
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
      onInput: (v) => this.state.updateLayerRemap(id, { inputMin: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { inputMin: v }),
    }).el)
    body.appendChild(new Slider({
      label: 'In Max', min: 0, max: 1, step: 0.01, value: remap.inputMax,
      defaultValue: 1, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { inputMax: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { inputMax: v }),
    }).el)
    body.appendChild(new Slider({
      label: 'Out Min', min: 0, max: 1, step: 0.01, value: remap.outputMin,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { outputMin: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { outputMin: v }),
    }).el)
    body.appendChild(new Slider({
      label: 'Out Max', min: 0, max: 1, step: 0.01, value: remap.outputMax,
      defaultValue: 1, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { outputMax: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { outputMax: v }),
    }).el)

    body.appendChild(new BezierCurveEditor({
      label: 'Remap Curve',
      value: remap.remapCurve,
      defaultValue: [0.25, 0.25, 0.75, 0.75],
      onInput: (v) => this.state.updateLayerRemap(id, { remapCurve: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { remapCurve: v }),
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
      this.state.updateLayerRemap(id, { featherShape: v as FeatherShape })
    })
    featherShapeRow.appendChild(featherShapeLabel)
    featherShapeRow.appendChild(featherShapeSel.el)
    body.appendChild(featherShapeRow)

    body.appendChild(new Slider({
      label: 'Feather X', min: 0, max: 0.5, step: 0.01, value: remap.featherX,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { featherX: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { featherX: v }),
    }).el)
    body.appendChild(new Slider({
      label: 'Feather Y', min: 0, max: 0.5, step: 0.01, value: remap.featherY,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { featherY: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { featherY: v }),
    }).el)
    body.appendChild(new Slider({
      label: 'Feather Z', min: 0, max: 0.5, step: 0.01, value: remap.featherZ,
      defaultValue: 0, decimals: 2,
      onInput: (v) => this.state.updateLayerRemap(id, { featherZ: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { featherZ: v }),
    }).el)
    body.appendChild(new BezierCurveEditor({
      label: 'Feather Curve',
      value: remap.featherCurve,
      defaultValue: [0.25, 0.25, 0.75, 0.75],
      onInput: (v) => this.state.updateLayerRemap(id, { featherCurve: v }),
      onChange: (v) => this.state.updateLayerRemap(id, { featherCurve: v }),
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

}

function getLayerEditorSignature(layer: Layer | null): string | null {
  if (!layer) return null
  return [layer.id, layer.noise.type, layer.distortion.type].join('|')
}

