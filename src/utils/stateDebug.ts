import type { AppState } from '../state/AppState'

export type StateKeyName = keyof AppState

type StateDebugWindowValue = boolean | string | string[] | {
  enabled?: boolean
  keys?: string | string[]
  verbose?: boolean
}

export interface StateDebugConfig {
  enabled: boolean
  keys: Set<string> | null
  verbose: boolean
  source: 'query' | 'window' | 'storage' | 'none'
}

declare global {
  interface Window {
    __VOL3D_DEBUG_STATE__?: StateDebugWindowValue
    __VOL3D_DEBUG_STATE_VERBOSE__?: boolean
  }
}

const QUERY_KEY = 'vol3dStateDebug'
const QUERY_VERBOSE_KEY = 'vol3dStateDebugVerbose'
const STORAGE_KEY = 'vol3d:debug:state'
const STORAGE_VERBOSE_KEY = 'vol3d:debug:state:verbose'

// Enable examples:
//   ?vol3dStateDebug=layers,selected
//   localStorage.setItem('vol3d:debug:state', 'layers')
//   window.__VOL3D_DEBUG_STATE__ = true
export function getStateDebugConfig(): StateDebugConfig {
  if (typeof window === 'undefined') {
    return { enabled: false, keys: null, verbose: false, source: 'none' }
  }

  const query = readQueryValue(window.location.search)
  if (query) {
    return {
      enabled: query.enabled,
      keys: query.keys,
      verbose: readQueryVerbose(window.location.search, query.verbose),
      source: 'query',
    }
  }

  const win = parseStateDebugValue(window.__VOL3D_DEBUG_STATE__)
  if (win) {
    return {
      enabled: win.enabled,
      keys: win.keys,
      verbose: window.__VOL3D_DEBUG_STATE_VERBOSE__ ?? win.verbose,
      source: 'window',
    }
  }

  const storage = readStorageValue()
  if (storage) {
    return {
      enabled: storage.enabled,
      keys: storage.keys,
      verbose: readStorageVerbose(storage.verbose),
      source: 'storage',
    }
  }

  return { enabled: false, keys: null, verbose: false, source: 'none' }
}

export function isStateDebugEnabled(key?: string): boolean {
  const config = getStateDebugConfig()
  if (!config.enabled) return false
  if (!key || config.keys === null) return true
  return config.keys.has(key)
}

export function isStateDebugVerbose(): boolean {
  return getStateDebugConfig().verbose
}

export function formatStateDebugTransition(prev: unknown, next: unknown): string {
  const ref = Object.is(prev, next) ? 'same-ref' : 'new-ref'
  const prevDesc = describeValue(prev)
  const nextDesc = describeValue(next)
  return prevDesc === nextDesc
    ? `${ref}, ${nextDesc}`
    : `${ref}, ${prevDesc} -> ${nextDesc}`
}

function readQueryValue(search: string) {
  const params = new URLSearchParams(search)
  return parseStateDebugValue(params.get(QUERY_KEY))
}

function readQueryVerbose(search: string, fallback: boolean): boolean {
  const params = new URLSearchParams(search)
  const value = params.get(QUERY_VERBOSE_KEY)
  if (value === null) return fallback
  return parseBoolean(value, fallback)
}

function readStorageValue() {
  try {
    return parseStateDebugValue(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

function readStorageVerbose(fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(STORAGE_VERBOSE_KEY)
    return value === null ? fallback : parseBoolean(value, fallback)
  } catch {
    return fallback
  }
}

function parseStateDebugValue(value: StateDebugWindowValue | null | undefined): {
  enabled: boolean
  keys: Set<string> | null
  verbose: boolean
} | null {
  if (value == null) return null

  if (typeof value === 'boolean') {
    return { enabled: value, keys: null, verbose: false }
  }

  if (Array.isArray(value)) {
    const keys = toKeySet(value)
    return { enabled: true, keys, verbose: false }
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (isFalseLike(trimmed)) return { enabled: false, keys: null, verbose: false }
    if (isTrueLike(trimmed)) return { enabled: true, keys: null, verbose: false }
    return { enabled: true, keys: toKeySet(trimmed.split(',')), verbose: false }
  }

  const keys = value.keys == null
    ? null
    : Array.isArray(value.keys)
      ? toKeySet(value.keys)
      : toKeySet(value.keys.split(','))

  const enabled = value.enabled ?? keys !== null
  return {
    enabled,
    keys,
    verbose: value.verbose ?? false,
  }
}

function toKeySet(values: string[]): Set<string> | null {
  const keys = values
    .map(value => value.trim())
    .filter(Boolean)
  return keys.length > 0 ? new Set(keys) : null
}

function parseBoolean(value: string, fallback: boolean): boolean {
  const trimmed = value.trim()
  if (isTrueLike(trimmed)) return true
  if (isFalseLike(trimmed)) return false
  return fallback
}

function isTrueLike(value: string): boolean {
  return value === '1' || value === 'true' || value === 'on' || value === '*'
}

function isFalseLike(value: string): boolean {
  return value === '0' || value === 'false' || value === 'off'
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`
  if (value === null) return 'null'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

