// Pure sparse brick packer for animation caching (VFX-1).
// Dense RG volume frames are mostly empty (fire/smoke), so we pack only the
// active 16^3 bricks into a growing atlas + a per-frame indirection texture
// that maps each macrocell to its brick's slot in the atlas (or "empty").
// No GL, no DOM — pure data transform, unit-tested by round-trip.

import { BRICK_SIZE } from '../constants'

export const BRICK = BRICK_SIZE

export type PackedFrame = {
  // RGBA per macrocell, macro grid = ceil(res/BRICK) x ceil(res/BRICK) x ceil(depth/BRICK).
  // rgb = brick slot xyz (0..255 each), a = 255 active | 0 empty.
  indirection: Uint8Array
}

export function macroDims(res: number, depth: number): [number, number, number] {
  const mx = Math.ceil(res / BRICK)
  const my = Math.ceil(res / BRICK)
  const mz = Math.ceil(depth / BRICK)
  return [mx, my, mz]
}

// Cubic-ish brick grid edge length for a given brick budget: the smallest
// `bpa` whose cube (bpa^3 slots) covers maxBricks. Growing all three axes
// together (instead of a fixed base-256 decomposition that forced a
// 256-brick-wide == 4096-texel atlas past 256 bricks) keeps the atlas within
// a typical `MAX_3D_TEXTURE_SIZE` (often 2048) — see BrickCache.computeMaxBricks,
// which sizes maxBricks from both the VRAM budget and that GL limit.
// Clamped to 256: the indirection texture is RGBA8, so a brick's slot xyz
// (one coordinate per channel, see slotToXYZ) must fit 0..255 per axis — bpa
// can never exceed 256 no matter how large a budget maxBricks implies.
// BrickCache.computeMaxBricks folds this same ceiling into its own budget
// calculation so callers are never handed a maxBricks that would ask for
// more than this function can actually deliver.
export function bricksPerAxis(maxBricks: number): number {
  return Math.min(256, Math.max(1, Math.ceil(Math.cbrt(Math.max(1, maxBricks)))))
}

// Largest brick-aligned resolution ≤ sourceRes whose worst-case full
// `targetFrames` loop fits the sparse brick budget: macroDims(res,depth)
// product ≤ floor(maxBricks / targetFrames). Steps down from sourceRes by
// BRICK, preserving source aspect for depth (brick-aligned), floored at BRICK.
// Returns {res: sourceRes, ...} unchanged when the full loop already fits (low
// res) → native, today's behavior. Pure — no GL, no DOM (reuses macroDims).
// Used by AnimationController.bakeSparseCache to pick a playback bake
// resolution that fits the whole loop in VRAM at high source res (VFX-1).
export function bakePlaybackResolution(
  maxBricks: number,
  sourceRes: number,
  sourceDepth: number,
  targetFrames: number
): { res: number; depth: number } {
  const budget = Math.floor(maxBricks / Math.max(1, targetFrames))
  const alignedDepth = (res: number) =>
    Math.max(BRICK, Math.round((res * sourceDepth) / sourceRes / BRICK) * BRICK)
  for (let res = sourceRes; res > BRICK; res -= BRICK) {
    const depth = alignedDepth(res)
    const [mx, my, mz] = macroDims(res, depth)
    if (mx * my * mz <= budget) return { res, depth }
  }
  return { res: BRICK, depth: alignedDepth(BRICK) }
}

// Whole RG bricks (2 bytes/voxel) a VRAM budget affords.
export function maxBricksForBudget(budgetBytes: number, brick: number = BRICK): number {
  const bytesPerBrick = brick * brick * brick * 2
  return Math.max(1, Math.floor(budgetBytes / bytesPerBrick))
}

// Maps an insertion-order slot index to its xyz coordinates in the atlas
// brick grid, cubic-decomposed against a FIXED `bpa` (bricksPerAxis) shared
// by every call for the lifetime of one AtlasBuilder. `bpa` must be decided
// once, upfront (from a brick budget — see bricksPerAxis), independent of how
// many bricks actually end up used: a frame is packed (and its indirection
// texel written) before later frames have added their own bricks, so the
// same slot must always map to the same xyz no matter how many more bricks
// get appended afterward. `AtlasBuilder.data()` (placing bricks) and
// `packFrame` (writing indirection) both call this with the same `bpa` — the
// one shared source of truth reconstruct's callers rely on via the
// indirection texel.
function slotToXYZ(slot: number, bpa: number): [number, number, number] {
  const x = slot % bpa
  const y = Math.floor(slot / bpa) % bpa
  const z = Math.floor(slot / (bpa * bpa))
  return [x, y, z]
}

