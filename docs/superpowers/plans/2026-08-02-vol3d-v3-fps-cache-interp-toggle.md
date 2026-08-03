# Vol3D v3 — FPS-Driven Cache + Interpolation Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Author playback in **fps** (default 30) — N = round(fps × loop_seconds) frames baked at auto-res into a **4 GB** cache, played real-time so framerate = fps. **Interpolation** (crossfade) becomes a user **toggle**, default off (crisp nearest-frame steps).

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-fps-cache-interp-toggle-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback. Shader unchanged (frac=0 already = nearest).

## Global Constraints

- All under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates all shaders.
- No GPU in sandbox: gates = compile + tests + naga; visual/fps is the user's GPU run (final task).
- **Zero readback.** No change to generation/occupancy/composite math. CamUniform stays 80 bytes.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  anim.rs            # MOD: + max_loop_frames(budget)->u32 (+ test)
  render/
    frame_cache.rs   # MOD: FRAME_CACHE_BUDGET_BYTES 512MB->4GB (pub const) + doc comment
    mod.rs           # MOD: bind_playback(device, phase, interp: bool) — nearest when !interp
    raymarch.rs      # MOD: RaymarchCallback.interp; prepare passes it to bind_playback
  app.rs             # MOD: fps (def 30) replaces Frames; interp checkbox (def false);
                     #      derive+clamp N from fps*loop; loop_seconds now a bake input; readout
