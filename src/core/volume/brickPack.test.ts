import { describe, it, expect } from 'vitest'
import { AtlasBuilder, packFrame, reconstruct, BRICK, bricksPerAxis, maxBricksForBudget, bakePlaybackResolution, macroDims } from './brickPack'
import { SPARSE_CACHE_BUDGET_BYTES } from '../constants'

// tiny volume: res=32, depth=32 → macrocells 2x2x2 (BRICK=16)
// RGBA8, 4 bytes/voxel: [R=colorR, G=colorG, B=colorB, A=density]
function makeDense(res: number, depth: number, fill: (x: number, y: number, z: number) => [number, number, number, number]) {
  const out = new Uint8Array(res * res * depth * 4)
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const i = (z * res * res + y * res + x) * 4
        const [r, g, b, a] = fill(x, y, z)
        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = a
      }
  return out
}

describe('brickPack round-trip', () => {
  it('reconstructs active bricks exactly and zeros empty ones', () => {
    const res = 32,
      depth = 32
    // one active brick: the (0,0,0) 16^3 corner has color [10,20,30] + density 200
    const dense = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [10, 20, 30, 200] : [0, 0, 0, 0]))
    const builder = new AtlasBuilder(BRICK, 8) // 2x2x2 macro grid -> at most 8 bricks
    const packed = packFrame(dense, res, depth, builder, 0)
    const atlasDims = builder.atlasDimsInBricks
    const recon = reconstruct(builder.data(), atlasDims, packed, res, depth, BRICK)
    // active corner preserved (all 4 channels)
    expect(recon[0]).toBe(10)
    expect(recon[1]).toBe(20)
    expect(recon[2]).toBe(30)
    expect(recon[3]).toBe(200)
    // an empty region is zero
    const j = (20 * res * res + 20 * res + 20) * 4
    expect(recon[j]).toBe(0)
    expect(recon[j + 1]).toBe(0)
    expect(recon[j + 2]).toBe(0)
    expect(recon[j + 3]).toBe(0)
    // exactly 1 active brick out of 8 macrocells
    expect(builder.bricksUsed).toBe(1)
  })

  it('accumulates two frames with different active bricks in one builder', () => {
    const res = 32,
      depth = 32
    // frame A: corner (0,0,0) active, color [1,2,3] density 111
    const denseA = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [1, 2, 3, 111] : [0, 0, 0, 0]))
    // frame B: the opposite corner (16,16,16) active, color [4,5,6] density 222
    const denseB = makeDense(res, depth, (x, y, z) => (x >= 16 && y >= 16 && z >= 16 ? [4, 5, 6, 222] : [0, 0, 0, 0]))

    const builder = new AtlasBuilder(BRICK, 8)
    const packedA = packFrame(denseA, res, depth, builder, 0)
    const packedB = packFrame(denseB, res, depth, builder, 0)

    expect(builder.bricksUsed).toBe(2)

    const atlasDims = builder.atlasDimsInBricks
    const atlas = builder.data()

    const reconA = reconstruct(atlas, atlasDims, packedA, res, depth, BRICK)
    const reconB = reconstruct(atlas, atlasDims, packedB, res, depth, BRICK)

    // frame A: corner active, opposite corner still zero
    expect([reconA[0], reconA[1], reconA[2], reconA[3]]).toEqual([1, 2, 3, 111])
    const kA = (16 * res * res + 16 * res + 16) * 4
    expect([reconA[kA], reconA[kA + 1], reconA[kA + 2], reconA[kA + 3]]).toEqual([0, 0, 0, 0])

    // frame B: opposite corner active, origin still zero
    const kB = (16 * res * res + 16 * res + 16) * 4
    expect([reconB[kB], reconB[kB + 1], reconB[kB + 2], reconB[kB + 3]]).toEqual([4, 5, 6, 222])
    expect([reconB[0], reconB[1], reconB[2], reconB[3]]).toEqual([0, 0, 0, 0])
  })
})

describe('active-brick threshold', () => {
  it('tests the density (alpha) byte only — big color but zero density is EMPTY', () => {
    const res = 16,
      depth = 16 // single macrocell
    // full-white color, density 0 everywhere -> must NOT be active
    const colorOnly = makeDense(res, depth, () => [255, 255, 255, 0])
    const b1 = new AtlasBuilder(BRICK, 8)
    packFrame(colorOnly, res, depth, b1, 0)
    expect(b1.bricksUsed).toBe(0)
  })

  it('any voxel with density above threshold makes the brick active (color zero)', () => {
    const res = 16,
      depth = 16
    // zero color, one voxel with density 50 -> active at threshold 10
    const densityOnly = makeDense(res, depth, (x, y, z) => (x === 0 && y === 0 && z === 0 ? [0, 0, 0, 50] : [0, 0, 0, 0]))
    const b2 = new AtlasBuilder(BRICK, 8)
    packFrame(densityOnly, res, depth, b2, 10)
    expect(b2.bricksUsed).toBe(1)
  })
})

