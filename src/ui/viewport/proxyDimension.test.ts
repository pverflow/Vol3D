import { describe, it, expect } from 'vitest'
import { proxyDimension } from './proxyDimension'

describe('proxyDimension', () => {
  it('halves resolution above the floor', () => {
    expect(proxyDimension(512)).toBe(256)
    expect(proxyDimension(128)).toBe(64)
  })
  it('floors at PROXY_MIN_RES', () => {
    expect(proxyDimension(64)).toBe(32)
    expect(proxyDimension(32)).toBe(32)
  })
  it('never exceeds the source dimension', () => {
    expect(proxyDimension(16)).toBe(16)
  })
})
