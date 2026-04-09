import type { AppState } from './AppState'
import type { Layer, VolumeSettings, SliceCount } from '../types/index'
import { defaultLayer, defaultState } from './AppState'
import { uid } from '../utils/uid'
import { formatStateDebugTransition, getStateDebugConfig, isStateDebugEnabled } from '../utils/stateDebug'

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
    this.applyUpdate(key, value, 'update')
  }

  private applyUpdate<K extends StateKey>(key: K, value: AppState[K], source: string) {
    const prevValue = this.state[key]
    if (key === 'settings') {
      value = normalizeVolumeSettings(value as AppState['settings']) as AppState[K]
    }

    this.debugLogUpdate(source, key, prevValue, value)
    this.state[key] = value
    this.notify(key, source)

    // Trigger regeneration for relevant keys
    if (key === 'layers' || key === 'settings') {
      this.scheduleDirty(`${source}:${String(key)}`)
    }
    if (key === 'animation') {
      const prev = prevValue as AppState['animation']
      const next = value as AppState['animation']
      if (prev.evolutions !== next.evolutions) {
        this.scheduleDirty(`${source}:animation.evolutions`)
      }
    }
  }

  updateLayer(id: string, patch: Partial<Layer>) {
    const layers = this.state.layers.map(l =>
      l.id === id ? { ...l, ...patch } : l
    )
    this.applyUpdate('layers', layers, 'updateLayer')
  }

  updateLayerNoise(id: string, patch: Partial<Layer['noise']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    const layers = this.state.layers.map(l =>
      l.id === id ? { ...l, noise: { ...layer.noise, ...patch } } : l
    )
    this.applyUpdate('layers', layers, 'updateLayerNoise')
  }

  updateLayerDistortion(id: string, patch: Partial<Layer['distortion']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    const layers = this.state.layers.map(l =>
      l.id === id ? { ...l, distortion: { ...layer.distortion, ...patch } } : l
    )
    this.applyUpdate('layers', layers, 'updateLayerDistortion')
  }

  updateLayerRemap(id: string, patch: Partial<Layer['remap']>) {
    const layer = this.state.layers.find(l => l.id === id)
    if (!layer) return
    const layers = this.state.layers.map(l =>
      l.id === id ? { ...l, remap: { ...layer.remap, ...patch } } : l
    )
    this.applyUpdate('layers', layers, 'updateLayerRemap')
  }

  addLayer(layer: Layer) {
    this.applyUpdate('layers', [...this.state.layers, layer], 'addLayer')
    this.applyUpdate('selected', layer.id, 'addLayer')
  }

  removeLayer(id: string) {
    const layers = this.state.layers.filter(l => l.id !== id)
    this.applyUpdate('layers', layers, 'removeLayer')
    const sel = this.state.selected === id
      ? (layers.length > 0 ? layers[layers.length - 1].id : null)
      : this.state.selected
    this.applyUpdate('selected', sel, 'removeLayer')
  }

  duplicateLayer(id: string) {
    const src = this.state.layers.find(l => l.id === id)
    if (!src) return
    const copy: Layer = { ...src, id: uid(), name: src.name + ' Copy' }
    const idx = this.state.layers.findIndex(l => l.id === id)
    const layers = [...this.state.layers]
    layers.splice(idx + 1, 0, copy)
    this.applyUpdate('layers', layers, 'duplicateLayer')
    this.applyUpdate('selected', copy.id, 'duplicateLayer')
  }

  reorderLayers(from: number, to: number) {
    const layers = [...this.state.layers]
    const [item] = layers.splice(from, 1)
    layers.splice(to, 0, item)
    this.applyUpdate('layers', layers, 'reorderLayers')
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
    this.debugLogSubscription(key)
    return () => this.subscribers.get(key)?.delete(fn as Subscriber<unknown>)
  }

  private notify(key: StateKey, source = 'notify') {
    this.debugLogNotify(key, source)
    this.subscribers.get(key)?.forEach(fn => fn(this.state[key]))
  }

  private scheduleDirty(reason: string) {
    this.state.dirty = true
    this.debugLogDirty(reason, this.dirtyTimer !== null)
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
    this.debugLogLoadState(state)
    ;(Object.keys(this.state) as StateKey[]).forEach(k => this.notify(k, 'loadState'))
    this.scheduleDirty('loadState')
  }

  serialize(): string {
    const { generating, progress, dirty, ...rest } = this.state
    return JSON.stringify(rest)
  }

  private debugLogUpdate<K extends StateKey>(source: string, key: K, prevValue: AppState[K], nextValue: AppState[K]) {
    if (!isStateDebugEnabled(String(key))) return
    const subscribers = this.subscribers.get(key)?.size ?? 0
    console.debug(
      `[state] ${source} -> ${String(key)} (${formatStateDebugTransition(prevValue, nextValue)}; subscribers=${subscribers})`
    )

    if (getStateDebugConfig().verbose) {
      console.debug('[state] prev', prevValue)
      console.debug('[state] next', nextValue)
    }
  }

  private debugLogNotify(key: StateKey, source: string) {
    if (!isStateDebugEnabled(String(key))) return
    const count = this.subscribers.get(key)?.size ?? 0
    console.debug(`[state] notify ${String(key)} from ${source} -> ${count} subscriber${count === 1 ? '' : 's'}`)
  }

  private debugLogDirty(reason: string, wasPending: boolean) {
    if (!isStateDebugEnabled()) return
    console.debug(`[state] dirty scheduled (${reason}; debounce=150ms${wasPending ? '; reset' : ''})`)
  }

  private debugLogSubscription(key: StateKey) {
    if (!isStateDebugEnabled(String(key))) return
    const count = this.subscribers.get(key)?.size ?? 0
    console.debug(`[state] subscribe ${String(key)} -> ${count} subscriber${count === 1 ? '' : 's'}`)
  }

  private debugLogLoadState(state: Partial<AppState>) {
    if (!isStateDebugEnabled()) return
    const keys = Object.keys(state)
    console.debug(`[state] loadState (${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(', ') || 'none'})`)
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

