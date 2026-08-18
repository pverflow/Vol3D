# Vol3D v3 — Non-Cubic Aspect Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Making the box taller should keep the sides the same size and just extend the long axis (not shrink the sides / grow the SDF). Min-normalize the aspect + frame the camera on the box center at a fit distance.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-noncubic-aspect-fix-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `naga`. All under `v3/`. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/raymarch.wgsl` validates.
- **`[128,128,128]` (aspect `[1,1,1]`, fit `1`, center `[0.5]³`) MUST be byte-identical to today.** No generation/occupancy/cache/shader change. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/anim.rs           # MOD: aspect_from_dims max→min; test
v3/src/camera.rs         # MOD: basis(fov, steps, box_aspect:[f32;3]) — box center + fit distance; test
v3/src/render/raymarch.rs# MOD: pass aspect_from_dims(dims) into basis (move before basis call)
v3/RUN.md                # MOD (Task 2)
```

---

## Task 1: Min-normalize aspect + camera box-center/fit

**Files:** `v3/src/anim.rs`, `v3/src/camera.rs`, `v3/src/render/raymarch.rs`.

- [ ] **Step 1: `aspect_from_dims` min (TDD)** — change `max` → `min`:
```rust
pub fn aspect_from_dims(dims: [u32; 3]) -> [f32; 3] {
    let m = dims.iter().copied().min().unwrap().max(1) as f32;
    [dims[0] as f32 / m, dims[1] as f32 / m, dims[2] as f32 / m]
}
```
Update the test:
```rust
#[test] fn aspect_from_dims_cases() {
    assert_eq!(aspect_from_dims([128,128,128]), [1.0,1.0,1.0]);
    assert_eq!(aspect_from_dims([64,64,256]), [1.0,1.0,4.0]);   // min-normalized: sides stay 1
    assert_eq!(aspect_from_dims([0,0,0]), [0.0,0.0,0.0]);       // min(1) guard, no NaN
}
```
Run → fail → fix → pass.

- [ ] **Step 2: `basis` box center + fit (TDD)** — change the signature to `pub fn basis(&self, aspect: f32, steps: f32, box_aspect: [f32; 3]) -> CamUniform` and:
```rust
let center = [box_aspect[0] * 0.5, box_aspect[1] * 0.5, box_aspect[2] * 0.5];
let fit = ((box_aspect[0]*box_aspect[0] + box_aspect[1]*box_aspect[1] + box_aspect[2]*box_aspect[2]).sqrt()
           / 3.0f32.sqrt()).max(1e-4);
let d = self.distance * fit;
let eye = [center[0] + dir[0]*d, center[1] + dir[1]*d, center[2] + dir[2]*d];
// fwd/right/up unchanged (look from eye toward center)
```
(`fwd = norm(center - eye)`.) Leave `box_aspect_*`/`macro_dims_*`/`frac` as `basis` sets them today (still 0/identity — `raymarch.rs::prepare` fills them). Update the test:
```rust
#[test] fn basis_is_orthonormal_and_looks_at_center() {
    let c = OrbitCamera::default().basis(1.0, 128.0, [1.0,1.0,1.0]);   // cube: center [0.5]³, fit 1
    let to_center = norm([0.5 - c.eye[0], 0.5 - c.eye[1], 0.5 - c.eye[2]]);
    for (f, t) in c.fwd.iter().zip(to_center.iter()) { assert!((f - t).abs() < 1e-5); }
    // tall box centers higher in Z and pulls the eye further out:
    let t = OrbitCamera::default().basis(1.0, 128.0, [1.0,1.0,4.0]);
    // fwd aims at box center [0.5,0.5,2.0]
    let tc = norm([0.5 - t.eye[0], 0.5 - t.eye[1], 2.0 - t.eye[2]]);
    for (f, x) in t.fwd.iter().zip(tc.iter()) { assert!((f - x).abs() < 1e-5); }
}
```
Run → fail → implement → pass. (At `[1,1,1]`, `center=[0.5]³`, `fit=1` → identical to the old `basis`.)

- [ ] **Step 3: `raymarch.rs::prepare` wire** — compute `let asp = crate::anim::aspect_from_dims(dims);` BEFORE the `basis` call (the bound `dims` is already derived there for `box_aspect`); call `self.camera.basis(fov_aspect, steps, asp)`; keep setting `cam.box_aspect_* = asp` as today. No other change.

- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "fix(v3): min-normalize box aspect + camera frames box center — taller box keeps its sides

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** update the non-cubic section: growing an axis now **extends the box along that axis without shrinking the others** — the sides keep their size, an SDF sphere keeps its proportions, and the camera stays centered on and fits the (taller) box. Ask the user to report: `[128,128,128]` identical; `[64,64,256]` now grows *taller* with **unchanged-size sides** and an **unchanged-size sphere** (vs the old shrink), camera centered + whole box in frame.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): non-cubic aspect fix run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** min-normalize (T1 S1) ✓; camera box center + fit distance (T1 S2) ✓; prepare wiring (T1 S3) ✓; cubic identity (fit=1, center [0.5]³ at [1,1,1]) ✓; no gen/occ/cache/shader change ✓; GPU run (T2) ✓.
**Placeholder scan:** concrete code for aspect + basis; the only heuristic (`fit=len/sqrt(3)`) is fully specified.
**Type consistency:** `aspect_from_dims([u32;3])->[f32;3]` (T1) fed into `basis(_,_,box_aspect:[f32;3])` (T1) from `prepare` (T1 S3); `box_aspect_*` on CamUniform unchanged.
