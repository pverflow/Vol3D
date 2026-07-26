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

function macroDims(res: number, depth: number): [number, number, number] {
  const mx = Math.ceil(res / BRICK)
  const my = Math.ceil(res / BRICK)
  const mz = Math.ceil(depth / BRICK)
  return [mx, my, mz]
}

// Maps an insertion-order slot index to its xyz coordinates in the atlas
// brick grid, as a fixed base-256 decomposition (x = low byte, y = mid byte,
// z = high byte). This is deliberately independent of the atlas's final
// dimensions: a frame is packed (and its indirection texel written) before
// the loop-wide atlas size is known — later frames can still add bricks
// after this one. Using a fixed radix (not modulo by the eventual atlas
// width) means the same slot always maps to the same xyz no matter how many
// more bricks get appended afterward. `AtlasBuilder.data()` (placing bricks)
// and `packFrame` (writing indirection) both call this — the one shared
// source of truth reconstruct's callers rely on via the indirection texel.
function slotToXYZ(slot: number): [number, number, number] {
  const x = slot % 256
  const y = Math.floor(slot / 256) % 256
  const z = Math.floor(slot / 65536)
  return [x, y, z]
}

// Accumulates active bricks (RG, BRICK^3 voxels each) across frames into a
// growing flat list. `data()` lays the accumulated bricks out into a 3D grid
// of BRICK^3 slots (positioned via slotToXYZ) for upload as a single RG atlas
// texture. `atlasDimsInBricks` only needs to be large enough to contain every
// used slot's xyz — it does not affect where a given slot lands.
export class AtlasBuilder {
  private readonly brick: number
  private readonly bricks: Uint8Array[] = []

  constructor(brick: number) {
    this.brick = brick
  }

  get bricksUsed(): number {
    return this.bricks.length
  }

  // Appends one BRICK^3 RG brick (length brick*brick*brick*2), returns its slot index.
  append(brickRG: Uint8Array): number {
    this.bricks.push(brickRG)
    return this.bricks.length - 1
  }

  // Packs all accumulated bricks into a single RG atlas sized atlasDimsInBricks
  // (in units of bricks, not voxels).
  data(atlasDimsInBricks: readonly [number, number, number]): Uint8Array {
    const b = this.brick
    const [ax, ay, az] = atlasDimsInBricks
    const atlasResX = ax * b
    const atlasResY = ay * b
    const atlasResZ = az * b
    const out = new Uint8Array(atlasResX * atlasResY * atlasResZ * 2)

    for (let slot = 0; slot < this.bricks.length; slot++) {
      const brickData = this.bricks[slot]
      const [sx, sy, sz] = slotToXYZ(slot)
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
          const [sx, sy, sz] = slotToXYZ(slot)
          indirection[macroI] = sx
          indirection[macroI + 1] = sy
          indirection[macroI + 2] = sz
          indirection[macroI + 3] = 255
        }
        // else: leave the texel at [0,0,0,0] (Uint8Array default) — empty.
      }
    }
  }

  return { indirection }
}

// Rebuilds the dense RG frame (res*res*depth*2) from `atlas` + `packed.indirection`.
// Empty macrocells become all-zero. `atlasDimsInBricks` must match the dims
// passed to AtlasBuilder.data() when the atlas was produced (it only affects
// the atlas's own flat-array layout — slot placement itself is fixed, see
// slotToXYZ above).
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
