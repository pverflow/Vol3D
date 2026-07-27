// Debounce before regenerating the volume after a state change.
export const REGEN_DEBOUNCE_MS = 150
// Minimum wall-clock between animation phase advances (~10fps playback).
export const ANIMATION_MIN_FRAME_MS = 100
// Memory budget for the pre-baked (dense, per-frame) animation frame cache.
export const ANIMATION_CACHE_BUDGET_BYTES = 96 * 1024 * 1024
export const ANIMATION_CACHE_MAX_FRAMES = 24
// Dedicated VRAM cap for the sparse brick-atlas animation cache (VFX-1 Task
// 1 tuning). Kept separate from ANIMATION_CACHE_BUDGET_BYTES above: the
// sparse atlas is a single shared GPU texture (bricks are deduped across the
// whole loop, not duplicated per frame — see AtlasBuilder), so it affords a
// much bigger budget than a dense cache that stores every frame's full
// volume. 512MB is comfortably inside a typical discrete GPU's VRAM and
// still miles below the 256^3-bpa / MAX_3D_TEXTURE_SIZE atlas ceilings that
// BrickCache.computeMaxBricks also folds in.
export const SPARSE_CACHE_BUDGET_BYTES = 512 * 1024 * 1024
// Sparse brick-grid animation cache: brick edge (voxels) and default loop length.
export const BRICK_SIZE = 16
export const ANIM_LOOP_FRAMES_DEFAULT = 32
// "Active" epsilon (density/heat, 0..255) a brick must exceed to be packed
// into the sparse cache atlas (VFX-1 Task 3 bake). A bare >0 threshold would
// treat almost every macrocell as active for continuous noise fields (the
// noise floor is rarely exactly zero) and defeat the point of culling empty
// space; a small epsilon keeps genuinely empty regions out while still
// packing faint smoke.
export const SPARSE_ACTIVE_THRESHOLD = 1
// Raymarch camera: tan(fov/2) with a 60deg vertical FOV.
export const RAYMARCH_TAN_HALF_FOV = Math.tan(Math.PI / 6)
export const LIGHT_DIR: readonly [number, number, number] = [0.577, 0.577, 0.577]
// Low-res "drag proxy" (Task 4): while a generation-affecting control (scale,
// rotation, offset, warp, octaves, seed, ...) is being dragged, generation
// targets a cheap proxy volume at resolution/depth divided by this factor
// instead of full resolution, so authoring feels live at any resolution.
export const PROXY_RES_FACTOR = 2
// Floor so the drag proxy never shrinks below a coherent minimum resolution.
export const PROXY_MIN_RES = 32
