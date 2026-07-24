// Debounce before regenerating the volume after a state change.
export const REGEN_DEBOUNCE_MS = 150
// Minimum wall-clock between animation phase advances (~10fps playback).
export const ANIMATION_MIN_FRAME_MS = 100
// Memory budget for the pre-baked animation frame cache.
export const ANIMATION_CACHE_BUDGET_BYTES = 96 * 1024 * 1024
export const ANIMATION_CACHE_MAX_FRAMES = 24
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
