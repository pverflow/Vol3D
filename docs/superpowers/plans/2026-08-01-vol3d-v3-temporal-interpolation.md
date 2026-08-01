# Vol3D v3 — Temporal Interpolation (smooth playback) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Smooth playback at any loop length / frame count by lerping between the two adjacent baked frames (volume + occupancy union) by the phase fraction, instead of snapping to the nearest frame.

**Architecture:** During playback the raymarch binds TWO adjacent frames (`i`, `i+1`) + their occupancies + `frac`, and lerps per step. The LIVE/paused path binds the same volume twice with `frac=0` → identical to today (no separate shader path). Reuses cycle-④/⑤ `FrameCache` + occupancy skip; both frames share `bake_res`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback.

**Spec:** `docs/superpowers/specs/2026-08-01-vol3d-v3-temporal-interpolation-design.md`.

## Global Constraints

- All under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates all shaders.
- No GPU in sandbox: gates are compile + tests + naga; visual/smoothness is the user's GPU run (final task).
- **Zero readback.** **Live/paused single-volume behavior must be visually identical** (bind same volume twice + `frac=0`).
- CamUniform stays **80 bytes** (`frac` goes in the tail pad at byte 76; keep the size test).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  anim.rs          # MOD: + interp_frame(phase, n) -> (usize, usize, f32) (+ test)
  camera.rs        # MOD: CamUniform gains `frac: f32` in the tail pad (stays 80 bytes)
  render/
    frame_cache.rs # MOD: view_at(i)/occupancy_at(i)/frame_count getters (by index)
    raymarch.rs    # MOD: bind group + second volume (binding 5) + second occupancy (binding 6); rebuild takes (vol_a,occ_a,vol_b,occ_b); prepare sets frac
    mod.rs         # MOD: bind_playback binds the two adjacent frames; ensure_generated binds live twice (frac=0)
  app.rs           # MOD: pass phase to the callback as-is (renderer derives i,i1,frac) OR compute frac; set frac=0 when not playing
shaders/
  raymarch.wgsl    # MOD: bind vol_b + occ_b + Cam.frac; lerp both samples; occupancy skip on max(occ_a,occ_b)
```

---

## Task 1: `interp_frame` helper + FrameCache by-index getters

**Files:** Modify `v3/src/anim.rs` (+ test), `v3/src/render/frame_cache.rs`.

**Interfaces produced:**
- `fn interp_frame(phase: f32, n: u32) -> (usize, usize, f32)` — `let f = phase.rem_euclid(1.0) * n as f32; let i = (f.floor() as usize) % (n.max(1) as usize); let i1 = (i + 1) % (n.max(1) as usize); let frac = f - f.floor(); (i, i1, frac)`. `n==0` → `(0,0,0.0)`.
- `FrameCache::view_at(&self, i: usize) -> Option<&wgpu::TextureView>`, `occupancy_at(&self, i: usize) -> Option<&wgpu::TextureView>`, `frame_count(&self) -> u32` (exists — confirm), all bounds-safe.

- [ ] **Step 1: `interp_frame` + test (TDD)**
```rust
#[test] fn interp_frame_wraps_and_fractions() {
    assert_eq!(interp_frame(0.0, 8), (0, 1, 0.0));
    let (i, i1, f) = interp_frame(0.5, 8);       // f = 4.0
    assert_eq!((i, i1), (4, 5)); assert!(f.abs() < 1e-6);
    let (i, i1, f) = interp_frame(0.9375, 8);    // f = 7.5 -> i=7, i1=0 (wrap), frac=0.5
    assert_eq!((i, i1), (7, 0)); assert!((f - 0.5).abs() < 1e-5);
    assert_eq!(interp_frame(0.3, 1), (0, 0, /*frac*/ interp_frame(0.3,1).2)); // n==1 -> same frame, no panic
}
```
Run → FAIL → implement in `anim.rs` → PASS.

- [ ] **Step 2: FrameCache by-index getters** — `view_at(i)`/`occupancy_at(i)` (`self.views.get(i)` / `self.occ_views.get(i)`), `frame_count()`. Keep `view_for_phase`/`occupancy_for_phase` (or reimplement them via `interp_frame`'s `i`). No behavior change to bake.

- [ ] **Step 3: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): interp_frame(phase,n)->(i,i1,frac) helper + FrameCache by-index getters

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Dual-frame interpolation in the raymarch

**Files:** Modify `v3/shaders/raymarch.wgsl`, `v3/src/camera.rs` (CamUniform `frac`), `v3/src/render/raymarch.rs` (bind group), `render/mod.rs` (bind two frames / live-twice), `v3/src/app.rs` (frac plumbing).

**Interfaces:** `CamUniform` gains `frac: f32` at byte offset 76 (tail pad; struct stays 80). `rebuild_bind_group(device, vol_a, occ_a, vol_b, occ_b)`. Raymarch bind group: 0 `vol_a` texture_3d, 1 sampler(LINEAR), 2 Cam uniform, 3 `occ_a` texture_3d, 4 sampler(NEAREST non-filter), 5 `vol_b` texture_3d, 6 `occ_b` texture_3d.

- [ ] **Step 1: `CamUniform.frac`** — add `frac: f32` in `camera.rs` at the tail pad slot (after `macro_dim`) so the struct stays 80 bytes; mirror in the WGSL `Cam` struct (`raymarch.wgsl`). Keep the `cam_uniform_size` test at 80. `basis()` leaves frac 0.0.

- [ ] **Step 2: `raymarch.wgsl` dual sample + occupancy union.** Add `@binding(5) var vol_b: texture_3d<f32>;` + `@binding(6) var occ_b: texture_3d<f32>;` (reuse `samp` binding 1 for both volumes, `occ_samp` binding 4 for both occupancies). In the march loop:
```wgsl
// occupancy skip: union of both frames (never skip a cell occupied in EITHER)
let occ_uvw = (floor(pos * md) + 0.5) / md;
let maxd = max(textureSampleLevel(occ, occ_samp, occ_uvw, 0.0).r,
               textureSampleLevel(occ_b, occ_samp, occ_uvw, 0.0).r);
