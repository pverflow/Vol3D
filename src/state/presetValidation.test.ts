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

  it('clamps layer temperature to 0..1 and defaults when absent', () => {
    const hot = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin', temperature: 5 } }] }))
    if (hot.ok) expect(hot.data.layers![0].noise.temperature).toBeLessThanOrEqual(1)
    const absent = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin' } }] }))
    if (absent.ok) expect(absent.data.layers![0].noise.temperature).toBe(0)
  })
})
