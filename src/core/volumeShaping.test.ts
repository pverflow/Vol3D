import { describe, it, expect } from 'vitest'
import { applyDensityShaping } from './volumeShaping'

describe('applyDensityShaping', () => {
  it('matches the v1 threshold+contrast formula', () => {
    // v1: thresholded = max((v-cutoff)/max(1-cutoff,1e-4),0); (t-0.5)*contrast+0.5, clamped 0..1
    expect(applyDensityShaping(0.5, 0.0, 1.0)).toBeCloseTo(0.5, 6)
    expect(applyDensityShaping(0.2, 0.35, 1.5)).toBe(0)          // below cutoff -> 0
    expect(applyDensityShaping(1.0, 0.0, 1.0)).toBeCloseTo(1.0, 6)
    expect(applyDensityShaping(0.5, 0.0, 2.0)).toBeCloseTo(0.5, 6) // midpoint invariant under contrast
  })
  it('clamps to [0,1]', () => {
    expect(applyDensityShaping(1.0, 0.0, 4.0)).toBeLessThanOrEqual(1)
    expect(applyDensityShaping(0.0, 0.0, 4.0)).toBeGreaterThanOrEqual(0)
  })
})
