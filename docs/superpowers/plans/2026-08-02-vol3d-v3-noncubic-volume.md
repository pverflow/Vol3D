# Vol3D v3 — Non-Cubic Volume Box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Replace the single cubic `resolution` with per-axis power-of-2 `dims: [u32;3]` end-to-end (generation with aspect, occupancy, raymarch box + skip, fps-cache), so a 64×64×256 box renders 4× taller than wide with cubic voxels (true proportions).

**Architecture:** One quantity — `aspect = dims / max(dims)` — makes the box non-cubic in generation (sample position ×aspect) and rendering (march box `[0, aspect]`), keeping voxels cubic. Default `[128,128,128]` → `aspect=[1,1,1]` → byte-identical to today. Each task keeps cubic-128 working; non-cubic becomes reachable only at the UI task (last before docs), by which point generation/raymarch/cache all handle it.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-noncubic-volume-design.md`.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates every touched shader.
- **`dims=[128,128,128]` MUST be byte-identical to today's cubic 128** (aspect `[1,1,1]` reduces every formula to the current one). Reviewer verifies.
- Layout/size tests updated for any GenParams/CamUniform/OccParams change; std140/std430 alignment respected (use scalar fields to avoid vec3 padding surprises); naga guards the WGSL side.
- No change to layers/blend/distortion/noise/SDF/color/timeline math. Zero readback. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/anim.rs             # MOD: aspect_from_dims; playback_bake_dims; BakeKey dims; macro_dims stays
v3/src/layer.rs            # MOD: GenParams -> dims + aspect (48B)
v3/src/render/volume.rs    # MOD: VolumeGen dims; per-axis textures; generate/generate_into take dims; dims()
v3/shaders/generate.wgsl   # MOD: GenParams mirror; per-axis dispatch bounds + uvw; aspect sample position
v3/src/render/occupancy.rs # MOD: OccParams per-axis; make_occupancy_texture(dims); build(dims)
v3/shaders/occupancy.wgsl  # MOD: per-axis params + bounds
v3/src/camera.rs           # MOD: CamUniform macro_dim->macro_dims[3] + box_aspect[3]; size test
v3/shaders/raymarch.wgsl   # MOD: Cam mirror; march box [0,aspect]; uvw=pos/aspect; per-axis skip
v3/src/render/raymarch.rs  # MOD: prepare derives macro_dims+box_aspect from bound dims
v3/src/render/frame_cache.rs # MOD: bake_dims; playback_bake_dims; make_frame(dims); bake(source_dims)
v3/src/render/mod.rs       # MOD: thread dims through ensure_generated/ensure_baked/bind
v3/src/app.rs              # MOD: dims:[u32;3]; 3 pow2 selectors + VRAM readout; thread dims
v3/RUN.md                  # MOD (Task 5)
```

---

## Task 1: Generation + occupancy at per-axis dims

**Files:** `v3/src/anim.rs`, `v3/src/layer.rs`, `v3/src/render/volume.rs`, `v3/shaders/generate.wgsl`, `v3/src/render/occupancy.rs`, `v3/shaders/occupancy.wgsl`, and the callers in `v3/src/render/mod.rs`/`app.rs`/`frame_cache.rs` (pass cubic dims for now).

**Interfaces produced:**
- `anim::aspect_from_dims(dims: [u32;3]) -> [f32;3]` = `let m = dims.iter().copied().max().unwrap().max(1) as f32; [dims[0] as f32/m, dims[1] as f32/m, dims[2] as f32/m]`.
- `GenParams` (scalar fields, 48 B): `dim_x, dim_y, dim_z, layer_count: u32; aspect_x, aspect_y, aspect_z, anim_phase: f32; anim_evolutions, _pad0, _pad1, _pad2: f32`.
- `VolumeGen`: `dims: [u32;3]`; `pub fn new(device, dims: [u32;3])`; `generate(..., dims: [u32;3], ...)`; `generate_into(..., dims: [u32;3], ...)`; `pub fn dims(&self) -> [u32;3]`; `make_volume_texture(device, dims)`.
- `occupancy::make_occupancy_texture(device, dims: [u32;3]) -> (Texture, View)` (extent `[macro_dims(dims[0]), macro_dims(dims[1]), macro_dims(dims[2])]`); `OccupancyBuilder::build(..., dims: [u32;3])`.

