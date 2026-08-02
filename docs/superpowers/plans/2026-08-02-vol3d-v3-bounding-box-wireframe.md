# Vol3D v3 — Bounding-Box Wireframe Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Draw the volume's bounding-box wireframe over the raymarch — on viewport hover, and as a ~2 s flash + ~1 s fade when the box dimensions change. Driven by one `wire_alpha` float; `0` = byte-identical to today.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-bounding-box-wireframe-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `naga`. All under `v3/`. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/raymarch.wgsl` validates.
- **`wire_alpha == 0` MUST be byte-identical to today** (early-out before any overlay math). `CamUniform` stays **112 bytes** (`wire_alpha` reuses `_pad0` at offset 100). No change to the volume march / composite / generation / cache. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/camera.rs         # MOD: CamUniform _pad0 → wire_alpha (offset 100; size stays 112); basis leaves 0
v3/shaders/raymarch.wgsl # MOD: Cam.wire_alpha; box-wireframe overlay after the volume color (guarded)
v3/src/anim.rs           # MOD: pure flash_envelope(elapsed,hold,fade)->f32 + test
v3/src/app.rs            # MOD: wire_hover lerp + wire_flash_start; set cam.wire_alpha = max(hover, flash)
v3/RUN.md                # MOD (Task 3)
```

---

## Task 1: Shader wireframe overlay + `CamUniform.wire_alpha`

**Files:** `v3/src/camera.rs`, `v3/shaders/raymarch.wgsl`.

- [ ] **Step 1: `CamUniform.wire_alpha`** — rename `_pad0: f32` → `pub wire_alpha: f32` (offset 100, still followed by `_pad1`,`_pad2` → size 112). `basis()` sets `wire_alpha: 0.0`. The existing `cam_uniform_size_matches_wgsl_std140_padding` test (112) stays green (no size change). Mirror in `raymarch.wgsl`'s `Cam` struct: the field after `box_aspect_z` becomes `wire_alpha: f32` (then two pad f32 if present, or the struct already ends — match the Rust layout so 112 holds; `naga` validates).
- [ ] **Step 2: overlay helpers (WGSL)** — add to `raymarch.wgsl`:
```wgsl
// world point -> screen (same space as `screen = uv*2-1`; x scaled by aspect*tan, y by tan). z = cam-depth.
fn wb_project(P: vec3<f32>) -> vec3<f32> {
  let v = P - C.eye;
  let z = dot(v, C.fwd);
  let inv = 1.0 / max(z, 1e-4);
  return vec3<f32>(dot(v, C.right) * inv / (C.aspect * C.tan_half_fov),
                   dot(v, C.up)    * inv /  C.tan_half_fov, z);
}
// aspect-weighted 2D point-to-segment distance (x weighted by aspect so thickness is ~uniform).
fn wb_seg_dist(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>, aw: f32) -> f32 {
  let pw = vec2<f32>(p.x*aw, p.y); let aa = vec2<f32>(a.x*aw, a.y); let bb = vec2<f32>(b.x*aw, b.y);
  let pa = pw - aa; let ba = bb - aa;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
```
- [ ] **Step 3: overlay in `fs`** — just before the final `return`, after the volume color is in a mutable `var col` (refactor the final `pow(acc,...)` into `var col = pow(acc, vec3<f32>(0.4545)); ... return vec4<f32>(col, 1.0);`). Insert (guarded):
```wgsl
if (C.wire_alpha > 0.0) {
  let asp = vec3<f32>(C.box_aspect_x, C.box_aspect_y, C.box_aspect_z);
  var corners = array<vec3<f32>, 8>(
    vec3<f32>(0.0,0.0,0.0), vec3<f32>(asp.x,0.0,0.0), vec3<f32>(0.0,asp.y,0.0), vec3<f32>(asp.x,asp.y,0.0),
    vec3<f32>(0.0,0.0,asp.z), vec3<f32>(asp.x,0.0,asp.z), vec3<f32>(0.0,asp.y,asp.z), vec3<f32>(asp.x,asp.y,asp.z));
  var edges = array<vec2<u32>, 12>(
    vec2<u32>(0u,1u), vec2<u32>(2u,3u), vec2<u32>(4u,5u), vec2<u32>(6u,7u),   // x-dir
    vec2<u32>(0u,2u), vec2<u32>(1u,3u), vec2<u32>(4u,6u), vec2<u32>(5u,7u),   // y-dir
    vec2<u32>(0u,4u), vec2<u32>(1u,5u), vec2<u32>(2u,6u), vec2<u32>(3u,7u));  // z-dir
  var cov = 0.0;
  for (var e = 0u; e < 12u; e = e + 1u) {
    let a = wb_project(corners[edges[e].x]);
    let b = wb_project(corners[edges[e].y]);
    if (a.z <= 1e-4 || b.z <= 1e-4) { continue; }
    let d = wb_seg_dist(screen, a.xy, b.xy, C.aspect);
    cov = max(cov, 1.0 - smoothstep(0.004 - 0.0025, 0.004 + 0.0025, d));
  }
  col = mix(col, vec3<f32>(0.55, 0.78, 1.0), cov * C.wire_alpha);
}
return vec4<f32>(col, 1.0);
```
(`screen` is the fragment's `in.uv*2-1`, already computed at the top of `fs` — reuse it.)
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): bounding-box wireframe overlay in the raymarch (wire_alpha-gated, off = identical)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `wire_alpha` driver — hover + flash-on-dims-change

**Files:** `v3/src/anim.rs`, `v3/src/app.rs`.

**Interfaces produced:** `anim::flash_envelope(elapsed: f64, hold: f64, fade: f64) -> f32` — `1.0` while `elapsed < hold`; linear `1→0` over `[hold, hold+fade]`; `0.0` after (and for `elapsed < 0`).

- [ ] **Step 1: `flash_envelope` (TDD)** —
```rust
#[test] fn flash_envelope_shape() {
    assert_eq!(flash_envelope(-5.0, 2.0, 1.0), 0.0);   // before start (never flashed)
    assert_eq!(flash_envelope(0.0, 2.0, 1.0), 1.0);    // hold
    assert_eq!(flash_envelope(1.9, 2.0, 1.0), 1.0);
    assert!((flash_envelope(2.5, 2.0, 1.0) - 0.5).abs() < 1e-6); // mid-fade
    assert_eq!(flash_envelope(3.1, 2.0, 1.0), 0.0);    // after
}
```
Run → fail → implement → pass. (`elapsed < 0` → 0.0 so the `-1e9` init never shows a flash.)
- [ ] **Step 2: state** — add to `Vol3dApp`: `wire_hover: f32` (init 0.0), `wire_flash_start: f64` (init `-1e9`).
- [ ] **Step 3: flash trigger** — in the Box dim-selector change block (where `cache_stale`/`mark_dirty` fire on a dims change), set `self.wire_flash_start = ui.ctx().input(|i| i.time);`.
- [ ] **Step 4: compute + set** — each frame in `ui()` (near the camera/cam build): get the viewport `hovered` (the response of the rect used for orbit/zoom input — reuse it; find it via the existing pointer-drag handling for the central viewport). Then:
```rust
let target = if viewport_hovered { 1.0 } else { 0.0 };
self.wire_hover += (target - self.wire_hover) * 0.18;
let hover_alpha = self.wire_hover * 0.55;
let now = ui.ctx().input(|i| i.time);
let flash = anim::flash_envelope(now - self.wire_flash_start, 2.0, 1.0);
let wire_alpha = hover_alpha.max(flash).clamp(0.0, 1.0);
```
Set it onto the `CamUniform` the callback carries — `self.cam.wire_alpha = wire_alpha;` after `basis()` (mirror how `committed_dims`/`box_aspect` are threaded). Continuous repaint is already on, so the fade animates.
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): bounding-box wireframe on hover + flash-and-fade on box resize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document: hovering the viewport shows the volume's **bounding-box wireframe** (soft fade in/out); changing a **Box** dimension **flashes** it for ~2 s then fades — so you can see what changed. Ask the user to report: hover shows/hides the box; a dim change flashes it then fades; the wireframe matches the box shape (tall for `[64,64,256]`, cube for `[128,128,128]`); not hovering / no recent change looks exactly like before.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): bounding-box wireframe run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** `wire_alpha` (reuse pad, 112) (T1 S1) ✓; overlay project + 12 edges + blend, guarded off (T1 S2,S3) ✓; `flash_envelope` + test (T2 S1) ✓; hover lerp + flash trigger + set on cam (T2 S2-4) ✓; off = byte-identical (guard) ✓; naga/tests ✓; GPU run (T3) ✓.
**Placeholder scan:** shader + helper code is concrete; the only "find it" is the existing viewport hover response (T2 S4) — a lookup, not a placeholder.
**Type consistency:** `CamUniform.wire_alpha` (T1) ↔ WGSL `Cam.wire_alpha` (T1) set from `app.rs` (T2 S4); `flash_envelope(f64,f64,f64)->f32` (T2 S1) used in T2 S4.
