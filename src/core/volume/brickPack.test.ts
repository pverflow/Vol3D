import { describe, it, expect } from 'vitest'
import { AtlasBuilder, packFrame, reconstruct, BRICK, bricksPerAxis, maxBricksForBudget } from './brickPack'

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
    const builder = new AtlasBuilder(BRICK, 8) // 2x2x2 macro grid -> at most 8 bricks
    const packed = packFrame(dense, res, depth, builder, 0)
    const atlasDims = builder.atlasDimsInBricks
    const recon = reconstruct(builder.data(), atlasDims, packed, res, depth, BRICK)
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

    const builder = new AtlasBuilder(BRICK, 8)
    const packedA = packFrame(denseA, res, depth, builder, 0)
    const packedB = packFrame(denseB, res, depth, builder, 0)

    expect(builder.bricksUsed).toBe(2)

    const atlasDims = builder.atlasDimsInBricks
    const atlas = builder.data()

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

describe('cross-frame brick dedup', () => {
  it('reuses the same atlas slot for a byte-identical brick in a later frame', () => {
    const res = 32,
      depth = 32
    // frame A and frame B share byte-identical content in their one active brick
    const denseA = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [123, 45] : [0, 0]))
    const denseB = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [123, 45] : [0, 0]))
    // frame C's active brick differs by one byte -> must NOT dedup with A/B
    const denseC = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [200, 45] : [0, 0]))

    const builder = new AtlasBuilder(BRICK, 8)
    const packedA = packFrame(denseA, res, depth, builder, 0)
    expect(builder.bricksUsed).toBe(1)

    const packedB = packFrame(denseB, res, depth, builder, 0)
    // identical content -> deduped onto A's existing slot, no new brick appended
    expect(builder.bricksUsed).toBe(1)
    expect(packedB.indirection[0]).toBe(packedA.indirection[0])
    expect(packedB.indirection[1]).toBe(packedA.indirection[1])
    expect(packedB.indirection[2]).toBe(packedA.indirection[2])
    expect(packedB.indirection[3]).toBe(255)

    const packedC = packFrame(denseC, res, depth, builder, 0)
    // different content -> a genuinely new brick
    expect(builder.bricksUsed).toBe(2)
    expect(packedC.indirection[3]).toBe(255)
  })
})

describe('cubic atlas layout (past the old 256-brick cliff)', () => {
  it('bricksPerAxis grows as a cube root, not a fixed 256-wide axis', () => {
    expect(bricksPerAxis(1)).toBe(1)
    expect(bricksPerAxis(8)).toBe(2)
    expect(bricksPerAxis(9)).toBe(3) // cbrt(9) ~ 2.08 -> rounds up
    expect(bricksPerAxis(300)).toBe(7) // 6^3=216 < 300 <= 343=7^3
  })

  it('bricksPerAxis clamps at 256 — the indirection texel can only encode 0..255 per axis', () => {
    expect(bricksPerAxis(256 ** 3)).toBe(256)
    expect(bricksPerAxis(256 ** 3 + 1)).toBe(256) // a bigger budget still can't ask for more
  })

  it('maxBricksForBudget divides the VRAM budget by bytes-per-brick', () => {
    // BRICK=16 -> 16^3*2 = 8192 bytes/brick; 96MB budget -> 12288 bricks
    expect(maxBricksForBudget(96 * 1024 * 1024, BRICK)).toBe(12288)
  })

  it('keeps atlas dims small and cubic even with >256 bricks used, and round-trips slots past the old 256 cliff', () => {
    const maxBricks = 300
    const builder = new AtlasBuilder(BRICK, maxBricks)

    // Append 260 distinct bricks (each stamped with its own slot as a marker
    // at the brick's local origin voxel) — this alone exceeds the old fixed
    // base-256 scheme's per-axis width, which would have forced a
    // 256*16=4096-texel-wide atlas axis (past most MAX_3D_TEXTURE_SIZE limits).
    const bricksUsedTarget = 260
    for (let slot = 0; slot < bricksUsedTarget; slot++) {
      const brickData = new Uint8Array(BRICK * BRICK * BRICK * 2)
      brickData[0] = slot % 256
      brickData[1] = Math.floor(slot / 256)
      expect(builder.append(brickData)).toBe(slot)
    }
    expect(builder.bricksUsed).toBe(bricksUsedTarget)

    // bpa = ceil(cbrt(300)) = 7 -> atlas is 7x7x7 bricks (112 texels/axis),
    // nowhere near the old scheme's forced 256-wide (4096-texel) axis.
    const bpa = builder.bricksPerAxis
    expect(bpa).toBe(7)
    expect(builder.atlasDimsInBricks).toEqual([7, 7, 7])

    const atlas = builder.data()
    const atlasResX = bpa * BRICK
    const atlasResY = bpa * BRICK

    // Spot-check slots straddling the old 256 cliff round-trip correctly.
    for (const slot of [0, 255, 256, 259]) {
      const sx = slot % bpa
      const sy = Math.floor(slot / bpa) % bpa
      const sz = Math.floor(slot / (bpa * bpa))
      const i = (sz * BRICK * atlasResX * atlasResY + sy * BRICK * atlasResX + sx * BRICK) * 2
      expect(atlas[i]).toBe(slot % 256)
      expect(atlas[i + 1]).toBe(Math.floor(slot / 256))
    }
  })

  it('caps appends at the brick budget (bpa^3 capacity) instead of overflowing the atlas', () => {
    const builder = new AtlasBuilder(BRICK, 8) // bpa=2 -> capacity=8, exact
    // Distinct content per brick (marker byte = i) so dedup doesn't collapse
    // these into one slot — this test is about the capacity cap, not dedup.
    for (let i = 0; i < 8; i++) {
      const brickData = new Uint8Array(BRICK * BRICK * BRICK * 2)
      brickData[0] = i
      expect(builder.append(brickData)).toBe(i)
    }
    // 9th append (also distinct content) is past capacity -> rejected, not
    // silently overflowing into another slot's territory.
    const overflow = new Uint8Array(BRICK * BRICK * BRICK * 2)
    overflow[0] = 8
    expect(builder.append(overflow)).toBe(-1)
    expect(builder.bricksUsed).toBe(8)
  })
})
