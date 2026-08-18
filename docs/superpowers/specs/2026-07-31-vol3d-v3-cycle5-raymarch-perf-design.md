# Vol3D v3 — Cycle ⑤ Raymarch Perf: Empty-Space Skipping + Reduced-Res Playback Bake — Design

**Date:** 2026-07-31
**Status:** Approved (user: "go ahead"). Follows the systematic-debug finding that 256³ playback is **raymarch-render-bound**, not cache-bound (scrub ≈ play ≈ 1-2 fps, and scrub never bakes → the shared cost is the raymarch of a 64 MB 3D texture over 128 steps × full retina canvas).
**Parent:** v3 direction spec; builds on cycle ④ (animation + dense frame cache).

## Goal

Make 256³ interactive + playback fast and memory-efficient via two composable render-side levers (v2's proven high-res playbook):
1. **Empty-space skipping** — the raymarch jumps over empty macrocells instead of fine-stepping through the void (fire/smoke is 80-95% empty), collapsing the expensive trilinear taps to occupied regions only. Helps **live, paused, and playback**.
2. **Reduced-resolution playback bake** — the dense frame cache bakes the loop at a **lower volume resolution** (smaller per-frame textures) → the **full loop fits VRAM** (no clamp to 8 frames = memory efficient) **and** each frame is a smaller texture → far less raymarch bandwidth (faster). **Snap to full-res on pause/idle** (crisp when still).

The generation, dense-cache-no-readback, and animation logic (cycle ④) are unchanged in structure — this adds an occupancy overlay + a bake-resolution knob.

## Part 1 — Empty-space skipping (occupancy overlay)

- **Occupancy 3D texture:** a coarse macrocell grid, `macro = ceil(res / MACRO)` with `MACRO = 8` (256³→32³, 128³→16³). Each texel = **max density (alpha) in that macrocell**, `r8unorm`. Tiny (32³ = 32 KB).
- **Build compute pass** (`occupancy.wgsl`): after a volume is generated, one invocation per macrocell scans its `MACRO³` voxels and writes the max `.a` → occupancy texel. GPU-resident, no readback. Cheap one-time after each generation.
- **Raymarch skip** (`raymarch.wgsl`): bind the occupancy + a NEAREST sampler. Per ray position, sample the macrocell's max-density; if `< SKIP_THRESHOLD` (empty), **advance the ray to that macrocell's far boundary** (`intersectAABB` against the macrocell box, in volume space) instead of a fine `dt` step; else fine-step and composite as today. (Port v2's macrocell-skip from `src/shaders/preview/raymarch.frag.glsl`'s sparse path — the AABB-to-macrocell-far-edge jump.)
- **Coverage:** occupancy is built for the **live volume** (after `generate`) and **per cached frame** (in `FrameCache::bake`). The raymarch always has an occupancy bound alongside whichever volume it samples (live or a cached frame).

## Part 2 — Reduced-resolution playback bake

- **`playback_bake_res(source_res, n, budget) -> u32`**: the largest `bake_res ≤ source_res` (stepping down the valid set {64,128,192,256}, or by a step) such that `n × bake_res³ × 4 ≤ FRAME_CACHE_BUDGET_BYTES` — so the **full requested N-frame loop always fits**. Floor at 64. (v3 analog of v2's `bakePlaybackResolution`.)
- **`FrameCache::bake` bakes at `bake_res`** (not `source res`): allocate N `bake_res³` textures, `generate_into` each at `anim_phase = i/n` at `bake_res`, and build each frame's occupancy at `bake_res`. Smaller frames → full loop fits + faster raymarch.
- **Playback** binds the reduced-res frame + its occupancy. The raymarch is resolution-agnostic (samples normalized `[0,1]³`), so a smaller frame just looks slightly softer during motion.
- **Snap to full-res on pause/idle:** when playback stops (playing→false), regenerate the **full-res live volume at the current phase** (a brief one-time full-res generation, `anim_phase = phase`) so the paused frame is crisp. Reuses the live generate path; empty-space skipping keeps even the full-res paused raymarch fast.

## Interaction with existing code

- Reuses cycle-④'s `VolumeGen`/`generate_into`, `FrameCache`, the animation state + playback binding, and the raymarch embed. New: `occupancy.wgsl` + occupancy textures (live + per-frame); `raymarch.wgsl` gains the occupancy binding + skip loop; the raymarch bind group grows an occupancy view + sampler; `FrameCache::bake` takes a `bake_res` and builds per-frame occupancy; a `playback_bake_res` helper + a pause→full-res-regen.
- wgpu 29 / egui 0.35, all under `v3/`, native + WebGPU, **zero CPU readback** throughout.

## Scope

**In:** occupancy overlay (macrocell max-density) + build compute pass (live + per-frame); raymarch macrocell empty-space skip; reduced-resolution playback bake (`playback_bake_res` + `FrameCache` bakes at `bake_res` + per-frame occupancy); snap-to-full-res on pause.
**Deferred:** lower-res *screen* raymarch (render-proxy) as a further lever if dense-filling volumes still lag; temporal interpolation; a true sparse brick atlas (this keeps the dense volume + an occupancy overlay, which is simpler and sufficient); adaptive step count.

## Testing

- **Unit (Rust, in-sandbox):** `macro_dims(res, MACRO)`; `playback_bake_res(source, n, budget)` (returns ≤ source, full loop fits, floor 64, monotonic); occupancy texture sizing.
- **Shader:** `naga` validates `occupancy.wgsl` + the skip-augmented `raymarch.wgsl`.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** 256³ playback + scrub are now smooth (report fps vs the 1-2 fps baseline); the full requested loop bakes (not clamped to 8); paused frame is crisp full-res; empty-space skipping visibly speeds sparse scenes; no visual corruption (skip must not clip visible volume — threshold correct).

## Success criteria

- 256³ playback + scrub go from ~1-2 fps to smooth (measured), memory-efficient (full loop fits via reduced-res bake), crisp on pause; empty-space skipping speeds live + paused full-res too.
- Occupancy build + raymarch skip + reduced-res bake all zero-readback, GPU-resident; both `cargo check` + naga + clippy + unit tests green.
- No regression to generation, per-layer color, or the animation/cache correctness from cycle ④.

## Risks

- **Skip threshold / clipping:** too high a `SKIP_THRESHOLD` clips faint smoke (visible artifact); too low skips nothing. Tune conservatively (skip only genuinely-empty macrocells); the user's GPU run confirms no clipping.
- **Occupancy build cost:** one invocation scanning `MACRO³=512` voxels per macrocell — verify it's cheap relative to generation (it is, one-time); if not, a mip-reduction is the upgrade.
- **Per-frame occupancy memory:** N × macro³ × 1 byte — negligible (32³ = 32 KB × N).
- **Reduced-res softness during motion** — acceptable (crisp on pause); `playback_bake_res` cap keeps it reasonable.
- **wgpu-29 3D storage/texture bindings** for occupancy — reconcile via `cargo check` (same as cycle ②/④).

## Deferred / future

Lower-res screen raymarch (render proxy); adaptive steps; temporal interpolation; true sparse brick atlas; per-adapter VRAM budget query.