describe('cross-frame brick dedup', () => {
  it('reuses the same atlas slot for a byte-identical brick in a later frame', () => {
    const res = 32,
      depth = 32
    // frame A and frame B share byte-identical content in their one active brick
    const denseA = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [12, 34, 56, 123] : [0, 0, 0, 0]))
    const denseB = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [12, 34, 56, 123] : [0, 0, 0, 0]))
    // frame C's active brick differs by one byte -> must NOT dedup with A/B
    const denseC = makeDense(res, depth, (x, y, z) => (x < 16 && y < 16 && z < 16 ? [12, 34, 56, 200] : [0, 0, 0, 0]))

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
    // BRICK=16 -> 16^3*4 = 16384 bytes/brick; 96MB budget -> 6144 bricks
    expect(maxBricksForBudget(96 * 1024 * 1024, BRICK)).toBe(6144)
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
      const brickData = new Uint8Array(BRICK * BRICK * BRICK * 4)
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
      const i = (sz * BRICK * atlasResX * atlasResY + sy * BRICK * atlasResX + sx * BRICK) * 4
      expect(atlas[i]).toBe(slot % 256)
      expect(atlas[i + 1]).toBe(Math.floor(slot / 256))
    }
  })

  it('bakePlaybackResolution returns native sourceRes when the full loop already fits', () => {
    // 128³ with a generous budget: the whole 32-frame loop fits at native res.
    const { res, depth } = bakePlaybackResolution(1_000_000, 128, 128, 32)
    expect(res).toBe(128)
    expect(depth).toBe(128)
  })

  it('bakePlaybackResolution reduces 512³ to the largest brick-aligned res whose loop fits', () => {
    const maxBricks = 65536
    const targetFrames = 32
    const budget = Math.floor(maxBricks / targetFrames) // 2048
    const { res, depth } = bakePlaybackResolution(maxBricks, 512, 512, targetFrames)

    expect(res % BRICK).toBe(0)
    expect(res).toBeLessThan(512)
    expect(res).toBeGreaterThanOrEqual(BRICK)

    // the whole loop fits the budget
    const [mx, my, mz] = macroDims(res, depth)
    expect(mx * my * mz).toBeLessThanOrEqual(budget)

    // and it's the LARGEST such res — one brick bigger overflows the budget
    const [bx, by, bz] = macroDims(res + BRICK, res + BRICK)
    expect(bx * by * bz).toBeGreaterThan(budget)

    // 12³=1728 ≤ 2048 < 2197=13³
    expect(res).toBe(192)
  })

  it('bakePlaybackResolution: a full 32-frame loop fits the 4-byte brick budget at 512³', () => {
    // Real budget derived at 4 bytes/brick (RGBA8) — the returned bake res's
    // whole loop must fit floor(maxBricks/targetFrames) and be a valid,
    // brick-aligned, ≤-source resolution.
    const maxBricks = maxBricksForBudget(SPARSE_CACHE_BUDGET_BYTES)
    const targetFrames = 32
    const { res, depth } = bakePlaybackResolution(maxBricks, 512, 512, targetFrames)

    expect(res % BRICK).toBe(0)
    expect(res).toBeLessThanOrEqual(512)
    expect(res).toBeGreaterThanOrEqual(BRICK)

    const [mx, my, mz] = macroDims(res, depth)
    expect(mx * my * mz).toBeLessThanOrEqual(Math.floor(maxBricks / targetFrames))
  })

  it('bakePlaybackResolution always returns brick-aligned res in [BRICK, sourceRes], cubic-in→cubic-out', () => {
    for (const sourceRes of [128, 256, 512]) {
      const { res, depth } = bakePlaybackResolution(65536, sourceRes, sourceRes, 32)
      expect(res % BRICK).toBe(0)
      expect(res).toBeGreaterThanOrEqual(BRICK)
      expect(res).toBeLessThanOrEqual(sourceRes)
      expect(depth).toBe(res) // cubic source → cubic bake
    }
  })

  it('caps appends at the brick budget (bpa^3 capacity) instead of overflowing the atlas', () => {
    const builder = new AtlasBuilder(BRICK, 8) // bpa=2 -> capacity=8, exact
    // Distinct content per brick (marker byte = i) so dedup doesn't collapse
    // these into one slot — this test is about the capacity cap, not dedup.
    for (let i = 0; i < 8; i++) {
      const brickData = new Uint8Array(BRICK * BRICK * BRICK * 4)
      brickData[0] = i
      expect(builder.append(brickData)).toBe(i)
    }
    // 9th append (also distinct content) is past capacity -> rejected, not
    // silently overflowing into another slot's territory.
    const overflow = new Uint8Array(BRICK * BRICK * BRICK * 4)
    overflow[0] = 8
    expect(builder.append(overflow)).toBe(-1)
    expect(builder.bricksUsed).toBe(8)
  })
})
