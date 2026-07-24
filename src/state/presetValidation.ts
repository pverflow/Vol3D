// Validates untrusted preset JSON (imported files, stored/built-in preset strings)
// before it reaches StateManager.loadState. Every enum-typed field is checked
// against its allowed value set and every numeric range is clamped so bogus or
// malicious input can never reach the shader/engine layer unchecked.
//
// Note: `Partial<AppState>` only makes the top-level keys optional — a present
// key like `settings` or `layers` still requires the FULL nested type
// (VolumeSettings, Layer[], ...), not a partial one. So every sanitize*
// function here merges onto real defaults and returns a complete, valid value
// rather than a partial one; StateManager.loadState's own default-merge for
// any field we didn't touch (because its section was absent) is what makes
// omitting that key safe.
import type { AppState } from './AppState'
import { defaultLayer, defaultState } from './AppState'
import type {
  Layer, NoiseConfig, FBMConfig, SdfConfig, DistortionConfig, RemapConfig, BezierCurve,
  VolumeSettings, Resolution, SliceCount,
  PreviewSettings, AnimationSettings, CameraState,
} from '../types/index'
import {
  BlendMode, NoiseType, WorleyMode, DistortionType, FeatherShape,
  PreviewMode, SliceAxis, ProjectionMode, DEFAULT_SDF,
} from '../types/index'
import { normalizeBezierCurve, normalizeSdf } from './stateMigration'

const BLEND_MODES = new Set<string>(Object.values(BlendMode))
const NOISE_TYPES = new Set<string>(Object.values(NoiseType))
const WORLEY_MODES = new Set<string>(Object.values(WorleyMode))
const DISTORTION_TYPES = new Set<string>(Object.values(DistortionType))
const FEATHER_SHAPES = new Set<string>(Object.values(FeatherShape))
const PREVIEW_MODES = new Set<string>(Object.values(PreviewMode))
const SLICE_AXES = new Set<string>(Object.values(SliceAxis))
const PROJECTION_MODES = new Set<string>(Object.values(ProjectionMode))
// Hand-maintained against the `CameraState['dragMode']` string-literal union
// (no backing enum to derive from) — update this if that union grows.
const DRAG_MODES = new Set<string>(['orbit', 'grab'])

const RESOLUTIONS: readonly Resolution[] = [32, 64, 128, 256, 512]
const SLICE_COUNTS: readonly SliceCount[] = [16, 32, 64, 128, 256, 512]

// ---- generic guards over `unknown` (no `any`, no casts of unverified data) ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asVec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))) {
    const [x, y, z] = v as [number, number, number]
    return [x, y, z]
  }
  return fallback
}

function asBezierCurve(v: unknown, fallback: BezierCurve): BezierCurve {
  if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n))) {
    const [a, b, c, d] = v as [number, number, number, number]
    return [a, b, c, d]
  }
  return fallback
}

// `value` is only cast to T once its membership in `allowed` (built from that
// same enum's own values via Object.values) has been verified at runtime.
function coerceEnum<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function snapToAllowed<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  const n = asFiniteNumber(value)
  if (n === undefined) return fallback
  const exact = allowed.find(a => a === n)
  if (exact !== undefined) return exact
  return allowed.reduce((best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best))
}

// ---- layer sanitization ----

function sanitizeFbm(raw: unknown, fallback: FBMConfig): FBMConfig {
  const rec = isRecord(raw) ? raw : {}
  return {
    baseNoise: coerceEnum(rec.baseNoise, NOISE_TYPES, fallback.baseNoise),
    octaves: clamp(asFiniteNumber(rec.octaves) ?? fallback.octaves, 1, 8),
    persistence: asFiniteNumber(rec.persistence) ?? fallback.persistence,
    lacunarity: asFiniteNumber(rec.lacunarity) ?? fallback.lacunarity,
  }
}

function asSdfInput(v: unknown): Partial<SdfConfig> | undefined {
  if (!isRecord(v)) return undefined
  return { radius: asFiniteNumber(v.radius), softness: asFiniteNumber(v.softness) }
}

