# Vol3D v3 — Loopable Warp Offset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** A per-layer "Loop offset" toggle so the warp offset can loop seamlessly (offset 0→1 = one loop) via a tileable warp field, while off keeps today's infinite scroll.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-loopable-warp-offset-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `naga`. All under `v3/`. Zero readback. Reuses the existing periodic `pnoise3_core`.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates.
- **`warp_loop == false` (default) MUST be byte-identical to today** — the loop branch is separate; off-path is the current code verbatim. `GpuLayer` stays **304 bytes** (`warp_loop` reuses a trailing pad @292). Zero readback. No change to non-warp distortion / noise / SDF / raymarch.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/layer.rs          # MOD: LayerDesc.warp_loop:bool; GpuLayer _pad_do0 → warp_loop:u32 (offset 292; size 304); pack_layer; layout test
v3/shaders/generate.wgsl # MOD: GpuLayer warp_loop; WARP_LOOP_PERIOD + warp_field_loop; loop branch in DomainWarp/Curl/Turbulence
v3/src/app.rs            # MOD: "Loop offset" checkbox in Distortion (DomainWarp/Curl/Turbulence)
v3/RUN.md                # MOD (Task 3)
```

---

## Task 1: Core — `warp_loop` field + periodic warp path

**Files:** `v3/src/layer.rs`, `v3/shaders/generate.wgsl`.

- [ ] **Step 1: Rust field + layout** — `LayerDesc += pub warp_loop: bool` (default `false`). `GpuLayer`: change the trailing pad so a `warp_loop: u32` sits at offset **292** (currently `_pad_do: [f32;3]` @292/296/300 — replace with `warp_loop: u32`@292 + `_pad_do: [f32;2]`@296/300). Size stays **304**. `pack_layer` writes `warp_loop: l.warp_loop as u32`. Update `gpu_layer_std430_layout`: assert `offset_of!(GpuLayer, warp_loop) == 292`, size still 304, keep existing asserts.
- [ ] **Step 2: WGSL struct** — mirror: the field at 292 becomes `warp_loop: u32` (then two pad f32 → 304). naga validates.
- [ ] **Step 3: WGSL periodic field** — add near `warp_field`:
```wgsl
const WARP_LOOP_PERIOD: f32 = 32.0;
fn warp_field_loop(p: vec3<f32>) -> f32 {
  return pnoise3_core(p, vec3<f32>(WARP_LOOP_PERIOD)) * 0.5 + 0.5;
}
```
- [ ] **Step 4: loop branches** in `apply_distortion` (`ofs` already computed as `vec3(L.distortion_offset_x/y/z)`):
  - **DomainWarp (case 1):** wrap the existing body in `if (L.warp_loop != 0u) { let wp = q * L.distortion_frequency + ofs * WARP_LOOP_PERIOD; nx = warp_field_loop(wp + o1); ny = warp_field_loop(wp + o2); nz = warp_field_loop(wp + o3); } else { <current: wp=(q+ofs)*freq, nx=warp_field(L,wp+o1)...> }` (o1/o2/o3 = the existing offset vectors `(0,1.7,9.2)/(8.3,2.8,4.1)/(4.0,3.1,6.7)`).
  - **Curl (case 2):** loop → the 6 taps `warp_field_loop(q + ofs*WARP_LOOP_PERIOD ± eps·axis)`; else the current `warp_field(L, q + ofs ± eps·axis)`.
  - **Turbulence (case 5):** inside the octave loop, `let wp = select((q + ofs) * freq, q * freq + ofs * WARP_LOOP_PERIOD, L.warp_loop != 0u);` then `select(warp_field(L, wp+oN), warp_field_loop(wp+oN), L.warp_loop != 0u)` for the 3 taps (or an `if/else` on `L.warp_loop`). `freq` is the per-octave frequency (doubles each octave).
  (Keep the off-path EXACTLY as today so `warp_loop==0` is byte-identical.)
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): loopable warp offset — tileable periodic warp field (offset 0..1 = one seamless loop)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: UI — "Loop offset" checkbox

**Files:** `v3/src/app.rs`.

- [ ] **Step 1:** in the Distortion `CollapsingHeader`, add `ui.checkbox(&mut self.layers[i].warp_loop, "Loop offset").on_hover_text("Offset 0→1 = one seamless loop (tileable field)")`, shown when `distortion_type ∈ {DomainWarp, Curl, Turbulence}` (same gate as the Warp Noise combo / Warp Offset rows). On `.changed()` → `self.mark_dirty(ui.ctx())`. Place it near the Warp Offset rows.
- [ ] **Step 2: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Distortion UI — Loop offset toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document the **Loop offset** toggle (Distortion, for Domain Warp / Curl / Turbulence): off = infinite scroll (as before); on = the warp field tiles, and **keyframing Warp Offset 0 → 1 over the loop drifts seamlessly** (wind that loops). Note loop mode uses a tileable Perlin warp field regardless of the Warp Noise selector. Ask the user to report: Loop on + keyframe Warp Offset Z 0→1 over the animation → seamless drift (no jump at the loop seam); Loop off = unchanged infinite scroll.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): loopable warp offset run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** `warp_loop` field + layout 304 (T1 S1,S2) ✓; `WARP_LOOP_PERIOD`+`warp_field_loop` (T1 S3) ✓; loop branch in DomainWarp/Curl/Turbulence, offset→`ofs*PERIOD`, off-path verbatim (T1 S4) ✓; UI toggle gated (T2) ✓; off = byte-identical ✓; naga/tests ✓; GPU run (T3) ✓.
**Placeholder scan:** concrete; reuses `pnoise3_core` + the existing `ofs`/`o1..o3`.
**Type consistency:** `LayerDesc.warp_loop:bool` → `GpuLayer.warp_loop:u32`@292 (T1) read in `apply_distortion` (T1 S4) + toggled in UI (T2); `GpuLayer` 304 Rust↔WGSL.
