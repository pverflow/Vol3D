# Vol3D v3 — Non-Cubic Volume Box (per-axis dimensions) — Design

**Date:** 2026-08-02
**Status:** Approved (user: set the simulation box per-axis, custom powers of 2, e.g. 64×64×256 for tall flames; true proportions — taller box, cubic voxels).
**Parent:** replaces the single cubic `resolution` throughout v3's generation / occupancy / raymarch / fps-cache.

## Goal

Let the user set the volume box as **three independent power-of-2 dimensions** (X / Y / Z) instead of one cubic resolution. A 64×64×256 box renders **4× taller than wide** with **cubic voxels** (true proportions): an SDF sphere stays a sphere, and the taller box shows *more vertical extent* of the noise field (consistent cell size) — real room for a tall flame. Per-layer Scale still stretches deliberately. Default `[128,128,128]` is byte-identical to today's cubic 128.

## Core concept: aspect

`aspect = dims / max(dims)` (f32 vec3). `[64,64,256] → [0.25,0.25,1.0]`; `[128,128,128] → [1,1,1]` (identity → no change vs today). Aspect is the single quantity that makes the box non-cubic in both **generation** (sample position) and **rendering** (box extent), keeping voxels cubic.

## Changes by subsystem

### 1. Dims + GenParams + volume texture (`layer.rs`, `render/volume.rs`, `generate.wgsl`)
- `Vol3dApp.resolution: u32` → `dims: [u32;3]` (default `[128,128,128]`).
- `GenParams` (currently `{res, layer_count, anim_phase, anim_evolutions}`, 16 B) → carries `dims: [u32;3]` + `aspect: [f32;3]` (+ existing scalars + padding). WGSL mirrors.
- `VolumeGen` stores `dims: [u32;3]`; the volume 3D texture is `Extent3d { width:dims[0], height:dims[1], depth_or_array_layers:dims[2] }`. `res()` → `dims()`.
- `generate.wgsl`: dispatch per-axis (`workgroups = ceil(dims / wg)`); `if any(global_id >= dims) { return; }`; `uvw = (vec3<f32>(global_id) + 0.5) / vec3<f32>(dims)`.
- **Aspect-corrected sample position (proportions):** in `sample_noise_at`, the uvw-derived base position is multiplied by `aspect` before scale/offset — non-SDF `p = (uvw * aspect) * scale + offset`; SDF `p = ((uvw - 0.5) * aspect) * scale + offset`. At `aspect=[1,1,1]` this is identical to today. Tiling blend stays in uvw space (period 1); aspect is applied per-sample so seams stay seamless at box boundaries. Distortion/anim-offset operate on the aspect-corrected `p` unchanged.

### 2. Occupancy per-axis (`occupancy.wgsl`, `render/occupancy.rs`, `anim.rs`)
- Occupancy 3D texture dims = `[macro_dims(dims[0]), macro_dims(dims[1]), macro_dims(dims[2])]` (`macro_dims(n)=ceil(n/MACRO)`, MACRO=8 unchanged).
- `OccParams` carries the volume `dims` + per-axis macro dims. `occupancy.wgsl` dispatches per macrocell (per-axis), scans `MACRO³` voxels bounded by `dims`.

### 3. Raymarch aspect box + per-axis skip (`raymarch.wgsl`, `camera.rs`, `render/raymarch.rs`)
- The march box is `[0, aspect]` (physical), center `aspect*0.5`; ray/box intersect against `[0, aspect]`; texture sample `uvw = pos / aspect`. At `aspect=[1,1,1]` this is the current unit-cube march exactly.
- **`CamUniform`** gains `box_aspect: vec3` and turns the scalar `macro_dim` into per-axis `macro_dims: vec3` (the skip grid). Lay out std140-compatibly; **update the CamUniform size test** to the new size.
- Occupancy empty-space skip generalizes to `vec3` macro dims + aspect: `occ_uvw = (floor(uvw*md)+0.5)/md`; the AABB jump to the macrocell far edge uses per-axis `md` and `aspect`. Camera framing orbits the box center (`aspect*0.5`); max axis is 1.0 so distance/FOV framing is unchanged from today.

### 4. fps frame-cache per-axis (`render/frame_cache.rs`, `anim.rs`)
- `bake_res: u32` → `bake_dims: [u32;3]`. New `playback_bake_dims(source_dims, n, budget) -> [u32;3]` = source_dims scaled down by a single power-of-two factor (aspect preserved) so `n × product(bake_dims) × 4 ≤ budget`; floor each axis at 32. Frame + occupancy textures allocated at `bake_dims`.
- `BakeKey.res: u32` → `dims: [u32;3]`.
- Frame-count clamp (`max_loop_frames`) recomputed from the **floor** bake size (per-axis floor 32) so the loop still can't exceed the 4 GB budget.

### 5. UI (`app.rs`)
- Replace the cubic resolution dropdown with **three power-of-2 selectors** (X / Y / Z, each from `{32,64,128,256,512}`). Any change → `cache_stale = true` + `mark_dirty` (re-bake + regen). Live **VRAM readout**: `box {x}×{y}×{z} — {MB}/frame` (`product×4`), plus the existing baked-cache readout (now per-axis).
- `dims` are a structural/bake input — **not keyframable**.

## Scope

**In:** per-axis `dims` end-to-end (generation with aspect, occupancy, raymarch box + skip, fps-cache, BakeKey), 3 pow2 UI selectors + VRAM readout.
**Out:** fully arbitrary (non-pow2) dims; separate resolution-vs-box-size controls (dims are both); animating dims; auto-fit camera zoom to very tall boxes (framing stays as today).

## Testing

- **Unit (Rust):** `aspect` from dims (`[128;3]→[1;3]`, `[64,64,256]→[0.25,0.25,1.0]`); `playback_bake_dims` (fits budget, preserves aspect ratio, floors 32, `≤ source`); `macro_dims` per axis; `GenParams`/`CamUniform` layout + size tests updated; `BakeKey` dims-sensitive.
- **Shader:** `naga` validates generate/occupancy/raymarch with the new params.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** `[128,128,128]` looks identical to today; `[64,64,256]` renders a 4× taller box with an undistorted sphere and more vertical noise; the box bakes + plays (cache reduces per-axis to fit); occupancy skip has no holes on non-cubic boxes; VRAM readout sane.

## Success criteria

- Per-axis pow2 dims set the box shape (true proportions, cubic voxels); `[128,128,128]` byte-identical to the prior cubic 128; occupancy skip + fps-cache + raymarch all work on non-cubic boxes; both `cargo check` + naga + clippy + tests green; no regression to layers/distortion/timeline/color.

## Risks

- **Aspect must reduce to identity** at `[1,1,1]` in generation AND raymarch — reviewer verifies cubic 128 is byte-identical.
- **CamUniform / GenParams layout** growth — std140/std430 alignment; layout + size tests guard; naga validates.
- **Occupancy skip on non-cubic** — per-axis `md` + aspect in the AABB jump; a mistake = holes/clipping on tall boxes (visible; GPU run confirms).
- **VRAM** — a 512×512×512 live volume is 512 MB; the fps-cache auto-reduces per-axis, and the readout + N-clamp keep the loop within 4 GB. Very large boxes are the user's call (readout shows the cost).