```

---

## Task 1: `max_loop_frames` helper + 4 GB budget

**Files:** `v3/src/anim.rs` (+ test), `v3/src/render/frame_cache.rs`.

- [ ] **Step 1 (TDD):** add to `anim.rs`:
```rust
/// Max baked frames whose floor-res (64³ rgba8) dense cache still fits `budget_bytes` —
/// the ceiling `app.rs` clamps N (fps × loop) to, so `playback_bake_res`'s 64³ floor never
/// exceeds VRAM. Floored at 1.
pub fn max_loop_frames(budget_bytes: u64) -> u32 {
    let per = (64u64).pow(3) * 4; // 1 MiB
    (budget_bytes / per).max(1) as u32
}
```
Test:
```rust
#[test] fn max_loop_frames_fits_floor_res() {
    assert_eq!(max_loop_frames(4 * 1024 * 1024 * 1024), 4096); // 4 GB / 1 MiB
    assert_eq!(max_loop_frames(1), 1);                          // floor at 1
}
```
Run → FAIL → implement → PASS.

- [ ] **Step 2:** `frame_cache.rs`: change `const FRAME_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;` to **`pub const FRAME_CACHE_BUDGET_BYTES: u64 = 4 * 1024 * 1024 * 1024;`** (make it `pub` so `app.rs` can clamp against it). Update the doc comment example (e.g. "4 GB → 64 frames @ 256³ / 512 @ 128³"). No logic change.

- [ ] **Step 3: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): 4GB frame-cache budget + max_loop_frames clamp helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Interpolation toggle (nearest vs crossfade)

**Files:** `v3/src/render/mod.rs`, `v3/src/render/raymarch.rs`.

**Interface:** `bind_playback(&mut self, device, phase: f32, interp: bool) -> Option<f32>`.

- [ ] **Step 1: `mod.rs` `bind_playback`** — add `interp: bool`:
  - `interp == true`: unchanged (`interp_frame(phase, n)` → bind `i`/`i1`, return `Some(frac)`).
  - `interp == false`: `let i = crate::anim::frame_for_phase(phase, n);` bind `view_at(i)`/`occupancy_at(i)` to **both** a and b slots (`rebuild_bind_group(device, v, o, v, o)`), return `Some(0.0)`.
  - Both None-safe on empty cache (return `None`, leave bind group).

- [ ] **Step 2: `raymarch.rs`** — `RaymarchCallback` gains `pub interp: bool`; in `prepare`, the `bind_playback` call passes `self.interp` (line ~321). No shader change (frac 0 already = no blend).

- [ ] **Step 3: gate + commit** (build won't be fully wired until Task 3 sets `interp` in the callback; `bind_playback`'s new arg + the callback field must still `cargo check` — the callback is constructed in `app.rs`, so add a temporary `interp: false` there IF needed to compile, which Task 3 replaces).
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): interpolation toggle — bind nearest baked frame when interp off

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `fps` control + derived/clamped N + readout

**Files:** `v3/src/app.rs`.

- [ ] **Step 1: state.** Add `pub fps: u32` (default **30**) and `pub interp: bool` (default **false**). Keep `frame_count: u32` as the **derived** baked N. Add a helper method `fn recompute_frame_count(&mut self)`:
```rust
let n = (self.fps as f32 * self.loop_seconds).round();
self.frame_count = n.clamp(1.0, anim::max_loop_frames(render::FRAME_CACHE_BUDGET_BYTES) as f32) as u32;
```
(Confirm the `pub const` path from Task 1; import as needed.) Call it once in the constructor after fields are set.

- [ ] **Step 2: UI.** Replace the `Frames` DragValue block (currently `range(1..=64)` on `frame_count`) with:
  - `ui.label("FPS");` + `DragValue::new(&mut self.fps).range(1..=120)`; on `.changed()` → `self.recompute_frame_count(); self.cache_stale = true;`
  - The **Loop (s)** DragValue: on `.changed()` → `self.recompute_frame_count(); self.cache_stale = true;` (loop is now a bake input — it was playback-only before).
  - `ui.checkbox(&mut self.interp, "Interpolate");` (no re-bake; playback-only).
  - **Readout:** replace the `cache: baked {frame_count} @ {resolution}³` line with, when not stale:
    `format!("baked {} @ {}³  ({:.1} GB)  {:.0} fps  {}", self.frame_count, bake_res, gb, self.frame_count as f32 / self.loop_seconds.max(1e-3), if self.interp {"smooth"} else {"steps"})`
    where `bake_res = renderer.frame_cache.bake_res()` (or the exposed getter; if the renderer isn't in scope at the panel, show the *requested* source res like today and note bake_res is auto — keep it simple, don't thread the renderer if it's awkward) and `gb = self.frame_count as f64 * (bake_res as f64).powi(3) * 4.0 / (1u64<<30) as f64`.

- [ ] **Step 3: callback.** Where `RaymarchCallback` is constructed, set `interp: self.interp` (replace any temporary from Task 2). Playback (`need_bake`/`use_cache`/`playback_phase`) otherwise unchanged — it already threads `frame_count` and `playback_phase`.

- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): fps control (default 30) drives baked frame count; loop is a bake input; interp checkbox + readout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document: control is now **FPS** (default 30) — playback bakes `fps × loop` frames into a **4 GB** cache (auto-res: 128³–192³ for typical loops, 64³ for long ones) and plays them at real time, so **type 30 → ~30 updates/sec, type 60 → ~60**. **Interpolate** checkbox: off = crisp true-fps steps (default), on = crossfade (smoother, ghosts on fast motion). Note: **4 GB free VRAM minimum**; a one-time bake hitch on Play scales with N (async bake deferred). Ask the user to report: does the typed fps visibly match the update rate; interp off crisp vs on smooth; readout (baked N @ res, GB, fps) sane; long loops soften not crash.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): fps-driven cache + interpolation toggle run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** 4 GB budget (T1 S2) ✓; `max_loop_frames` clamp (T1 S1) ✓; interp toggle nearest-vs-crossfade (T2) ✓; fps control default 30 + derived/clamped N (T3 S1,S2) ✓; loop_seconds as bake input (T3 S2) ✓; readout N/res/GB/fps (T3 S2) ✓; user GPU run (T4) ✓; shader unchanged (frac 0 = nearest) ✓; zero readback ✓.

**Type consistency:** `max_loop_frames(u64)->u32` (T1) used in `recompute_frame_count` (T3); `FRAME_CACHE_BUDGET_BYTES` made `pub` (T1) consumed in T3 clamp; `bind_playback(_,_,interp:bool)` (T2) called with `self.interp` via callback field (T2 S2, T3 S3); `frame_count` stays the derived baked N used by existing bake/`BakeKey`/`playback_phase` paths unchanged.

**Placeholder scan:** all concrete; the only "keep it simple if awkward" is the readout's `bake_res` source (use getter if in scope, else requested res) — a display-only nicety, not logic.
