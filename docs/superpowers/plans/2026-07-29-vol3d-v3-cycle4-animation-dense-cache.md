# Vol3D v3 — Cycle ④ Animation + Dense GPU Frame Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Loop animation + a GPU-resident dense frame cache: bake N loop frames on the GPU via the existing generation compute (zero CPU readback), play back by binding the current frame's 3D texture for the unchanged raymarch. Plus wire the deferred `animatedDomainOffset` so noise evolves over the loop.

**Architecture:** `GenParams` repacked to carry `anim_phase`+`anim_evolutions`; `generate.wgsl` gains `animatedDomainOffset` (non-SDF). A `FrameCache` = N `rgba8unorm` 3D textures; bake runs the existing compute into each at `phase=i/N`; playback binds `frames[frame_for_phase(phase,N)]` as the raymarch volume. egui animation controls + a phase clock drive it. Sparse packing deferred.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe`/`egui-wgpu =0.35.0`, `bytemuck`, `naga`. All under `v3/`.

**Spec:** `docs/superpowers/specs/2026-07-29-vol3d-v3-cycle4-animation-dense-cache-design.md`.

## Global Constraints

- All under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates both shaders.
- No GPU in sandbox: gates are compile + tests + naga; playback/animation visual is the user's GPU run (final task).
- `GenParams` must stay byte-matched Rust `#[repr(C)]` ↔ WGSL, 16 bytes (a size test enforces it).
- Reuse cycle-②'s generation compute + cycle-③ UI + the raymarch embed; the raymarch **shader** is unchanged.
- Port `animatedDomainOffset`/`hash11` from the authoritative v2 GLSL (named in T2) — don't invent.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  anim.rs         # NEW: pure helpers — advance_phase, frame_for_phase, max_frames, cache key/is_stale (+ tests)
  layer.rs        # MOD: GenParams repack (drop global_seed, add anim_evolutions) + size test
  render/
    frame_cache.rs # NEW: FrameCache (N 3D textures) + bake(via existing compute) + current-frame view
    volume.rs / mod.rs # MOD: expose generation for a given anim_phase into an arbitrary target texture; hold FrameCache
  app.rs          # MOD: animation state (playing/phase/loop_seconds/evolutions/n/stale) + Animation UI + phase clock + playback bind
shaders/
  generate.wgsl   # MOD: animatedDomainOffset (non-SDF) + GenParams struct repack
