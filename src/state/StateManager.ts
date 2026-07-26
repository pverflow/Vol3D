import type { AppState } from './AppState'
import type { Layer, VolumeSettings, SliceCount } from '../types/index'
import { defaultState } from './AppState'
import { uid } from '../utils/uid'
import { formatStateDebugTransition, getStateDebugConfig, isStateDebugEnabled } from '../utils/stateDebug'
import { REGEN_DEBOUNCE_MS } from '../core/constants'
import { normalizeLayer, CURRENT_PRESET_VERSION } from './stateMigration'

type Subscriber<T> = (value: T) => void
type StateKey = keyof AppState

type RegenTrigger<K extends StateKey> = (prev: AppState[K], next: AppState[K]) => boolean
type RegenTriggerMap = { [K in StateKey]?: RegenTrigger<K> }

// cutoff/contrast are preview-time shading uniforms (Task 3) — they never
// require regenerating the volume, only resolution/depth/globalSeed do.
export function shouldRegenerateOnSettings(prev: VolumeSettings, next: VolumeSettings): boolean {
  return prev.resolution !== next.resolution || prev.depth !== next.depth || prev.globalSeed !== next.globalSeed
}

const REGEN_TRIGGERS: RegenTriggerMap = {
  layers: () => true,
  settings: shouldRegenerateOnSettings,
  animation: (prev, next) => prev.evolutions !== next.evolutions,
}

export class StateManager {
  private state: AppState
  private subscribers = new Map<StateKey, Set<Subscriber<unknown>>>()
  private dirtyTimer: number | null = null
  private onDirty: (() => void) | null = null
  // Ref-counts overlapping "generation in progress" sources (dense full-res
  // generation, flipbook export bake, sparse-cache bake — VFX-1 Task 5
  // carry-forward). Before this, each source called
  // update('generating', true/false) directly, so one source finishing
  // (its `finally`) could stomp `generating` back to false while ANOTHER
  // source was still actively running. beginGenerating/endGenerating make
  // "generating" only go false once every source that started has ended.
  private generatingRefCount = 0

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

  // Call once per generation source when it starts; pair with exactly one
  // endGenerating() call (typically in a finally block) when it finishes,
  // fails, or is superseded. `generating` only flips true->false when the
  // last outstanding source ends, so two overlapping sources (e.g. a
  // dense settle-regen and a sparse-cache bake both running around a
  // play-start) can't have one's completion hide the other's indicator.
  beginGenerating(): void {
    this.generatingRefCount++
    this.update('generating', true)
    this.update('progress', 0)
  }

  endGenerating(): void {
    this.generatingRefCount = Math.max(0, this.generatingRefCount - 1)
    if (this.generatingRefCount === 0) {
      this.update('generating', false)
      this.update('progress', 1)
    }
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
    const trigger = REGEN_TRIGGERS[key]
    if (trigger && trigger(prevValue, value)) {
      this.scheduleDirty(`${source}:${String(key)}`)
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
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null
      this.onDirty?.()
    }, REGEN_DEBOUNCE_MS)
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
    return JSON.stringify({ ...rest, version: CURRENT_PRESET_VERSION })
  }

  private debugLogUpdate<K extends StateKey>(source: string, key: K, prevValue: AppState[K], nextValue: AppState[K]) {
    if (!import.meta.env.DEV) return
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
    if (!import.meta.env.DEV) return
    if (!isStateDebugEnabled(String(key))) return
    const count = this.subscribers.get(key)?.size ?? 0
    console.debug(`[state] notify ${String(key)} from ${source} -> ${count} subscriber${count === 1 ? '' : 's'}`)
  }

  private debugLogDirty(reason: string, wasPending: boolean) {
    if (!import.meta.env.DEV) return
    if (!isStateDebugEnabled()) return
    console.debug(`[state] dirty scheduled (${reason}; debounce=${REGEN_DEBOUNCE_MS}ms${wasPending ? '; reset' : ''})`)
  }

  private debugLogSubscription(key: StateKey) {
    if (!import.meta.env.DEV) return
    if (!isStateDebugEnabled(String(key))) return
    const count = this.subscribers.get(key)?.size ?? 0
    console.debug(`[state] subscribe ${String(key)} -> ${count} subscriber${count === 1 ? '' : 's'}`)
  }

  private debugLogLoadState(state: Partial<AppState>) {
    if (!import.meta.env.DEV) return
    if (!isStateDebugEnabled()) return
    const keys = Object.keys(state)
    console.debug(`[state] loadState (${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(', ') || 'none'})`)
  }
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

