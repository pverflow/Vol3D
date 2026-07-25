// Legacy/backward-compat data-shape migration for Layer presets — not live-state
// management. Handles old preset shapes (scalar `remapCurve`/`featherCurve` power
// values, the old `edgeFeather` field) so presets exported by older Vol3D builds
// keep loading correctly. Moved verbatim out of StateManager.
import type { Layer, SdfConfig } from '../types/index'
import { DEFAULT_SDF } from '../types/index'
import { defaultLayer } from './AppState'

export const CURRENT_PRESET_VERSION = 3

// Bumped to 2: adds NoiseConfig.sdf (SDF primitive source layers, VFX-0 Task 1).
// Presets from version 1 lack `sdf` entirely; normalizeLayer below fills it in
// from defaultLayer's default, same as any other missing/legacy field.
//
// Bumped to 3: adds PreviewSettings.colorRamp (color-ramp transfer function,
// VFX-0 Task 3). Presets from version <3 lack `colorRamp` entirely; absent ->
// default (fire preset, disabled) via StateManager.loadState's shallow
// `{ ...defaults.preview, ...state.preview }` merge (live-state path) and
// presetValidation.sanitizeColorRamp's fallback (untrusted-JSON path) — no
// per-field normalizer needed here since a missing key just isn't present to
// spread over the default.

export function normalizeLayer(layer: Layer): Layer {
  const base = defaultLayer(layer.name, layer.noise?.type)
  const normalizedRemap = normalizeRemap(layer.remap, base.remap)
  return {
    ...base,
    ...layer,
    noise: {
      ...base.noise,
      ...layer.noise,
      fbm: { ...base.noise.fbm, ...layer.noise?.fbm },
      sdf: normalizeSdf(layer.noise?.sdf, base.noise.sdf ?? DEFAULT_SDF),
    },
    distortion: {
      ...base.distortion,
      ...layer.distortion,
    },
    remap: normalizedRemap,
  }
}

// Clamps sdf.radius/softness to 0..1, falling back to `base` for anything
// missing or non-finite. Shared with presetValidation.ts's untrusted-JSON path.
export function normalizeSdf(sdf: Partial<SdfConfig> | undefined, base: SdfConfig): SdfConfig {
  const radius = typeof sdf?.radius === 'number' && Number.isFinite(sdf.radius) ? sdf.radius : base.radius
  const softness = typeof sdf?.softness === 'number' && Number.isFinite(sdf.softness) ? sdf.softness : base.softness
  return { radius: clamp01(radius), softness: clamp01(softness) }
}

export function normalizeRemap(
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

export function normalizeBezierCurve(
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

export function legacyPowerToBezier(power: number): Layer['remap']['remapCurve'] {
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

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
