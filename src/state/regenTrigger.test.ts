import { describe, it, expect } from 'vitest'
import { shouldRegenerateOnSettings } from './StateManager'

describe('shouldRegenerateOnSettings', () => {
  const base = { resolution: 64, depth: 64, customSliceCount: false, globalSeed: 0, cutoff: 0.35, contrast: 1.5 } as const
  it('does not regenerate when only cutoff/contrast change', () => {
    expect(shouldRegenerateOnSettings(base, { ...base, cutoff: 0.5 })).toBe(false)
    expect(shouldRegenerateOnSettings(base, { ...base, contrast: 2.0 })).toBe(false)
  })
  it('does not regenerate when only customSliceCount changes', () => {
    expect(shouldRegenerateOnSettings(base, { ...base, customSliceCount: !base.customSliceCount })).toBe(false)
  })
  it('regenerates when resolution/depth/globalSeed change', () => {
    expect(shouldRegenerateOnSettings(base, { ...base, resolution: 128 })).toBe(true)
    expect(shouldRegenerateOnSettings(base, { ...base, depth: 128 })).toBe(true)
    expect(shouldRegenerateOnSettings(base, { ...base, globalSeed: 7 })).toBe(true)
  })
})