function sanitizeNoise(raw: unknown, fallback: NoiseConfig): NoiseConfig {
  const rec = isRecord(raw) ? raw : {}
  return {
    type: coerceEnum(rec.type, NOISE_TYPES, fallback.type),
    worleyMode: coerceEnum(rec.worleyMode, WORLEY_MODES, fallback.worleyMode),
    fbm: sanitizeFbm(rec.fbm, fallback.fbm),
    sdf: normalizeSdf(asSdfInput(rec.sdf), fallback.sdf ?? DEFAULT_SDF),
    scale: asVec3(rec.scale, fallback.scale),
    amplitude: asFiniteNumber(rec.amplitude) ?? fallback.amplitude,
    offset: asVec3(rec.offset, fallback.offset),
    rotation: asVec3(rec.rotation, fallback.rotation),
    seed: asFiniteNumber(rec.seed) ?? fallback.seed,
  }
}

function sanitizeDistortion(raw: unknown, fallback: DistortionConfig): DistortionConfig {
  const rec = isRecord(raw) ? raw : {}
  return {
    type: coerceEnum(rec.type, DISTORTION_TYPES, fallback.type),
    strength: asFiniteNumber(rec.strength) ?? fallback.strength,
    warpOctaves: asFiniteNumber(rec.warpOctaves) ?? fallback.warpOctaves,
    warpFrequency: asFiniteNumber(rec.warpFrequency) ?? fallback.warpFrequency,
    swirlAmount: asFiniteNumber(rec.swirlAmount) ?? fallback.swirlAmount,
  }
}

// Legacy presets stored `remapCurve`/`featherCurve` as a bare scalar "power"
// instead of today's 4-tuple bezier. Route a finite number through the same
// legacyPowerToBezier conversion stateMigration.ts uses for the live-state
// path; otherwise fall through to the existing tuple guard (which already
// falls back to `fallback` on anything malformed). normalizeBezierCurve also
// clamps a valid tuple into range, matching the safety guarantee the rest of
// this module gives every other numeric field.
function sanitizeCurve(raw: unknown, fallback: BezierCurve): BezierCurve {
  if (typeof raw === 'number' && Number.isFinite(raw)) return normalizeBezierCurve(raw, fallback)
  return normalizeBezierCurve(asBezierCurve(raw, fallback), fallback)
}

function sanitizeRemap(raw: unknown, fallback: RemapConfig): RemapConfig {
  const rec = isRecord(raw) ? raw : {}
  // Legacy presets had one `edgeFeather` scalar instead of per-axis
  // featherX/Y/Z; mirror normalizeRemap's `?? legacyFeather` rule so an old
  // preset's feather value survives instead of silently zeroing out.
  const legacyFeather = asFiniteNumber(rec.edgeFeather)
  return {
    inputMin: asFiniteNumber(rec.inputMin) ?? fallback.inputMin,
    inputMax: asFiniteNumber(rec.inputMax) ?? fallback.inputMax,
    outputMin: asFiniteNumber(rec.outputMin) ?? fallback.outputMin,
    outputMax: asFiniteNumber(rec.outputMax) ?? fallback.outputMax,
    remapCurve: sanitizeCurve(rec.remapCurve, fallback.remapCurve),
    featherX: asFiniteNumber(rec.featherX) ?? legacyFeather ?? fallback.featherX,
    featherY: asFiniteNumber(rec.featherY) ?? legacyFeather ?? fallback.featherY,
    featherZ: asFiniteNumber(rec.featherZ) ?? legacyFeather ?? fallback.featherZ,
    featherShape: coerceEnum(rec.featherShape, FEATHER_SHAPES, fallback.featherShape),
    featherCurve: sanitizeCurve(rec.featherCurve, fallback.featherCurve),
  }
}

function sanitizeLayer(rec: Record<string, unknown>): Layer {
  const base = defaultLayer()
  return {
    id: asString(rec.id) ?? base.id,
    name: asString(rec.name) ?? base.name,
    visible: asBoolean(rec.visible) ?? base.visible,
    locked: asBoolean(rec.locked) ?? base.locked,
    solo: asBoolean(rec.solo) ?? base.solo,
    invert: asBoolean(rec.invert) ?? base.invert,
    blendMode: coerceEnum(rec.blendMode, BLEND_MODES, base.blendMode),
    opacity: clamp(asFiniteNumber(rec.opacity) ?? base.opacity, 0, 1),
    noise: sanitizeNoise(rec.noise, base.noise),
    distortion: sanitizeDistortion(rec.distortion, base.distortion),
    remap: sanitizeRemap(rec.remap, base.remap),
  }
}

