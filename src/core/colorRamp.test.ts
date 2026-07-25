import { describe, it, expect } from 'vitest'
import { buildRampLUT } from './colorRamp'

const ramp = { enabled: true, stops: [
  { t: 0, color: [0,0,0] as [number,number,number], alpha: 0 },
  { t: 1, color: [255,255,255] as [number,number,number], alpha: 255 },
]}

describe('buildRampLUT', () => {
  it('produces size*4 bytes', () => { expect(buildRampLUT(ramp, 256).length).toBe(256*4) })
  it('interpolates linearly between stops', () => {
    const lut = buildRampLUT(ramp, 256)
    const mid = 128 * 4
    expect(lut[mid]).toBeGreaterThan(100); expect(lut[mid]).toBeLessThan(160) // ~127
    expect(lut[3]).toBe(0)             // first texel alpha = 0
    expect(lut[255*4+3]).toBe(255)     // last texel alpha = 255
  })
  it('clamps before first / after last stop', () => {
    const r2 = { enabled: true, stops: [
      { t: 0.4, color: [10,20,30] as [number,number,number], alpha: 100 },
      { t: 0.6, color: [200,200,200] as [number,number,number], alpha: 200 },
    ]}
    const lut = buildRampLUT(r2, 256)
    expect(lut[0]).toBe(10)            // below first stop -> first stop color
    expect(lut[255*4]).toBe(200)       // above last stop -> last stop color
  })
})