- [ ] **Step 1: `aspect_from_dims` (TDD)** — add to `anim.rs` + test:
```rust
#[test] fn aspect_from_dims_cases() {
    assert_eq!(aspect_from_dims([128,128,128]), [1.0,1.0,1.0]);
    assert_eq!(aspect_from_dims([64,64,256]), [0.25,0.25,1.0]);
    assert_eq!(aspect_from_dims([0,0,0]), [0.0,0.0,0.0]); // max(1) guard, no NaN
}
```
Run → fail → implement → pass.
- [ ] **Step 2: `GenParams`** — change the struct in `layer.rs` to the 48 B scalar layout above; update any layout/size test (add one asserting `size_of::<GenParams>()==48`). Update `generate.wgsl`'s `struct GenParams` mirror (scalars, same order).
- [ ] **Step 3: `VolumeGen` dims** — `res: u32 → dims: [u32;3]` field; `new`/`generate`/`generate_into` take `dims: [u32;3]`; `make_volume_texture(device, dims)` → `Extent3d { width:dims[0], height:dims[1], depth_or_array_layers:dims[2] }`; `res()`→`dims()`. Build `GenParams` with `dim_*` and `aspect_* = aspect_from_dims(dims)`. Dispatch: `dispatch_workgroups(ceil(dims[0]/4), ceil(dims[1]/4), ceil(dims[2]/4))` (wg is 4×4×4). Pass `dims` to `make_occupancy_texture`/`build`.
- [ ] **Step 4: `generate.wgsl` bounds + uvw + aspect** — entry: `if (gid.x >= params.dim_x || gid.y >= params.dim_y || gid.z >= params.dim_z) { return; }`; `let uvw = (vec3<f32>(gid) + vec3<f32>(0.5)) / vec3<f32>(f32(params.dim_x), f32(params.dim_y), f32(params.dim_z));`. In `sample_noise_at`, multiply the uvw-derived base by aspect: non-SDF `p = (uvw * asp) * L.scale.xyz + L.offset.xyz;` SDF `p = ((uvw - 0.5) * asp) * L.scale.xyz + L.offset.xyz;` where `let asp = vec3<f32>(params.aspect_x, params.aspect_y, params.aspect_z);`. (At `asp=[1,1,1]` identical to today.) Tiling blend + distortion unchanged.
- [ ] **Step 5: occupancy per-axis** — `OccParams` → `[u32;8]` = `[dim_x, dim_y, dim_z, macro_x, macro_y, macro_z, 0, 0]` (macro_* = `macro_dims(dim_*)`). `make_occupancy_texture(device, dims)` extent `[macro_x, macro_y, macro_z]`. `build` dispatches `(macro_x, macro_y, macro_z)`. `occupancy.wgsl`: mirror `OccParams`; bound the inner voxel scan by `dim_*`; index the macrocell per-axis. (At cubic 128 → `[16,16,16]`, identical.)
- [ ] **Step 6: callers compile** — update `render/mod.rs`/`app.rs`/`frame_cache.rs` call sites to pass `dims`. For now, derive `dims` from the still-scalar `self.resolution` as `[r, r, r]` (a temporary `let dims = [self.resolution; 3];`), and `frame_cache` passes `[bake_res; 3]`. (Task 4 replaces `resolution` with a real `dims` field; Task 3 makes frame_cache per-axis.) The camera's scalar `macro_dim` still works at cubic (Task 2 makes it vec3).
- [ ] **Step 7: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && naga shaders/occupancy.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): per-axis volume dims in generation + occupancy (aspect-corrected; cubic-128 identical)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Raymarch aspect box + per-axis empty-space skip

**Files:** `v3/src/camera.rs`, `v3/shaders/raymarch.wgsl`, `v3/src/render/raymarch.rs`.

**Interfaces produced:**
- `CamUniform`: replace `macro_dim: f32` with `macro_dims: [f32;3]`; add `box_aspect: [f32;3]`; scalar layout after `frac`, size grows to the next 16-multiple; `basis()` leaves `macro_dims=[0,0,0]`, `box_aspect=[1,1,1]`. Update the `cam_uniform_size_matches_wgsl_std140_padding` test to the new size.

