import { describe, it, expect } from 'vitest'
import { AtlasBuilder, packFrame, reconstruct, BRICK } from './brickPack'

// tiny volume: res=32, depth=32 → macrocells 2x2x2 (BRICK=16)
function makeDense(res: number, depth: number, fill: (x: number, y: number, z: number) => [number, number]) {
  const out = new Uint8Array(res * res * depth * 2)
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const i = (z * res * res + y * res + x) * 2
        const [d, h] = fill(x, y, z)
        out[i] = d
        out[i + 1] = h
      }
  return out
}

describe('brickPack round-trip', () => {
  it('reconstructs active bricks exactly and zeros empty ones', () => {
    const res = 32,
      depth = 32
    // one active brick: the (0,0,0) 16^3 corner has density 200
    const dense = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [200, 50] : [0, 0]))
    const builder = new AtlasBuilder(BRICK)
    const packed = packFrame(dense, res, depth, builder, 0)
    const atlasDims: [number, number, number] = [Math.max(builder.bricksUsed, 1), 1, 1]
    const recon = reconstruct(builder.data(atlasDims), atlasDims, packed, res, depth, BRICK)
    // active corner preserved
    expect(recon[0]).toBe(200)
    expect(recon[1]).toBe(50)
    // an empty region is zero
    const j = (20 * res * res + 20 * res + 20) * 2
    expect(recon[j]).toBe(0)
    expect(recon[j + 1]).toBe(0)
    // exactly 1 active brick out of 8 macrocells
    expect(builder.bricksUsed).toBe(1)
  })

  it('accumulates two frames with different active bricks in one builder', () => {
    const res = 32,
      depth = 32
    // frame A: corner (0,0,0) active
    const denseA = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [111, 11] : [0, 0]))
    // frame B: the opposite corner (16,16,16) active
    const denseB = makeDense(res, depth, (x, y, z) => (x >= 16 && y >= 16 && z >= 16 ? [222, 22] : [0, 0]))

    const builder = new AtlasBuilder(BRICK)
    const packedA = packFrame(denseA, res, depth, builder, 0)
    const packedB = packFrame(denseB, res, depth, builder, 0)

    expect(builder.bricksUsed).toBe(2)

    const atlasDims: [number, number, number] = [builder.bricksUsed, 1, 1]
    const atlas = builder.data(atlasDims)

    const reconA = reconstruct(atlas, atlasDims, packedA, res, depth, BRICK)
    const reconB = reconstruct(atlas, atlasDims, packedB, res, depth, BRICK)

    // frame A: corner active, opposite corner still zero
    expect(reconA[0]).toBe(111)
    expect(reconA[1]).toBe(11)
    const kA = (16 * res * res + 16 * res + 16) * 2
    expect(reconA[kA]).toBe(0)
    expect(reconA[kA + 1]).toBe(0)

    // frame B: opposite corner active, origin still zero
    const kB = (16 * res * res + 16 * res + 16) * 2
    expect(reconB[kB]).toBe(222)
    expect(reconB[kB + 1]).toBe(22)
    expect(reconB[0]).toBe(0)
    expect(reconB[1]).toBe(0)
  })
})
