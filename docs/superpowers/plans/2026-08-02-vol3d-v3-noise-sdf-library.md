# Vol3D v3 — Generation Library Parity: Noise + SDF Shapes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** v2 parity for noise + SDF. Add Worley(F1/F2/F2−F1)/Voronoi/White noise and Box/Cone/Capsule/Cylinder/Plume SDFs to v3's `generate.wgsl` + `layer.rs` enum + `app.rs` UI. Fix the dead `worley_mode` and `sdf_height`.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-noise-sdf-library-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Ports mirror v2 GLSL (cited). Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY — never modify it. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates.
- No GPU in sandbox: gates = compile + tests + naga; visuals are the user's GPU run (final task).
- **Enum is append-only** (0..4 keep their values). `is_sdf(t) = t==4u || t>=8u` — one predicate, WGSL + Rust.
- SDF fns return the soft field exactly like the existing sphere: `1.0 - smoothstep(0.0, max(softness,1e-4), sd)`.
- No change to blend/compositing/animation/raymarch. Zero readback. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/layer.rs        # MOD: NoiseType += Worley,Voronoi,White,SdfBox,SdfCone,SdfCapsule,SdfCylinder,SdfPlume; NoiseType::is_sdf(); tests
v3/src/app.rs          # MOD: noise-type combo entries; worley-mode combo (conditional); SDF params shown for is_sdf(); fbm_base combo
v3/shaders/generate.wgsl # MOD: hash13; noise_worley/voronoi/white; sdf_box/cone/capsule/cylinder/plume; is_sdf(); eval_noise + eval_base_noise dispatch; replace 3× ==4u
```

---

## Task 1: Worley + Voronoi + White noise

**Files:** `v3/shaders/generate.wgsl`, `v3/src/layer.rs`, `v3/src/app.rs`.
**v2 refs (read, don't modify):** `src/shaders/noise/worley3d.glsl`, `voronoi3d.glsl`, `white3d.glsl`, `src/shaders/common/hash.glsl` (for `hash13`), `src/types/noise.ts:25-29` (worley mode enum).

- [ ] **Step 1: enum + Rust** — `NoiseType` append `Worley=5, Voronoi=6, White=7` (leave 0..4). Add `impl NoiseType { pub fn is_sdf(self) -> bool { matches!(self, SdfSphere) } }` (extended in Task 2). Update the enum-values unit test (`Worley as u32 == 5`, etc.). `worley_mode` field already exists on `LayerDesc`/`GpuLayer` — no struct change.
- [ ] **Step 2: WGSL noise fns** — port into `generate.wgsl`:
  - `hash13(p3: vec3<f32>) -> f32` (from `hash.glsl`).
  - `noise_worley(p, seed, mode: u32) -> f32` — 3×3×3 cell loop, `hash33(ip + cell + vec3(seed))`, F1/F2; mode 0→`clamp(1-F1*1.5,0,1)`, 1→`clamp(1-F2*1.1,0,1)`, else `clamp((F2-F1)*2,0,1)`.
  - `noise_voronoi(p, seed) -> f32` — 3×3×3, `hash33(cell + vec3(seed*0.1))`, `clamp((F2-F1)*2.5,0,1)`.
  - `noise_white(p, seed) -> f32` — `hash13(floor(p) + vec3(seed*0.91))`.
- [ ] **Step 3: dispatch** — `eval_noise`: add `case 5u → noise_worley(p, L.seed, L.worley_mode)`, `6u → noise_voronoi(p, L.seed)`, `7u → noise_white(p, L.seed)`. `eval_base_noise`: add `case 5u/6u/7u` (worley uses `worley_mode` — pass a sensible mode, e.g. the layer's; if `eval_base_noise` lacks `L`, pass `0u` F1 and note it). Keep existing cases.
- [ ] **Step 4: UI** — noise-type combo: add Worley/Voronoi/White. Add a **Worley Mode** combo (F1/F2/F2−F1 → 0/1/2 into `worley_mode`) shown only when `noise_type == Worley`. `fbm_base` combo: include Worley/Voronoi/White (exclude Fbm + SDFs).
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Worley (F1/F2/F2-F1) + Voronoi + White noise (v2 parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SDF shapes + `is_sdf` refactor + `sdf_height`

**Files:** `v3/shaders/generate.wgsl`, `v3/src/layer.rs`, `v3/src/app.rs`.
**v2 refs:** `src/core/sdfField.ts` (per-shape signed-distance math + radius/softness/height semantics), `src/shaders/noise/sdf_{box,cone,capsule,cylinder,plume}.glsl`.

- [ ] **Step 1: enum + Rust** — `NoiseType` append `SdfBox=8, SdfCone=9, SdfCapsule=10, SdfCylinder=11, SdfPlume=12`. Extend `is_sdf` to `matches!(self, SdfSphere|SdfBox|SdfCone|SdfCapsule|SdfCylinder|SdfPlume)`. Unit test: `is_sdf` true for {Sphere,Box,Cone,Capsule,Cylinder,Plume}, false for the 7 non-SDF; enum values 8..12.
- [ ] **Step 2: WGSL `is_sdf` + fns** — add `fn is_sdf(t: u32) -> bool { return t == 4u || t >= 8u; }`. Port each shape (return the soft field via the sphere's `1 - smoothstep(0, max(softness,1e-4), sd)` wrapper), reading `sdf_radius`/`sdf_softness`/`sdf_height` per v2 semantics (capsule/cylinder/plume use `sdf_height`; box half-extent = radius; cone height = 2×radius; plume tapers). **`sdf_height` must actually be read** (fixes dead field).
- [ ] **Step 3: dispatch + refactor** — `eval_noise`: keep `case 4u → sdf_sphere`, add `8u..12u` → the new shapes. Replace the **three** `L.noise_type == 4u` checks (eval_noise sphere branch, the position-centering branch, the single-sample-vs-tileable branch) with `is_sdf(L.noise_type)`. Verify all three sites via grep.
- [ ] **Step 4: UI** — noise-type combo: add the 5 SDF shapes. SDF param controls (radius/softness/height): change the gate from `== SdfSphere` to `is_sdf(...)`. Show `sdf_height` for the shapes that use it (capsule/cylinder/plume; include cone if v2 uses it) — or show for all SDF with a code note; match v2 gating where cheap.
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): SDF Box/Cone/Capsule/Cylinder/Plume + is_sdf predicate; wire sdf_height (v2 parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document the new noise (Worley + F1/F2/F2−F1 mode, Voronoi, White) and SDF shapes (Box/Cone/Capsule/Cylinder/Plume), plus that `sdf_height` now works. Ask the user to report: each new noise renders and differs; Worley modes differ; each SDF shape renders and radius/softness/height affect it; existing Value/Perlin/Simplex/FBM/Sphere scenes unchanged; FBM-with-Worley-base works.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): noise+SDF library run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** Worley(+mode)/Voronoi/White (T1) ✓; Box/Cone/Capsule/Cylinder/Plume (T2) ✓; `hash13` (T1) ✓; `is_sdf` predicate Rust+WGSL replacing 3× `==4u` (T2) ✓; `worley_mode` wired (T1 S3,S4) ✓; `sdf_height` wired (T2 S2,S4) ✓; fbm base extended (T1 S3,S4) ✓; UI combos + conditionals (T1 S4, T2 S4) ✓; naga/tests (all) ✓; no readback ✓.

**Type consistency:** `NoiseType` append 5..12 (T1 S1, T2 S1) matches WGSL dispatch cases (T1 S3, T2 S3); `is_sdf` Rust (T1 S1→T2 S1) mirrors WGSL `is_sdf` (T2 S2); `worley_mode`/`sdf_height` are existing `GpuLayer` fields (no struct/layout change) now read by shader + UI.

**Placeholder scan:** all fns concrete ports of cited v2 files; the only judgment call is `eval_base_noise`'s worley mode (documented: pass F1/`0u` if `L` unavailable) — display/quality nicety, not logic.
