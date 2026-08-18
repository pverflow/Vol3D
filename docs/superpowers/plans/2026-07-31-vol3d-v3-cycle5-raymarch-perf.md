# Vol3D v3 — Cycle ⑤ Raymarch Perf (empty-space skipping + reduced-res playback bake) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make 256³ interactive + playback fast + memory-efficient: (1) an occupancy overlay + raymarch macrocell empty-space skip, (2) reduced-resolution playback bake (full loop fits VRAM, smaller frames render faster; full-res crisp on pause).

**Architecture:** After each volume generation a compute pass fills a coarse `r8unorm` occupancy 3D texture (max density per `MACRO=8` macrocell). The raymarch samples it and jumps over empty macrocells. `FrameCache` bakes the loop at `playback_bake_res` (smaller volumes) + per-frame occupancy; pause regenerates the full-res live volume at the current phase.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero CPU readback.

**Spec:** `docs/superpowers/specs/2026-07-31-vol3d-v3-cycle5-raymarch-perf-design.md`.

## Global Constraints

- All under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates all shaders.
- No GPU in sandbox: gates are compile + tests + naga; perf/visual is the user's GPU run (final task).
- **Zero CPU readback.** Occupancy build + bake are GPU-resident (write/dispatch/submit only).
- Reuse cycle-④ `VolumeGen`/`generate_into`/`FrameCache`/animation. Don't change generation math or per-layer color.
- Port the raymarch macrocell-skip from v2 `src/shaders/preview/raymarch.frag.glsl` (the sparse-path AABB-to-macrocell-far-edge jump). `MACRO=8`, `SKIP_THRESHOLD` small (e.g. `2.0/255.0`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  anim.rs         # MOD: + macro_dims, + playback_bake_res (+ tests)
  render/
    occupancy.rs  # NEW: OccupancyBuilder (compute pipeline) + build(volume_view, occupancy_view, res); make_occupancy_texture
    volume.rs     # MOD: VolumeGen owns a live occupancy texture; generate_into builds it after the volume; occupancy_view()
    frame_cache.rs# MOD: bake at bake_res + a per-frame occupancy texture; view_for_phase + occupancy_for_phase
    raymarch.rs   # MOD: bind group + skip: occupancy view + NEAREST sampler bindings; rebuild binds (volume, occupancy) pair
    mod.rs        # MOD: bind_playback binds the frame's volume + occupancy; ensure_generated binds live volume + occupancy
  app.rs          # MOD: use playback_bake_res for the bake; snap-to-full-res regen at current phase on pause
shaders/
  occupancy.wgsl  # NEW: compute — max density per macrocell -> r8 occupancy 3D texture
  raymarch.wgsl   # MOD: occupancy binding + macrocell empty-space skip
```

---

## Task 1: Occupancy build (helpers + compute shader + live-volume occupancy)

**Files:** Modify `v3/src/anim.rs` (helpers), create `v3/shaders/occupancy.wgsl`, `v3/src/render/occupancy.rs`, modify `v3/src/render/volume.rs`, `render/mod.rs` (`mod occupancy;`).

**Interfaces produced:**
- `fn macro_dims(res: u32, macro_size: u32) -> u32` = `res.div_ceil(macro_size)`; `pub const MACRO: u32 = 8;`
- `fn playback_bake_res(source_res: u32, n: u32, budget_bytes: u64) -> u32` — largest `res ≤ source_res` from `[64,128,192,256]` (or step-down) with `n as u64 * (res as u64).pow(3) * 4 <= budget`; floor 64.
- `OccupancyBuilder::new(device) -> Self`; `OccupancyBuilder::build(&self, device, queue, volume_view: &TextureView, occupancy_view: &TextureView, res: u32)` — dispatch the occupancy compute; `make_occupancy_texture(device, res) -> (Texture, TextureView)` (`r8unorm`, D3, size `macro_dims(res,MACRO)³`, `STORAGE_BINDING|TEXTURE_BINDING`).
- `VolumeGen` gains `occupancy: wgpu::Texture` + `occupancy_view` (sized for its current res); `generate_into`/`generate` build occupancy after writing the volume; `occupancy_view() -> &TextureView`.

- [ ] **Step 1: helpers + tests (TDD)** in `anim.rs`:
```rust
pub const MACRO: u32 = 8;
pub fn macro_dims(res: u32, macro_size: u32) -> u32 { res.div_ceil(macro_size.max(1)).max(1) }
pub fn playback_bake_res(source_res: u32, n: u32, budget_bytes: u64) -> u32 {
    for res in [256u32, 192, 128, 64] {
        if res > source_res { continue; }
        if (n.max(1) as u64) * (res as u64).pow(3) * 4 <= budget_bytes { return res; }
    }
    64
}
```
Tests: `macro_dims(256,8)==32`, `macro_dims(128,8)==16`, `macro_dims(250,8)==32`; `playback_bake_res(256, 32, 512*1024*1024)` returns ≤256 and `32*res³*4 ≤ budget` (expect 128: 32×128³×4=256MB ≤512MB; 192→32×192³×4≈906MB>512 so not 192; so 128); `playback_bake_res` never > source, floors at 64. Run → FAIL → implement → PASS.

- [ ] **Step 2: `occupancy.wgsl`** — compute, one invocation per macrocell:
```wgsl
@group(0) @binding(0) var vol: texture_3d<f32>;
@group(0) @binding(1) var occ: texture_storage_3d<r8unorm, write>;
struct OccParams { res: u32, macro_dim: u32, _p0: u32, _p1: u32 };
@group(0) @binding(2) var<uniform> P: OccParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) mc: vec3<u32>) {
  if (mc.x >= P.macro_dim || mc.y >= P.macro_dim || mc.z >= P.macro_dim) { return; }
  let base = mc * 8u; // MACRO=8
  var m = 0.0;
  for (var z = 0u; z < 8u; z = z + 1u) {
    for (var y = 0u; y < 8u; y = y + 1u) {
      for (var x = 0u; x < 8u; x = x + 1u) {
        let v = base + vec3<u32>(x, y, z);
        if (v.x < P.res && v.y < P.res && v.z < P.res) {
          m = max(m, textureLoad(vol, vec3<i32>(v), 0).a);
        }
      }
    }
  }
  textureStore(occ, vec3<i32>(mc), vec4<f32>(m, 0.0, 0.0, 1.0));
}
```
`naga shaders/occupancy.wgsl` validates. (MACRO=8 hardcoded to match `MACRO` const — comment the coupling.)

- [ ] **Step 3: `occupancy.rs`** — `OccupancyBuilder` (bind-group layout: `@binding(0)` `texture_3d<f32>` volume [read via textureLoad — sample_type `Float{filterable:true}` or use a `Texture` binding], `@binding(1)` `StorageTexture{WriteOnly, R8Unorm, D3}`, `@binding(2)` uniform `OccParams`), pipeline from `occupancy.wgsl`, and `build(...)` that writes `OccParams{res, macro_dims(res,MACRO)}`, builds a bind group against (volume_view, occupancy_view), dispatches `macro_dims.div_ceil(4)³`, submits. `make_occupancy_texture`. Reconcile wgpu-29 names via `cargo check`. No readback.

- [ ] **Step 4: wire into `VolumeGen`** — add a live `occupancy` texture (recreated on res change alongside the volume) + an `OccupancyBuilder` (owned or passed from Renderer). At the end of `generate_into` (after the volume compute submit), call `occupancy_builder.build(device, queue, target_view, &self.occupancy_view, res)` so the live volume's occupancy is fresh. `occupancy_view()` accessor. (For the live path the target IS `self.view`; the `generate_into(frame_view, …)` path used by FrameCache builds occupancy into the FRAME's occupancy — handled in Task 3 by passing the frame's occupancy view. To keep Task-1 scope to the live volume, have `generate_into` take an optional `occupancy_view` param, `None` = skip; `generate` passes `Some(&self.occupancy_view)`. Task 3 passes the frame occupancy.)

- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/occupancy.wgsl && naga shaders/generate.wgsl && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): occupancy overlay — compute max-density-per-macrocell 3D texture + macro_dims/playback_bake_res helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Raymarch empty-space skip

**Files:** Modify `v3/shaders/raymarch.wgsl`, `v3/src/render/raymarch.rs` (bind group), `render/mod.rs` (rebuilds pass occupancy).

**Interfaces:** the raymarch bind group gains `@binding(3)` occupancy `texture_3d<f32>` + `@binding(4)` a NEAREST sampler + `@binding(5)` a small uniform carrying `macro_dim` (or fold into the existing Cam uniform as an extra field). `rebuild_bind_group(device, volume_view, occupancy_view)` binds both.

- [ ] **Step 1: `raymarch.wgsl` skip** — add the occupancy binding + `u_macro_dim` (as a Cam field or a new uniform). In the march loop, before the fine sample, compute the macrocell of `pos`, sample occupancy max-density; if `< SKIP_THRESHOLD`, advance `t` to the macrocell's far boundary via `intersectAABB(pos, rd, mcMin, mcMax)` (port v2 `raymarch.frag.glsl`'s sparse skip: `vec3 mc = floor(pos * macroDim); ... exitT = intersectAABB(...); t += max(dt, exitT.y + eps);`), then `continue`; else sample + composite as today. `SKIP_THRESHOLD = 2.0/255.0`. Keep the existing early-out (`trans < 0.01`) + step cap. Validate with `naga`.

- [ ] **Step 2: `raymarch.rs` bind group** — add binding entries 3 (occupancy `Texture{Float filterable:false}` D3), 4 (`Sampler(NonFiltering)` NEAREST clamp), 5 (uniform for `macro_dim`, if not folded into Cam). `make_bind_group`/`rebuild_bind_group` take `occupancy_view` and bind it + the occupancy sampler + write `macro_dim`. Reconcile wgpu-29 via `cargo check`.

- [ ] **Step 3: `mod.rs` rebuilds** — `ensure_generated` (dirty) rebuilds the bind group against `(&self.volume.view, self.volume.occupancy_view())`. `Renderer::new` builds the initial bind group with the live occupancy. (Playback binding of the frame occupancy is Task 3.)

- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && naga shaders/occupancy.wgsl && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): raymarch empty-space skipping via occupancy macrocells (live + paused)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Reduced-resolution playback bake + per-frame occupancy + pause snap

**Files:** Modify `v3/src/render/frame_cache.rs`, `render/mod.rs`, `v3/src/app.rs`.

**Interfaces:** `FrameCache` holds per-frame occupancy textures too; `bake(...)` takes `bake_res` (bakes volume + occupancy at `bake_res`); `view_for_phase`/`occupancy_for_phase`. `Renderer::bind_playback` binds the frame's volume + occupancy. `app.rs` computes `bake_res = playback_bake_res(resolution, frame_count, FRAME_CACHE_BUDGET_BYTES)` and, on pause, triggers a full-res live regen at the current phase.

- [ ] **Step 1: `FrameCache` bakes at `bake_res` + per-frame occupancy.** `bake(device, queue, gen, source_res, n_requested, layers, base_params, lut_atlas, lut_rows)`: compute `bake_res = playback_bake_res(source_res, n_requested, FRAME_CACHE_BUDGET_BYTES)` (the full N now fits → drop the old `max_frames` clamp, or keep as a hard cap safety net); allocate N `bake_res³` frame textures + N `macro_dims(bake_res,MACRO)³` occupancy textures; per frame `generate_into(device, queue, &frame_views[i], bake_res, layers, &p{anim_phase:i/n}, lut, rows, Some(&occ_views[i]))` (builds the frame occupancy too). Store `bake_res`, `n`. `view_for_phase`/`occupancy_for_phase(phase)` return the frame's views. Log `baked N @ bake_res³`.
- [ ] **Step 2: `Renderer::bind_playback`** — rebuild the raymarch bind group against `(frame_cache.view_for_phase(phase), frame_cache.occupancy_for_phase(phase))` (both, matching the frame's bake_res). None-safe.
- [ ] **Step 3: `app.rs` pause snap** — when `playing` transitions true→false (track `was_playing`), set the live volume's regen to the current phase: `mark_dirty` + ensure the live `GenParams.anim_phase = self.phase` for that regen (thread the phase into the live pack/gen so the paused full-res frame matches the phase you stopped on). While playing, `bake_res` comes from `playback_bake_res`; the reduced frames feed playback. (Keep the cycle-④ single-fire bake guard.)
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && naga shaders/occupancy.wgsl && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): reduced-resolution playback bake (full loop fits, smaller frames) + per-frame occupancy + pause snap to full res

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1:** Update `RUN.md`: 256³ playback + scrub should now be smooth (was 1-2 fps) via empty-space skipping + reduced-res playback bake; the full requested frame count bakes (no clamp to 8); paused frame snaps to crisp full-res. Ask the user to report: 256³ playback fps vs the 1-2 fps baseline; is the full loop baked; is pause crisp; does a sparse (fire/smoke) scene speed up a lot and a dense-filling scene less (expected); any visual clipping of faint smoke (skip threshold) — report so I can tune. Note deferred: lower-res screen raymarch, temporal interpolation, sparse brick atlas.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): cycle-5 run/verify (empty-space skipping + reduced-res playback bake)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** occupancy overlay + build compute (T1) ✓; raymarch macrocell skip (T2) ✓; reduced-res playback bake `playback_bake_res` + per-frame occupancy (T3 S1) ✓; playback binds reduced frame+occupancy (T3 S2) ✓; snap-to-full-res on pause (T3 S3) ✓; helpers unit-tested (T1 S1) ✓; zero readback (occupancy/bake are compute+submit only) ✓; user GPU run (T4) ✓; deferred (screen-proxy, interpolation, sparse atlas) absent ✓.

**Placeholder scan:** `occupancy.wgsl` + the helpers/tests are concrete; the raymarch skip is "port v2 `raymarch.frag.glsl` sparse skip" (authoritative) + the loop structure given; the Rust bind-group/occupancy wiring gives exact bindings with `cargo check`/`naga` as arbiter — appropriate, not hand-waving.

**Type consistency:** `MACRO`/`macro_dims`/`playback_bake_res` defined in T1 (anim.rs), used in T1/T2/T3; `OccupancyBuilder`/`make_occupancy_texture`/`build` defined T1 (occupancy.rs), used by VolumeGen (T1) + FrameCache (T3); `generate_into` gains an `Option<&TextureView> occupancy_view` param in T1, passed `Some(frame_occ)` in T3; raymarch bind group `(volume_view, occupancy_view)` pair consistent across `rebuild_bind_group` (T2) + `bind_playback` (T3); `occupancy_for_phase`/`view_for_phase` defined T3 and used in `bind_playback` T3.
