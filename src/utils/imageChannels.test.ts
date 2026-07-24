import { describe, it, expect } from 'vitest'
import { redToGray } from './imageChannels'

describe('redToGray', () => {
  it('splats red into green and blue, forces alpha 255', () => {
    // one red-only pixel (r=200,g=0,b=0,a=255) as read back from an R8 texture
    const src = new Uint8Array([200, 0, 0, 255])
    const out = redToGray(src)
    expect(Array.from(out)).toEqual([200, 200, 200, 255])
  })

  it('does not mutate the input', () => {
    const src = new Uint8Array([120, 0, 0, 255])
    redToGray(src)
    expect(Array.from(src)).toEqual([120, 0, 0, 255])
  })
})