if (maxd < SKIP_THRESHOLD) { /* AABB jump as today */ continue; }
// interpolate the two frames:
let sa = textureSampleLevel(vol, samp, pos, 0.0);
let sb = textureSampleLevel(vol_b, samp, pos, 0.0);
let s = mix(sa, sb, C.frac);      // lerp color(.rgb) + density(.a)
// ... existing shape/composite using s (unchanged from here) ...
```
For LIVE (`frac=0`, vol_b==vol_a, occ_b==occ_a): `max(occ,occ)`=occ, `mix(sa,sa,0)`=sa → byte-identical to the single-frame path. Validate `naga shaders/raymarch.wgsl`.

- [ ] **Step 3: `raymarch.rs` bind group** — add BGL entries 5 (`Texture{Float filterable:true}` D3, vol_b) + 6 (`Texture{Float filterable:false}` D3, occ_b). `make_bind_group`/`rebuild_bind_group(device, vol_a, occ_a, vol_b, occ_b)` bind vol_a/occ_a/vol_b/occ_b with the existing two samplers. `Renderer::new` builds initial bind group with live volume/occupancy for BOTH a and b. Reconcile wgpu-29 via `cargo check`.

- [ ] **Step 4: `mod.rs` + `app.rs` wiring.**
  - `ensure_generated` (dirty): `rebuild_bind_group(&vol.view, vol.occupancy_view(), &vol.view, vol.occupancy_view())` (live twice) and the callback sets `cam.frac = 0.0` for the live/paused case.
  - `bind_playback(device, phase)`: `let (i, i1, frac) = anim::interp_frame(phase, frame_cache.frame_count()); rebuild_bind_group(view_at(i), occupancy_at(i), view_at(i1), occupancy_at(i1));` and return `frac` (or store it) so `prepare` writes `cam.frac = frac`. None-safe (empty cache → false, leave bind group).
  - In `RaymarchCallback::prepare`: after `bind_playback`/`ensure_generated`, set `cam.frac` = the playback frac (when playing) else 0.0, and `cam.macro_dim` = the bound res's macro_dim (as cycle ⑤). Write the patched cam.
  - `app.rs`: no new state needed — it already passes `playback_phase = Some(self.phase)` when playing; the renderer derives `i,i1,frac` from `phase` + `frame_count`. Confirm the callback carries `playback_phase` (Some when playing) as today.

- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && naga shaders/occupancy.wgsl && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): temporal interpolation — lerp adjacent baked frames (occupancy union) for smooth playback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1:** Update `RUN.md`: playback now interpolates between baked frames, so a long loop (e.g. 10 s) with modest frames (24) plays SMOOTHLY (was choppy) — smoothness no longer needs a high frame count. Ask the user to report: is the 10 s loop smooth now at low frame counts; any ghosting/double-imaging on FAST motion (expected with linear blend — report scenes where it's bad); is live/paused editing unchanged; occupancy skip still artifact-free (no boundary clipping). Note: `frac` interpolation is playback-only; velocity-warp (ghost-free) is deferred.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): temporal-interpolation run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** two-adjacent-frame lerp + occupancy union (T2 S2) ✓; `interp_frame` i/i1/frac (T1) ✓; bind group 2 vol + 2 occ + frac (T2 S1,S3) ✓; live/paused identical via bind-twice + frac=0 (T2 S2,S4) ✓; playback-only (T2 S4) ✓; helper unit-tested (T1) ✓; zero readback (no map/copy added) ✓; user GPU run (T3) ✓; velocity-warp deferred (absent) ✓.

**Placeholder scan:** `interp_frame` + the shader lerp/union + the bind-group bindings are concrete; wgpu-29 binding reconciliation is `cargo check`-gated — appropriate.

**Type consistency:** `interp_frame(phase, n) -> (usize, usize, f32)` defined T1, used in `bind_playback` (T2 S4); `view_at`/`occupancy_at`/`frame_count` defined T1, used T2 S4; `CamUniform.frac` at byte 76 (T2 S1) matches WGSL `Cam.frac` + written in `prepare` (T2 S4); `rebuild_bind_group(vol_a,occ_a,vol_b,occ_b)` signature consistent across `mod.rs` live-twice + `bind_playback` two-frames (T2 S3,S4).