- [ ] **Step 1: `CamUniform`** — restructure the tail: `steps: f32`, then `macro_dims_x/y/z: f32`, `frac: f32`, `box_aspect_x/y/z: f32`, trailing pad to a 16-multiple (size ~112). Mirror in `raymarch.wgsl`'s `Cam` struct (line ~8). `basis()` sets `box_aspect=[1,1,1]`, `macro_dims=[0,0,0]`, `frac=0`. Update the size test.
- [ ] **Step 2: `raymarch.wgsl` aspect box** — `let asp = vec3<f32>(C.box_aspect_x, C.box_aspect_y, C.box_aspect_z);`; outer intersect `intersect_aabb(ro, rd, vec3<f32>(0.0), asp)` (was `vec3(1.0)`); per step, `let uvw = pos / asp;` and sample `vol`/`vol_b`/`occ`/`occ_b` at `uvw` (was `pos`). (At `asp=[1,1,1]`, `uvw==pos`, identical.)
- [ ] **Step 3: per-axis skip** — `let md = vec3<f32>(C.macro_dims_x, C.macro_dims_y, C.macro_dims_z);`; `let mc = floor(uvw * md);`; `let occ_uvw = (mc + vec3<f32>(0.5)) / md;`; the far-edge jump in physical space: `intersect_aabb(pos, rd, (mc / md) * asp, ((mc + vec3<f32>(1.0)) / md) * asp)`. (At cubic: `md` uniform, `asp=1`, identical to the current scalar path.)
- [ ] **Step 4: `raymarch.rs` prepare** — where `cam.macro_dim` is currently derived from the bound resolution (`volume.dims()` live / `frame_cache.bake_dims()` playback — use `dims()[/* the bound dims */]`): set `cam.macro_dims = [macro_dims(d[0]), macro_dims(d[1]), macro_dims(d[2])] as f32` and `cam.box_aspect = aspect_from_dims(d)` from the bound dims `d`. (Until Task 3 exposes `bake_dims()`, the playback branch may use `[frame_cache.bake_res(); 3]` — reconcile in Task 3.)
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): raymarch aspect box + per-axis occupancy skip (cubic identical)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: fps frame-cache per-axis

**Files:** `v3/src/anim.rs`, `v3/src/render/frame_cache.rs`, `v3/src/render/mod.rs`, `v3/src/render/raymarch.rs`, `v3/src/app.rs` (bake call).

**Interfaces produced:**
- `anim::playback_bake_dims(source_dims: [u32;3], n: u32, budget_bytes: u64) -> [u32;3]` — halve all three axes together (preserve aspect) from `source_dims` until `n × product × 4 ≤ budget`, flooring each axis at 32; never exceed `source_dims`.
- `anim::BakeKey`: `res: u32 → dims: [u32;3]`; `BakeKey::new(layers, dims, evolutions, n, timeline_hash)`.
- `FrameCache`: `bake_res → bake_dims: [u32;3]`; `bake_dims(&self) -> [u32;3]`; `bake(&mut self, device, queue, gen, source_dims: [u32;3], frames, base_params, lut, rows)`; `make_frame(device, dims)`.