```

---

## Task 1: Pure animation helpers + `GenParams` repack + tests

**Files:** Create `v3/src/anim.rs`; modify `v3/src/layer.rs` (GenParams), `v3/src/main.rs` (`mod anim;`).

**Interfaces produced:**
- `fn advance_phase(phase: f32, dt: f32, loop_seconds: f32) -> f32` — `if loop_seconds <= 0 { return phase } ((phase + dt/loop_seconds) % 1 + 1) % 1`.
- `fn frame_for_phase(phase: f32, n: u32) -> usize` — `n==0 -> 0`; else `((phase.rem_euclid(1.0) * n as f32).round() as usize) % n as usize`.
- `fn max_frames(res: u32, budget_bytes: u64) -> u32` — `bytes_per_frame = res³*4`; `max(1, budget/bytes_per_frame)` clamped to a sane cap (e.g. 64).
- `struct BakeKey { … }` (or a `u64`/string) capturing bake inputs (layers signature, res, evolutions, n) + `fn is_stale(baked: &Option<BakeKey>, current: &BakeKey) -> bool`.
- Repacked `GenParams { res: u32, layer_count: u32, anim_phase: f32, anim_evolutions: f32 }` (drop `global_seed`).

- [ ] **Step 1: Repack `GenParams` + fix its size test**

In `layer.rs`, change `GenParams` to `{ res: u32, layer_count: u32, anim_phase: f32, anim_evolutions: f32 }` (16 bytes). Update the size test (`gen_params_is_16_bytes` or similar) — still 16. Update every construction site (`app.rs`/`volume.rs` set `anim_phase`/`anim_evolutions` instead of `global_seed`; `global_seed` stays folded into each layer's `seed` at pack time — that code is unchanged). `cargo check` will flag all sites; fix them.

- [ ] **Step 2: Failing tests for the helpers** (in `anim.rs`)

```rust
#[test] fn advance_phase_wraps() {
    assert!((advance_phase(0.9, 0.2, 1.0) - 0.1).abs() < 1e-5);   // 0.9+0.2 -> 0.1
    assert_eq!(advance_phase(0.5, 1.0, 0.0), 0.5);                 // loop_seconds 0 = frozen
}
#[test] fn frame_for_phase_nearest_wraps() {
    assert_eq!(frame_for_phase(0.0, 8), 0);
    assert_eq!(frame_for_phase(0.99, 8), 0);   // rounds to 8 -> wraps to 0
    assert_eq!(frame_for_phase(0.5, 8), 4);
    assert_eq!(frame_for_phase(0.3, 1), 0);
}
#[test] fn max_frames_dense_budget() {
    // 128^3*4 = 8_388_608 bytes/frame; 256MB budget -> 32; never 0
    assert_eq!(max_frames(128, 256*1024*1024), 32);
    assert!(max_frames(512, 8*1024*1024) >= 1);   // floor at 1 even if over budget
}
#[test] fn is_stale_detects_edits() {
    let a = BakeKey::new(/* layers, res=128, evo=1, n=8 */);
    let b = a.clone();
    assert!(!is_stale(&Some(a.clone()), &b));
    let c = BakeKey::new(/* same but res=256 */);
    assert!(is_stale(&Some(a), &c));
    assert!(is_stale(&None, &c));  // never baked = stale
}
```
Run → FAIL.

- [ ] **Step 3: Implement `anim.rs`** — the four helpers + `BakeKey`/`is_stale`. `BakeKey` can hash the packed-layer bytes + (res, evolutions, n) into a `u64` (reuse a simple FNV over `bytemuck::cast_slice(&packed_layers)` + the scalars), or derive `PartialEq` over a small struct. Run → PASS.

- [ ] **Step 4: gate + commit**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): cycle-4 anim helpers (phase/frame/max_frames/bake-key) + GenParams repack (+anim_evolutions) + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `animatedDomainOffset` in `generate.wgsl` + `GenParams` WGSL repack

**Files:** Modify `v3/shaders/generate.wgsl`.

**Interfaces:** consumes the repacked `GenParams` (Task 1). Produces evolving noise for non-SDF layers.

- [ ] **Step 1: Repack the WGSL `GenParams`** to `{ res: u32, layer_count: u32, anim_phase: f32, anim_evolutions: f32 }` (mirror Task 1; drop `global_seed`, add `anim_evolutions`). Fix any reference to `params.global_seed` in the shader (there should be none — it was unread; confirm).

- [ ] **Step 2: Port `hash11` + `animatedDomainOffset`** (from v2 `src/shaders/common/hash.glsl` `hash11` and `src/shaders/generation/layer_gen.frag.glsl:27-42`). WGSL:

```wgsl
const TAU: f32 = 6.28318530718;
const ANIM_RADIUS: f32 = 4.0;

fn hash11(p: f32) -> f32 { /* verbatim port of v2 hash.glsl hash11 */ }

fn animated_domain_offset(seed: f32, anim_phase: f32, anim_evolutions: f32) -> vec3<f32> {
  let angle = anim_phase * anim_evolutions * TAU;
  let axis_a = normalize(vec3<f32>(
    hash11(seed*0.031 + 21.0)*2.0 - 1.0,
    hash11(seed*0.037 + 22.0)*2.0 - 1.0,
    hash11(seed*0.041 + 23.0)*2.0 - 1.0));
  let axis_b = normalize(vec3<f32>(
    hash11(seed*0.043 + 24.0)*2.0 - 1.0,
    hash11(seed*0.047 + 25.0)*2.0 - 1.0,
    hash11(seed*0.053 + 26.0)*2.0 - 1.0));
  return (axis_a*cos(angle) + axis_b*sin(angle)) * ANIM_RADIUS;
}
```
(Read v2's real `hash11` and reproduce it exactly.)

- [ ] **Step 3: Apply it in the non-SDF transform branch** of `sample_noise_at` — after the rotate, before `eval_noise`, for non-SDF only (replace the `// TODO(cycle-4): animatedDomainOffset` marker left in cycle ②):

