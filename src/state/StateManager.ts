import type { AppState } from './AppState'
import type { Layer, VolumeSettings, SliceCount } from '../types/index'
import { defaultLayer, defaultState } from './AppState'
import { uid } from '../utils/uid'

type Subscriber<T> = (value: T) => void
type StateKey = keyof AppState

export class StateManager {
  private state: AppState
  private subscribers = new Map<StateKey, Set<Subscriber<unknown>>>()
  private dirtyTimer: number | null = null
  private onDirty: (() => void) | null = null

  constructor(onDirty?: () => void) {
    this.state = defaultState()
    this.onDirty = onDirty ?? null
    // Select first layer by default
    if (this.state.layers.length > 0) {
      this.state.selected = this.state.layers[0].id
    }
  }

  get<K extends StateKey>(key: K): AppState[K] {
    return this.state[key] as AppState[K]
  }

  getState(): Readonly<AppState> {
    return this.state
  }

  update<K extends StateKey>(key: K, value: AppState[K]) {
    const prevValue = this.state[key]
    if (key === 'settings') {
      value = normalizeVolumeSettings(value as AppState['settings']) as AppState[K]
    }
    this.state[key] = value
    this.notify(key)

    // Trigger regeneration for relevant keys
    if (key === 'layers' || key === 'settings') {
      this.scheduleDirty()
    }
    if (key === 'animation') {
      const prev = prevValue as AppState['animation']
      const next = value as AppState['animation']
      if (prev.evolutions !== next.evolutions) {
        this.scheduleDirty()
      }
    }
  }

  updateLayer(id: string, patch: Partial<Layer>) {
    const layers = this.state.layers.map(l =>
      l.id === id ? { ...l, ...patch } : l
    )
    this.update('layers', layers)
  }

  updateLayerNoise(id: string, patch: Partial<Layer['noise']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    this.updateLayer(id, { noise: { ...layer.noise, ...patch } })
  }

  updateLayerDistortion(id: string, patch: Partial<Layer['distortion']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    this.updateLayer(id, { distortion: { ...layer.distortion, ...patch } })
  }

  updateLayerRemap(id: string, patch: Partial<Layer['remap']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    this.updateLayer(id, { remap: { ...layer.remap, ...patch } })
  }

  addLayer(layer: Layer) {
    this.update('layers', [...this.state.layers, layer])
    this.update('selected', layer.id)
  }

  removeLayer(id: string) {
    const layers = this.state.layers.filter(l => l.id !== id)
    this.update('layers', layers)
    const sel = this.state.selected === id
      ? (layers.length > 0 ? layers[layers.length - 1].id : null)
      : this.state.selected
    this.update('selected', sel)
  }

  duplicateLayer(id: string) {
    const src = this.state.layers.find(l => l.id === id)
    if (!src) return
    const copy: Layer = { ...src, id: uid(), name: src.name + ' Copy' }
    const idx = this.state.layers.findIndex(l => l.id === id)
    const layers = [...this.state.layers]
    layers.splice(idx + 1, 0, copy)
    this.update('layers', layers)
    this.update('selected', copy.id)
  }

  reorderLayers(from: number, to: number) {
    const layers = [...this.state.layers]
    const [item] = layers.splice(from, 1)
    layers.splice(to, 0, item)
    this.update('layers', layers)
  }

  moveLayerUp(id: string) {
    const idx = this.state.layers.findIndex(l => l.id === id)
    if (idx < this.state.layers.length - 1) this.reorderLayers(idx, idx + 1)
  }

  moveLayerDown(id: string) {
    const idx = this.state.layers.findIndex(l => l.id === id)
    if (idx > 0) this.reorderLayers(idx, idx - 1)
  }