// ---- settings / preview / animation / camera sanitization ----
// Same trust boundary as layers: these flow into StateManager.loadState right
// alongside layers, so the enum/range fields here get the same guard
// treatment. Each function is only called when its section is present and
// object-shaped; StateManager.loadState's default-merge covers an absent
// section on its own.

function sanitizeSettings(rec: Record<string, unknown>): VolumeSettings {
  const defaults = defaultState().settings
  return {
    resolution: 'resolution' in rec ? snapToAllowed(rec.resolution, RESOLUTIONS, defaults.resolution) : defaults.resolution,
    depth: 'depth' in rec ? snapToAllowed(rec.depth, SLICE_COUNTS, defaults.depth) : defaults.depth,
    globalSeed: asFiniteNumber(rec.globalSeed) ?? defaults.globalSeed,
    cutoff: asFiniteNumber(rec.cutoff) ?? defaults.cutoff,
    contrast: asFiniteNumber(rec.contrast) ?? defaults.contrast,
    customSliceCount: asBoolean(rec.customSliceCount) ?? defaults.customSliceCount,
  }
}

function sanitizePreview(rec: Record<string, unknown>): PreviewSettings {
  const defaults = defaultState().preview
  return {
    mode: coerceEnum(rec.mode, PREVIEW_MODES, defaults.mode),
    sliceAxis: coerceEnum(rec.sliceAxis, SLICE_AXES, defaults.sliceAxis),
    slicePosition: clamp(asFiniteNumber(rec.slicePosition) ?? defaults.slicePosition, 0, 1),
    projectionMode: coerceEnum(rec.projectionMode, PROJECTION_MODES, defaults.projectionMode),
    density: asFiniteNumber(rec.density) ?? defaults.density,
    stepCount: asFiniteNumber(rec.stepCount) ?? defaults.stepCount,
    exposure: asFiniteNumber(rec.exposure) ?? defaults.exposure,
    showTilePreview: asBoolean(rec.showTilePreview) ?? defaults.showTilePreview,
    tilePreviewDensity: asFiniteNumber(rec.tilePreviewDensity) ?? defaults.tilePreviewDensity,
  }
}

function sanitizeAnimation(rec: Record<string, unknown>): AnimationSettings {
  const defaults = defaultState().animation
  return {
    phase: clamp(asFiniteNumber(rec.phase) ?? defaults.phase, 0, 1),
    loopSeconds: asFiniteNumber(rec.loopSeconds) ?? defaults.loopSeconds,
    evolutions: asFiniteNumber(rec.evolutions) ?? defaults.evolutions,
    playing: asBoolean(rec.playing) ?? defaults.playing,
  }
}

function sanitizeCamera(rec: Record<string, unknown>): CameraState {
  const defaults = defaultState().camera
  return {
    azimuth: asFiniteNumber(rec.azimuth) ?? defaults.azimuth,
    elevation: asFiniteNumber(rec.elevation) ?? defaults.elevation,
    distance: asFiniteNumber(rec.distance) ?? defaults.distance,
    panX: asFiniteNumber(rec.panX) ?? defaults.panX,
    panY: asFiniteNumber(rec.panY) ?? defaults.panY,
    dragMode: coerceEnum(rec.dragMode, DRAG_MODES, defaults.dragMode),
  }
}

export type ParsePresetResult =
  | { ok: true; data: Partial<AppState> }
  | { ok: false; error: string }

export function parsePreset(raw: string): ParsePresetResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'Preset must be a JSON object' }
  }

  if ('layers' in parsed && !Array.isArray(parsed.layers)) {
    return { ok: false, error: '"layers" must be an array' }
  }

  const data: Partial<AppState> = {}

  if (Array.isArray(parsed.layers)) {
    data.layers = parsed.layers.filter(isRecord).map(sanitizeLayer)
  }
  if (isRecord(parsed.settings)) data.settings = sanitizeSettings(parsed.settings)
  if (isRecord(parsed.preview)) data.preview = sanitizePreview(parsed.preview)
  if (isRecord(parsed.animation)) data.animation = sanitizeAnimation(parsed.animation)
  if (isRecord(parsed.camera)) data.camera = sanitizeCamera(parsed.camera)

  const selected = parsed.selected
  if (typeof selected === 'string' || selected === null) data.selected = selected

  return { ok: true, data }
}