- [ ] **Step 1: `playback_bake_dims` (TDD)** — 
```rust
#[test] fn playback_bake_dims_fits_and_keeps_aspect() {
    let b = 512*1024*1024;
    assert_eq!(playback_bake_dims([256,256,256], 8, b), [128,128,128]); // 8*128³*4=64MB
    assert_eq!(playback_bake_dims([64,64,256], 1, b), [64,64,256]);     // fits as-is
    let d = playback_bake_dims([256,256,256], u32::MAX, b);
    assert_eq!(d, [32,32,32]);                                          // floor 32
    let d = playback_bake_dims([64,64,256], 1000, b);
    assert_eq!(d[2]/d[0], 4);                                           // aspect ratio preserved
}
```
Halve all axes by the same power of two; floor 32. Run → fail → implement → pass.
- [ ] **Step 2: `BakeKey` dims (TDD)** — change field + `new`; update `is_stale_detects_edits`/timeline test to pass `[u32;3]`; add a case where only `dims` differs ⇒ stale.
- [ ] **Step 3: `FrameCache` bake_dims** — `bake` computes `let bake_dims = playback_bake_dims(source_dims, n, BUDGET);` allocates frame + occupancy textures at `bake_dims` (`make_frame(device, bake_dims)`, `make_occupancy_texture(device, bake_dims)`); `bake_dims()` getter; per-frame `generate_into(..., bake_dims, ...)`.
- [ ] **Step 4: wire callers** — `render/mod.rs` `ensure_baked`/bind pass `source_dims`; `raymarch.rs` prepare's playback branch uses `frame_cache.bake_dims()` (replace the `[bake_res;3]` stopgap from Task 2); `app.rs` bake call passes `self`'s dims (still `[resolution;3]` until Task 4) and builds `BakeKey::new(&frames[0], dims, evolutions, n, timeline.hash())`; the GB/readout math uses `product(bake_dims)`.
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): fps frame-cache per-axis bake dims (aspect-preserving reduction)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: UI — three power-of-2 dim selectors + VRAM readout

**Files:** `v3/src/app.rs`.

- [ ] **Step 1: `dims` field** — replace `pub resolution: u32` (default 128) with `pub dims: [u32;3]` (default `[128,128,128]`). Update every `self.resolution` use to the appropriate `self.dims` axis or `self.dims` (grep — generation passes `self.dims`; the `[resolution;3]` stopgaps from Tasks 1/3 become `self.dims`; BakeKey/GB readout use `self.dims`/`bake_dims`).
- [ ] **Step 2: UI selectors** — replace the cubic `{}³` dropdown with **three** `ComboBox`es (X / Y / Z), each offering `{32,64,128,256,512}` → `self.dims[0/1/2]`. On any change → `self.cache_stale = true; self.mark_dirty(ui.ctx());`. Label the row "Box (X/Y/Z)".
- [ ] **Step 3: VRAM readout** — under the selectors: `let mb = self.dims.iter().map(|&d| d as u64).product::<u64>() * 4 / (1<<20); ui.label(format!("box {}×{}×{} — {} MB/frame", self.dims[0], self.dims[1], self.dims[2], mb));`. Keep the existing baked-cache readout (now uses `bake_dims`/product).
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): per-axis box dimension selectors (pow2 X/Y/Z) + VRAM readout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document the **Box (X/Y/Z)** controls: set each axis to a power of 2 independently; the box renders with that aspect (e.g. 64×64×256 = 4× taller than wide) with cubic voxels — an SDF sphere stays a sphere, and a tall box gives room for a tall flame. Note the VRAM/frame readout + that the playback cache auto-reduces per-axis to fit. Ask the user to report: `[128,128,128]` looks identical to before; `[64,64,256]` renders a tall box with an undistorted sphere and more vertical noise; it bakes + plays; no occupancy holes on the tall box; readout sane.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): non-cubic volume box run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** dims + GenParams + volume texture + generate aspect (T1) ✓; occupancy per-axis (T1) ✓; raymarch aspect box + per-axis skip + CamUniform (T2) ✓; fps-cache per-axis + playback_bake_dims + BakeKey dims (T3) ✓; UI 3 pow2 selectors + VRAM readout (T4) ✓; cubic-128 identity (aspect=[1,1,1], every task) ✓; GPU run (T5) ✓.

**Placeholder scan:** every step has concrete code or exact edit targets; the temporary `[resolution;3]`/`[bake_res;3]` stopgaps (T1/T2) are explicitly replaced in T3/T4 — noted at each site, not left dangling.

**Type consistency:** `aspect_from_dims([u32;3])->[f32;3]` (T1) used in generate + `raymarch.rs` prepare (T2) + reduction; `GenParams` scalar dims/aspect (T1) mirrored in generate.wgsl; `CamUniform.macro_dims[3]`+`box_aspect[3]` (T2) mirrored in raymarch.wgsl + set from bound dims; `playback_bake_dims`/`bake_dims`/`BakeKey.dims` (T3) fed by `self.dims` (T4); `make_occupancy_texture(dims)`/`make_frame(dims)` per-axis throughout.
