import { describe, it, expect } from 'vitest'
import { computeCacheFrameCount } from './animationCache'

describe('computeCacheFrameCount', () => {
  it('caps at the max frame count for small volumes', () => {
    // 32^3 = 32768 bytes/frame; budget allows far more than the 24 cap
    expect(computeCacheFrameCount(32, 32)).toBe(24)
  })
  it('is limited by the memory budget for large volumes', () => {
    // 512^3 = 134,217,728 bytes/frame > 96MB budget -> 0 frames
    expect(computeCacheFrameCount(512, 512)).toBe(0)
  })
  it('never returns negative', () => {
    expect(computeCacheFrameCount(512, 512)).toBeGreaterThanOrEqual(0)
  })
})