// 32-bit FNV-1a over a brick's raw RG bytes — a fast, deterministic content
// fingerprint used to dedup byte-identical bricks across frames (see
// AtlasBuilder.append). Not cryptographic: collisions are handled by a
// full byte-equality check on every hash hit, so a hash collision only ever
// costs a missed dedup opportunity (an extra slot), never a wrong one.
function fnv1aHex(data: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function bricksEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Accumulates active bricks (RG, BRICK^3 voxels each) across frames into a
// growing flat list, up to a fixed `maxBricks` budget (see bricksPerAxis).
// `data()` lays the accumulated bricks out into a cubic 3D grid of BRICK^3
// slots (positioned via slotToXYZ) for upload as a single RG atlas texture.
export class AtlasBuilder {
  private readonly brick: number
  private readonly bpa: number
  private readonly capacity: number
  private readonly bricks: Uint8Array[] = []
  // Content-hash -> slot, for cross-frame dedup (see append()). Keyed by a
  // cheap FNV-1a fingerprint, not the brick bytes themselves — full bytes are
  // only compared on a hash hit, to guard against the (astronomically
  // unlikely, for the few thousand bricks a loop bake ever appends) case of
  // two different bricks hashing the same.
  private readonly hashToSlot = new Map<string, number>()
  private warnedFull = false

  constructor(brick: number, maxBricks: number) {
    this.brick = brick
    this.bpa = bricksPerAxis(maxBricks)
    this.capacity = this.bpa * this.bpa * this.bpa
  }

  get bricksUsed(): number {
    return this.bricks.length
  }

  // Fixed cubic grid edge (in bricks) this builder places slots against —
  // callers that need to re-derive slot xyz (e.g. tests) must use this, not
  // a value computed from `bricksUsed`.
  get bricksPerAxis(): number {
    return this.bpa
  }

  // Atlas dims (in units of bricks) `data()` lays bricks out into — always
  // the full cube, not a tight bounding box of used slots (simpler, and the
  // unused headroom is cheap: it's just texels, not extra bricks).
  get atlasDimsInBricks(): [number, number, number] {
    return [this.bpa, this.bpa, this.bpa]
  }

  // Appends one BRICK^3 RG brick (length brick*brick*brick*2), returns its
  // slot index, or -1 if the brick budget (bpa^3 slots) is exhausted.
  // Cross-frame dedup: a brick byte-identical to one already in the atlas
  // reuses that brick's existing slot instead of consuming a fresh one —
  // static/background regions of a loop (e.g. a still base of embers, or a
  // macrocell that's fully settled between two frames) are common enough in
  // fire/smoke loops to make this worth the bookkeeping, and it's a cheap
  // Map lookup, not a scan. Upgrade path if VRAM is still tight after dedup:
  // per-brick LRU eviction instead of a hard reject (dropped macrocells just
  // stay empty).
  append(brickRG: Uint8Array): number {
    const hash = fnv1aHex(brickRG)
    const existingSlot = this.hashToSlot.get(hash)
    if (existingSlot !== undefined && bricksEqual(this.bricks[existingSlot], brickRG)) {
      return existingSlot
    }

    if (this.bricks.length >= this.capacity) {
      if (!this.warnedFull) {
        console.warn(
          `AtlasBuilder: brick budget (${this.capacity}) exhausted — further active macrocells are dropped (left empty) instead of overflowing the atlas.`
        )
        this.warnedFull = true
      }
      return -1
    }

    this.bricks.push(brickRG)
    const slot = this.bricks.length - 1
    // Only claim this hash if it wasn't already claimed by a *different*
    // brick (a collision) — leave the original mapping alone so its own
    // future duplicates keep deduping correctly instead of chasing a slot
    // that no longer matches them.
    if (existingSlot === undefined) {
      this.hashToSlot.set(hash, slot)
    }
    return slot
  }

  // Packs all accumulated bricks into a single RG atlas sized atlasDimsInBricks.
  data(): Uint8Array {
    const b = this.brick
    const [ax, ay, az] = this.atlasDimsInBricks
    const atlasResX = ax * b
    const atlasResY = ay * b
    const atlasResZ = az * b
    const out = new Uint8Array(atlasResX * atlasResY * atlasResZ * 2)

    for (let slot = 0; slot < this.bricks.length; slot++) {
      const brickData = this.bricks[slot]
      const [sx, sy, sz] = slotToXYZ(slot, this.bpa)
      const originX = sx * b
      const originY = sy * b
      const originZ = sz * b

      for (let bz = 0; bz < b; bz++) {
        for (let by = 0; by < b; by++) {
          for (let bx = 0; bx < b; bx++) {
            const srcI = (bz * b * b + by * b + bx) * 2
            const dstX = originX + bx
            const dstY = originY + by
            const dstZ = originZ + bz
            const dstI = (dstZ * atlasResX * atlasResY + dstY * atlasResX + dstX) * 2
            out[dstI] = brickData[srcI]
            out[dstI + 1] = brickData[srcI + 1]
          }
        }
      }
    }
    return out
  }
}

// Scans `dense` (RG, res*res*depth*2) for active macrocells (any voxel's
// density `.r` or heat `.g` > threshold), appends each active brick's
// voxels to `builder`, and returns the per-frame indirection texture.
// Edge macrocells (res/depth not a multiple of BRICK) are clamped to the
// volume bounds; the remainder of the brick beyond the volume stays 0
// (Uint8Array is zero-initialized).
export function packFrame(
  dense: Uint8Array,
  res: number,
  depth: number,
  builder: AtlasBuilder,
  threshold: number
): PackedFrame {
  const [mx, my, mz] = macroDims(res, depth)
  const indirection = new Uint8Array(mx * my * mz * 4)

  for (let mz_ = 0; mz_ < mz; mz_++) {
    for (let my_ = 0; my_ < my; my_++) {
      for (let mx_ = 0; mx_ < mx; mx_++) {
        const originX = mx_ * BRICK
        const originY = my_ * BRICK
        const originZ = mz_ * BRICK

        const brickData = new Uint8Array(BRICK * BRICK * BRICK * 2)
        let active = false

        for (let bz = 0; bz < BRICK; bz++) {
          const z = originZ + bz
          if (z >= depth) continue
          for (let by = 0; by < BRICK; by++) {
            const y = originY + by
            if (y >= res) continue
            for (let bx = 0; bx < BRICK; bx++) {
              const x = originX + bx
              if (x >= res) continue
              const srcI = (z * res * res + y * res + x) * 2
              const r = dense[srcI]
              const g = dense[srcI + 1]
              if (r > threshold || g > threshold) active = true
              const dstI = (bz * BRICK * BRICK + by * BRICK + bx) * 2
              brickData[dstI] = r
              brickData[dstI + 1] = g
            }
          }
        }

        const macroI = (mz_ * mx * my + my_ * mx + mx_) * 4
        if (active) {
          const slot = builder.append(brickData)
          if (slot >= 0) {
            const [sx, sy, sz] = slotToXYZ(slot, builder.bricksPerAxis)
            indirection[macroI] = sx
            indirection[macroI + 1] = sy
            indirection[macroI + 2] = sz
            indirection[macroI + 3] = 255
          }
          // else: brick budget exhausted (builder already warned) — leave
          // this macrocell's texel at [0,0,0,0], same as a genuinely empty one.
        }
        // else: leave the texel at [0,0,0,0] (Uint8Array default) — empty.
      }
    }
  }

  return { indirection }
}

// Rebuilds the dense RG frame (res*res*depth*2) from `atlas` + `packed.indirection`.
// Empty macrocells become all-zero. `atlasDimsInBricks` must match the
// builder's `atlasDimsInBricks` when the atlas was produced by `data()` (it
// only affects the atlas's own flat-array layout — slot placement itself is
// fixed, see slotToXYZ above).
export function reconstruct(
  atlas: Uint8Array,
  atlasDimsInBricks: [number, number, number],
  packed: PackedFrame,
  res: number,
  depth: number,
  brick: number
): Uint8Array {
  const [ax, ay] = atlasDimsInBricks
  const atlasResX = ax * brick
  const atlasResY = ay * brick

  const [mx, my, mz] = macroDims(res, depth)
  const out = new Uint8Array(res * res * depth * 2)

  for (let mz_ = 0; mz_ < mz; mz_++) {
    for (let my_ = 0; my_ < my; my_++) {
      for (let mx_ = 0; mx_ < mx; mx_++) {
        const macroI = (mz_ * mx * my + my_ * mx + mx_) * 4
        const active = packed.indirection[macroI + 3] !== 0
        if (!active) continue

        const sx = packed.indirection[macroI]
        const sy = packed.indirection[macroI + 1]
        const sz = packed.indirection[macroI + 2]
        const originAtlasX = sx * brick
        const originAtlasY = sy * brick
        const originAtlasZ = sz * brick

        const originX = mx_ * BRICK
        const originY = my_ * BRICK
        const originZ = mz_ * BRICK

        for (let bz = 0; bz < brick; bz++) {
          const z = originZ + bz
          if (z >= depth) continue
          for (let by = 0; by < brick; by++) {
            const y = originY + by
            if (y >= res) continue
            for (let bx = 0; bx < brick; bx++) {
              const x = originX + bx
              if (x >= res) continue
              const atlasX = originAtlasX + bx
              const atlasY = originAtlasY + by
              const atlasZ = originAtlasZ + bz
              const srcI = (atlasZ * atlasResX * atlasResY + atlasY * atlasResX + atlasX) * 2
              const dstI = (z * res * res + y * res + x) * 2
              out[dstI] = atlas[srcI]
              out[dstI + 1] = atlas[srcI + 1]
            }
          }
        }
      }
    }
  }

  return out
}
