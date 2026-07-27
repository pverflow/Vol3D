import { describe, it, expect } from 'vitest'
import { parsePreset } from './presetValidation'

describe('parsePreset', () => {
  it('rejects invalid JSON', () => {
    const r = parsePreset('{ not json')
    expect(r.ok).toBe(false)
  })

  it('rejects a null root', () => {
    const r = parsePreset('null')
    expect(r.ok).toBe(false)
  })

  it('rejects an array root', () => {
    const r = parsePreset('[1,2,3]')
    expect(r.ok).toBe(false)
  })

  it('rejects a non-array layers field', () => {
    const r = parsePreset(JSON.stringify({ layers: 5 }))
    expect(r.ok).toBe(false)
  })

  it('accepts a well-formed preset', () => {
    const r = parsePreset(JSON.stringify({ settings: { resolution: 64 }, layers: [] }))
    expect(r.ok).toBe(true)
  })

  it('coerces a bogus enum to the default rather than passing it through', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ blendMode: 'HACK', noise: { type: 'perlin' } }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].blendMode).not.toBe('HACK')
  })

  it('clamps octaves into range', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'fbm', fbm: { octaves: 1e9 } } }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].noise.fbm.octaves).toBeLessThanOrEqual(8)
  })

  it('clamps opacity into range', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ opacity: 5 }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].opacity).toBeLessThanOrEqual(1)
  })

  it('drops non-object entries from layers instead of crashing', () => {
    const r = parsePreset(JSON.stringify({ layers: [null, 'nope', { blendMode: 'multiply' }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers!.length).toBe(1)
  })

  it('snaps a bogus resolution to the nearest allowed value', () => {
    const r = parsePreset(JSON.stringify({ settings: { resolution: 100 } }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.settings!.resolution).toBe(128)
  })

  it('preserves a valid custom per-layer colorRamp (round-trip, not defaulted to fire)', () => {
    const custom = {
      enabled: false,
      stops: [
        { t: 0, color: [10, 20, 30], alpha: 0 },
        { t: 1, color: [200, 100, 50], alpha: 255 },
      ],
    }
    const r = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin' }, colorRamp: custom }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].colorRamp).toEqual(custom)
  })

  it('defaults a layer with no colorRamp to the fire preset', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin' } }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].colorRamp.stops.length).toBeGreaterThan(0)
    if (r.ok) expect(r.data.layers![0].colorRamp.enabled).toBe(true)
  })
})