  subscribe<K extends StateKey>(key: K, fn: Subscriber<AppState[K]>) {
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Set())
    this.subscribers.get(key)!.add(fn as Subscriber<unknown>)
    return () => this.subscribers.get(key)?.delete(fn as Subscriber<unknown>)
  }

  private notify(key: StateKey) {
    this.subscribers.get(key)?.forEach(fn => fn(this.state[key]))
  }

  private scheduleDirty() {
    this.state.dirty = true
    if (this.dirtyTimer !== null) clearTimeout(this.dirtyTimer)
    this.dirtyTimer = window.setTimeout(() => {
      this.dirtyTimer = null
      this.onDirty?.()
    }, 150)
  }

  loadState(state: Partial<AppState>) {
    const defaults = defaultState()
    const normalizedSettings = normalizeVolumeSettings({
      ...defaults.settings,
      ...state.settings,
      customSliceCount: state.settings?.customSliceCount ?? ((state.settings?.depth ?? defaults.settings.depth) !== (state.settings?.resolution ?? defaults.settings.resolution)),
    })
    this.state = {
      ...defaults,
      ...state,
      layers: (state.layers ?? defaults.layers).map(layer => normalizeLayer(layer)),
      settings: normalizedSettings,
      preview: { ...defaults.preview, ...state.preview },
      animation: { ...defaults.animation, ...state.animation },
      camera: { ...defaults.camera, ...state.camera },
    }
    ;(Object.keys(this.state) as StateKey[]).forEach(k => this.notify(k))
    this.scheduleDirty()
  }

  serialize(): string {
    const { generating, progress, dirty, ...rest } = this.state
    return JSON.stringify(rest)
  }
}

function normalizeLayer(layer: Layer): Layer {
  const base = defaultLayer(layer.name, layer.noise?.type)
  const normalizedRemap = normalizeRemap(layer.remap, base.remap)
  return {
    ...base,
    ...layer,
    noise: {
      ...base.noise,
      ...layer.noise,
      fbm: { ...base.noise.fbm, ...layer.noise?.fbm },
    },
    distortion: {
      ...base.distortion,
      ...layer.distortion,
    },
    remap: normalizedRemap,
  }
}

function normalizeRemap(
  remap: (Partial<Layer['remap']> & { edgeFeather?: number, remapCurve?: Layer['remap']['remapCurve'] | number, featherCurve?: Layer['remap']['featherCurve'] | number }) | undefined,
  base: Layer['remap']
): Layer['remap'] {
  const legacyFeather = remap?.edgeFeather ?? 0
  return {
    inputMin: remap?.inputMin ?? base.inputMin,
    inputMax: remap?.inputMax ?? base.inputMax,
    outputMin: remap?.outputMin ?? base.outputMin,
    outputMax: remap?.outputMax ?? base.outputMax,
    remapCurve: normalizeBezierCurve(remap?.remapCurve, base.remapCurve),
    featherX: remap?.featherX ?? legacyFeather ?? base.featherX,
    featherY: remap?.featherY ?? legacyFeather ?? base.featherY,
    featherZ: remap?.featherZ ?? legacyFeather ?? base.featherZ,
    featherShape: remap?.featherShape ?? base.featherShape,
    featherCurve: normalizeBezierCurve(remap?.featherCurve, base.featherCurve),
  }
}

function normalizeBezierCurve(
  curve: Layer['remap']['remapCurve'] | number | undefined,
  fallback: Layer['remap']['remapCurve']
): Layer['remap']['remapCurve'] {
  if (typeof curve === 'number') {
    return legacyPowerToBezier(curve)
  }

  if (!Array.isArray(curve) || curve.length !== 4 || curve.some(v => typeof v !== 'number' || Number.isNaN(v))) {
    return [...fallback] as Layer['remap']['remapCurve']
  }

  const x1 = clamp01(curve[0])
  const y1 = clamp01(curve[1])
  const x2 = Math.max(x1, clamp01(curve[2]))
  const y2 = clamp01(curve[3])
  return [x1, y1, x2, y2]
}

function legacyPowerToBezier(power: number): Layer['remap']['remapCurve'] {
  const p = Math.max(0.2, Math.min(4, power || 1))
  const strength = Math.min(Math.abs(p - 1) / 3, 1)

  if (p >= 1) {
    return [
      0.25,
      0.25 * (1 - strength),
      0.75,
      0.75 - 0.45 * strength,
    ]
  }

  return [
    0.25,
    0.25 + 0.45 * strength,
    0.75,
    0.75 + 0.25 * strength,
  ]
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizeVolumeSettings(settings: VolumeSettings): VolumeSettings {
  const depth = settings.customSliceCount
    ? settings.depth
    : settings.resolution as SliceCount

  return {
    resolution: settings.resolution,
    depth,
    customSliceCount: settings.customSliceCount,
    globalSeed: settings.globalSeed,
    cutoff: settings.cutoff,
    contrast: settings.contrast,
  }
}

