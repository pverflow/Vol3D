import { describe, it, expect } from 'vitest'
import { sphereField, boxField, coneField } from './sdfField'

describe('sdf fields (1 - smoothstep(0, softness, signedDistance))', () => {
  it('sphere: full inside, ~half at surface band, zero outside', () => {
    expect(sphereField([0,0,0], 0.3, 0.1)).toBeCloseTo(1, 6)      // center: sd=-0.3 -> 1
    expect(sphereField([0.3,0,0], 0.3, 0.1)).toBeCloseTo(1, 6)     // surface: sd=0 -> smoothstep(0,.1,0)=0 -> 1
    expect(sphereField([0.45,0,0], 0.3, 0.1)).toBe(0)             // sd=0.15 > softness -> 0
  })
  it('box: inside corner vs outside', () => {
    expect(boxField([0,0,0], 0.2, 0.05)).toBeCloseTo(1, 6)
    expect(boxField([0.4,0.4,0.4], 0.2, 0.05)).toBe(0)
  })
  it('cone returns a value in [0,1]', () => {
    const v = coneField([0,0.1,0], 0.3, 0.1)
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
  })
})