```wgsl
// non-SDF branch:
var p = uvw * L.scale.xyz + L.offset.xyz;
p = rot * p;
p = p + animated_domain_offset(L.seed, params.anim_phase, params.anim_evolutions);
```
SDF branch unchanged (no offset). `L.seed` already includes global_seed (folded at pack time).

- [ ] **Step 4: gate**

```bash
source "$HOME/.cargo/env" && cd v3
naga shaders/generate.wgsl        # Validation successful
cargo check && cargo check --target wasm32-unknown-unknown
```

- [ ] **Step 5: commit**

```bash
git add v3 && git commit -m "feat(v3): wire animatedDomainOffset (evolving noise) + GenParams WGSL repack

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Dense GPU `FrameCache` (bake via existing compute, no readback)

**Files:** Create `v3/src/render/frame_cache.rs`; modify `v3/src/render/volume.rs` + `mod.rs` (`mod frame_cache;`, generation reusable for a target + phase), `v3/src/main.rs` if needed.

**Interfaces:** Produces `FrameCache { frames: Vec<wgpu::Texture>, views: Vec<wgpu::TextureView>, res: u32, n: u32 }` with:
- `FrameCache::bake(&mut self, device, queue, gen: &mut VolumeGen, layers: &[GpuLayer], base_params: GenParams, res, n, anim_evolutions, lut_atlas, lut_rows)` — (re)allocates N `rgba8unorm` D3 textures at `res`; for `i in 0..n` sets `params.anim_phase = i as f32 / n as f32` and runs the generation compute **into `frames[i]`** (GPU-resident; no readback).
- `FrameCache::view_for_phase(&self, phase: f32) -> &wgpu::TextureView` (uses `frame_for_phase`).
- `FrameCache::is_empty()`.

To bake into an arbitrary target texture, `VolumeGen::generate` (cycle ②) currently writes its own internal volume. Refactor minimally so the compute can target a supplied `&wgpu::TextureView` (add a `generate_into(device, queue, target_view, res, layers, params, lut_atlas, lut_rows)` that rebuilds the compute bind group against `target_view`; the existing `generate` becomes `generate_into(self.view, …)`). Keep the storage-buffer/LUT/GenParams upload path identical. No readback anywhere.

- [ ] **Step 1: `generate_into` refactor** in `volume.rs` — extract the target texture view as a parameter; existing `generate` calls it with the live volume view. `cargo check` green; no behavior change to the live path.
- [ ] **Step 2: `FrameCache`** in `frame_cache.rs` — allocate N textures (guard `n = min(n, max_frames(res, BUDGET))`); `bake` loops `generate_into(frames[i].view, …, params{anim_phase:i/n})`; `view_for_phase`. Log the clamped N + total VRAM.
- [ ] **Step 3: hold it** — `Renderer` (mod.rs) owns a `FrameCache` + a `baked: Option<BakeKey>`; expose `ensure_baked(...)` (bake if `is_stale`) and `bound_view_for_playback(phase)`. (Actual play/pause decisions live in app.rs Task 4; this task just provides the cache + bake API and keeps everything compiling with the live path unchanged.)
- [ ] **Step 4: gate**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
```
- [ ] **Step 5: commit**
```bash
git add v3 && git commit -m "feat(v3): dense GPU FrameCache — bake N frames via existing compute (zero readback) + generate_into refactor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Animation UI + phase clock + playback wiring

**Files:** Modify `v3/src/app.rs` (+ the raymarch callback in `render/raymarch.rs` to bind a playback frame view when playing).

**Interfaces:** consumes `anim` helpers (T1), `FrameCache`/`ensure_baked`/`view_for_playback` (T3). Produces the Animation UI + the play/scrub state machine.

- [ ] **Step 1: Animation state** on `Vol3dApp`: `playing: bool`, `phase: f32`, `loop_seconds: f32` (default 4.0), `evolutions: f32` (default 1.0), `frame_count: u32` (default 24), `cache_stale: bool` (any layer/settings/res/evolutions/frame_count edit → true; reuse `mark_dirty` sites + set `cache_stale`).
- [ ] **Step 2: Animation UI** (a section/panel): Play/Pause toggle; `loop_seconds`, `evolutions`, `frame_count` `DragValue`s; a phase scrub `Slider` (0..1). Editing loop/evolutions/frame_count sets `cache_stale=true`. Show a small "cache: baked N @res / stale" line.
- [ ] **Step 3: Phase clock + playback** in `update()`:
  - If `playing`: `let dt = ui.ctx().input(|i| i.stable_dt); self.phase = advance_phase(self.phase, dt, self.loop_seconds);` and keep `request_repaint()` (the fps counter already forces continuous repaint — good).
  - Playback path: when `playing` (and a valid non-stale cache exists), in the raymarch callback bind `frame_cache.view_for_phase(self.phase)` as the volume instead of the live volume. Thread a `playback_view: Option<the frame index/phase>` into the `RaymarchCallback` (like cycle ②/③ threaded regen state) so `prepare`/`paint` binds the cached frame's bind group. When NOT playing, the existing live-volume path is used unchanged.
  - On Play press (or first playing frame with a stale cache): call `renderer.ensure_baked(...)` (bake N frames) before binding — a brief pause; set `cache_stale=false` after. Edits while playing set `cache_stale=true` → re-bake on the next tick (simplest: re-bake when stale at the top of a playing frame).
  - Phase scrub while paused: set `self.phase`; if a valid cache exists bind that frame, else fall back to a live regen at that phase (mark dirty).
- [ ] **Step 4: gate**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
```
- [ ] **Step 5: commit**
```bash
git add v3 && git commit -m "feat(v3): animation controls + phase clock + dense-cache playback (bake on play, bind cached frame)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1:** Update `RUN.md` for cycle ④: the app now animates — Animation controls (Play/Pause, loop seconds, evolutions, frame count, phase scrub). Document: does the noise visibly EVOLVE over the loop (animatedDomainOffset); does Play bake then play SMOOTHLY (watch the fps/ms counter — steady high fps during playback, no per-frame regen stutter); does scrubbing work; does editing a layer invalidate + re-bake; memory OK at 128³ (note 256³ is dense-heavy → the deferred sparse cache). Report FPS during playback at 128³ vs the live-edit regen. Note deferred: GPU sparse cache (256³+), reduced-res bake, interpolation.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): cycle-4 run/verify instructions (animation + dense cache)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** animatedDomainOffset wiring + GenParams repack (T1 S1, T2) ✓; anim controls UI + phase clock (T4 S1-3) ✓; dense GPU FrameCache bake-via-existing-compute + no readback (T3) ✓; playback binds current frame, raymarch shader unchanged (T3 view_for_phase, T4 S3) ✓; invalidate-on-edit (T1 BakeKey/is_stale, T4 cache_stale) ✓; max_frames memory clamp (T1, T3 S2) ✓; unit tests (T1) ✓; user GPU run (T5) ✓; deferred sparse/interp/reduced-res absent ✓.

**Placeholder scan:** helper tests + signatures + the animatedDomainOffset WGSL + GenParams repack are concrete; the FrameCache/generate_into refactor + playback binding give exact structure with `cargo check`/`naga` as gates; the hash11 body is "port verbatim from v2 hash.glsl" (authoritative) — appropriate, not a placeholder.

**Type consistency:** `GenParams {res,layer_count,anim_phase,anim_evolutions}` repack is identical in T1 (Rust) and T2 (WGSL) + the 16-byte test; `advance_phase`/`frame_for_phase`/`max_frames`/`BakeKey`/`is_stale` defined in T1, used in T3/T4; `FrameCache`/`bake`/`view_for_phase`/`generate_into` defined in T3 and consumed in T4; animation fields (`playing/phase/loop_seconds/evolutions/frame_count/cache_stale`) introduced in T4 consistently. `L.seed` (folded global_seed) feeds `animated_domain_offset` per T2.
