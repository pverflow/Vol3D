import { describe, it, expect } from 'vitest'
import { accumulateHeat } from './heatAccum'
describe('accumulateHeat', () => {
  it('adds density-weighted temperature, clamped 0..1', () => {
    expect(accumulateHeat(0, 0.5, 1)).toBeCloseTo(0.5, 6)
    expect(accumulateHeat(0.4, 0.5, 0.4)).toBeCloseTo(0.6, 6)
    expect(accumulateHeat(0.9, 1, 1)).toBe(1)      // clamps
    expect(accumulateHeat(0, 0.5, 0)).toBe(0)      // cold layer adds nothing
  })
})
