import { describe, it, expect } from 'vitest'
import { normalizeBezierCurve, legacyPowerToBezier, normalizeRemap, CURRENT_PRESET_VERSION } from './stateMigration'
import { defaultLayer } from './AppState'
import { StateManager } from './StateManager'
import { parsePreset } from './presetValidation'
import { BUILTIN_PRESETS } from './PresetManager'

describe('bezier normalization', () => {
  it('passes a valid 4-tuple through clamped', () => {
    expect(normalizeBezierCurve([0.25, 0.25, 0.75, 0.75], [0, 0, 1, 1])).toEqual([0.25, 0.25, 0.75, 0.75])
  })
  it('converts a legacy scalar power to a bezier curve', () => {
    const c = legacyPowerToBezier(2)
    expect(c).toHaveLength(4)
    c.forEach(v => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) })
  })
  it('falls back on a malformed curve', () => {
    // NaN fails the Number.isNaN guard inside normalizeBezierCurve -> fallback,
    // without needing an `as never` cast to fake an invalid type.
    expect(normalizeBezierCurve([NaN, 0, 1, 1], [0, 0, 1, 1])).toEqual([0, 0, 1, 1])
  })
  it('routes a legacy scalar remapCurve through legacyPowerToBezier', () => {
    expect(normalizeBezierCurve(2, [0, 0, 1, 1])).toEqual(legacyPowerToBezier(2))
  })
})

describe('normalizeRemap (legacy preset migration)', () => {
  it('maps the legacy edgeFeather field onto featherX/Y/Z', () => {
    const base = defaultLayer('Legacy').remap
    const normalized = normalizeRemap({ inputMin: 0.1, inputMax: 0.9, edgeFeather: 0.2 }, base)
    expect(normalized.featherX).toBe(0.2)
    expect(normalized.featherY).toBe(0.2)
    expect(normalized.featherZ).toBe(0.2)
    expect(normalized.remapCurve).toHaveLength(4)
    expect(normalized.featherCurve).toHaveLength(4)
  })
})

describe('preset round-trip after the stateMigration extraction', () => {
  it('loads every BUILTIN_PRESETS entry through parsePreset -> loadState', () => {
    for (const preset of BUILTIN_PRESETS) {
      const parsed = parsePreset(preset.data)
      expect(parsed.ok).toBe(true)
      const sm = new StateManager()
      if (parsed.ok) sm.loadState(parsed.data)
      expect(sm.get('layers').length).toBeGreaterThan(0)
    }
  })

  it('round-trips a live StateManager through serialize -> parsePreset -> loadState, stamped with the current version', () => {
    const sm = new StateManager()
    const serialized = sm.serialize()
    expect(JSON.parse(serialized).version).toBe(CURRENT_PRESET_VERSION)

    const parsed = parsePreset(serialized)
    expect(parsed.ok).toBe(true)
    const sm2 = new StateManager()
    if (parsed.ok) sm2.loadState(parsed.data)
    expect(sm2.get('layers')).toEqual(sm.get('layers'))
  })

  it('still migrates a legacy-shaped preset (edgeFeather + numeric remapCurve) end to end', () => {
    const legacyJson = JSON.stringify({
      layers: [
        {
          ...defaultLayer('Old'),
          remap: { inputMin: 0, inputMax: 1, outputMin: 0, outputMax: 1, edgeFeather: 0.3, remapCurve: 2, featherCurve: 0.5 },
        },
      ],
    })
    const parsed = parsePreset(legacyJson)
    expect(parsed.ok).toBe(true)
    const sm = new StateManager()
    if (parsed.ok) sm.loadState(parsed.data)
    const remap = sm.get('layers')[0].remap
    // Assert the actual migrated values, not just tuple shape — a fallback
    // curve also has length 4, so a shape-only check passes even when no
    // migration happened at all.
    expect(remap.featherX).toBe(0.3)
    expect(remap.featherY).toBe(0.3)
    expect(remap.featherZ).toBe(0.3)
    expect(remap.remapCurve).toEqual(legacyPowerToBezier(2))
  })
})
