# Vol3D v3 — Domain Distortion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** v2 parity for per-layer domain distortion (None/DomainWarp/Curl/Swirl/Polar). Fill the existing `apply_distortion` hook in `sample_noise_at`, add the `DistortionType` enum + 3 params, and a Distortion UI section. Wire the dead `distortion_type`.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-distortion-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Ports mirror v2 GLSL. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY — never modify it. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates.
- **`GpuLayer` stays layout-consistent Rust↔WGSL** — new size **224** (14×16); update the `gpu_layer_std430_layout` test.
- `type=None` MUST be a no-op (existing scenes byte-identical). No change to blend/compositing/animation/raymarch/fps-cache. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/layer.rs        # MOD: enum DistortionType; LayerDesc + GpuLayer gain distortion_type(source)+strength+frequency+swirl (+pad, size 224); pack_layer; layout test
v3/shaders/generate.wgsl # MOD: GpuLayer struct (mirror 224); base_noise_eval; apply_distortion; fill the sample_noise_at TODO
v3/src/app.rs          # MOD: properties-panel Distortion section (type/strength/freq/swirl)
```

---

## Task 1: Distortion core — enum, params, layout, shader

**Files:** `v3/src/layer.rs`, `v3/shaders/generate.wgsl`.
**v2 refs (read, don't modify):** `src/shaders/distortion/{domain_warp,curl,swirl,polar}.glsl`, `src/state/AppState.ts` (`defaultLayer()` distortion defaults), `src/types/layer.ts:14-35`.

- [ ] **Step 1: Rust enum + fields** — add `#[repr(u32)] enum DistortionType { None=0, DomainWarp=1, Curl=2, Swirl=3, Polar=4 }`. `LayerDesc`: add `distortion_type: DistortionType` + `distortion_strength: f32`, `distortion_frequency: f32`, `distortion_swirl: f32` (defaults from v2 `defaultLayer()`; fallback 0.5 / 2.0 / 1.0, type None). `GpuLayer`: append after `distortion_type`: `distortion_strength`(208), `distortion_frequency`(212), `distortion_swirl`(216), `_pad_distort: f32`(220) → **size 224**. `pack_layer` writes the 3 params + `distortion_type as u32`.
- [ ] **Step 2: layout test** — update `gpu_layer_std430_layout`: `size_of == 224`; assert offsets of the 4 new scalars (208/212/216/220). Keep existing offset asserts.
- [ ] **Step 3: WGSL struct** — mirror the 4 new fields in the `generate.wgsl` `GpuLayer` struct (same order) so it stays 224.
- [ ] **Step 4: WGSL distortion fns** — add (port verbatim per spec):
  - `base_noise_eval(L, p) -> f32`: `if L.noise_type==3u { eval_base_noise(L.fbm_base, p, L.seed) } else { eval_noise(L, p) }`.
  - `apply_distortion(L, p) -> vec3<f32>`: switch `L.distortion_type` — 1 DomainWarp, 2 Curl, 3 Swirl, 4 Polar (exact formulas from the 4 GLSL files), default → p. Use `distortion_strength/frequency/swirl`.
- [ ] **Step 5: wire the hook** — in `sample_noise_at`, replace the `// TODO(distortion…)` line (just before `return eval_noise(L, p);`) with `p = apply_distortion(L, p);`. (Confirm no recursion: `base_noise_eval` calls `eval_noise`/`eval_base_noise`, never `sample_noise_at`/`apply_distortion`.)
- [ ] **Step 6: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): domain distortion (warp/curl/swirl/polar) in generation (v2 parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Distortion UI

**Files:** `v3/src/app.rs`.
**v2 ref:** `src/ui/panels/PropertiesPanel.ts:416-473` (`buildDistortionSection`).

- [ ] **Step 1:** add a **Distortion** `CollapsingHeader` to the properties panel (near Remap/Transform): a type combo (None / Domain Warp / Curl / Swirl / Polar → `DistortionType`); a **Strength** slider (0–2); **Warp Freq** (0.5–10) shown only when type==DomainWarp; **Swirl Amt** (−5..5) shown only when type==Swirl. Each control change routes through the existing per-layer edit path (`mark_dirty` → `cache_stale`/regen) exactly like the other layer params — verify it does (don't add a separate regen trigger).
- [ ] **Step 2: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Distortion properties panel (type/strength/freq/swirl)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document the new Distortion section (per-layer: None/Domain Warp/Curl/Swirl/Polar + Strength, and Warp Freq / Swirl Amt for their types). Ask the user to report: each type visibly warps a noise layer (warp=wobble, curl=flow, swirl=Y-twist, polar=radial); Strength scales the effect; Warp-Freq + Swirl-Amt work; type=None leaves layers unchanged; existing scenes unaffected.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): distortion run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** DistortionType enum + 3 params + layout 224 (T1 S1,S2,S3) ✓; base_noise_eval + apply_distortion port (T1 S4) ✓; hook filled in sample_noise_at (T1 S5) ✓; dead distortion_type wired (T1 S1,S5) ✓; UI section w/ conditional freq/swirl (T2) ✓; None no-op (default switch → p) ✓; naga/tests (all) ✓; no readback ✓.

**Type consistency:** `DistortionType` u32 (T1 S1) ↔ WGSL `apply_distortion` switch cases (T1 S4); `GpuLayer` 224 Rust (T1 S1,S2) ↔ WGSL struct (T1 S3); the 3 params packed (T1 S1) read by `apply_distortion` (T1 S4); UI writes `LayerDesc` fields (T2) consumed by `pack_layer` (T1 S1).

**Placeholder scan:** all formulas are verbatim ports of the 4 cited GLSL files; the only lookup is v2's default distortion values (T1 S1 — read from AppState, fallback stated).
