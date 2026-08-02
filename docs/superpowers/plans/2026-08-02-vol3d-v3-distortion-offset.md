# Vol3D v3 — Distortion Warp Offset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** A keyframable per-layer `distortion_offset` that scrolls the warp-field sampling for Domain Warp / Curl / Turbulence — enabling a looping "flame in the wind."

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-distortion-offset-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates.
- `GpuLayer` stays byte-consistent Rust↔WGSL; new size **304**; update `gpu_layer_std430_layout`.
- `distortion_offset == [0,0,0]` MUST be a no-op (existing scenes byte-identical). Offset shifts the warp-field **sampling** position only, not the returned position. No change to blend/noise/SDF/raymarch. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/layer.rs          # MOD: LayerDesc.distortion_offset:[f32;3]; GpuLayer reuse _pad_di0/1 + append offset_z (size 304); pack_layer; layout test; ParamField += DistortionOffsetX/Y/Z + get/set/ALL/label
v3/shaders/generate.wgsl # MOD: GpuLayer struct (mirror 304); apply_distortion offsets warp-field sampling for domain_warp/curl/turbulence
v3/src/app.rs            # MOD: Distortion UI — Warp Offset X/Y/Z (keyframable via anim_param), shown for DomainWarp|Curl|Turbulence
v3/RUN.md                # MOD (Task 3)
```

---

## Task 1: Core — `distortion_offset` field, layout, shader, ParamField

**Files:** `v3/src/layer.rs`, `v3/shaders/generate.wgsl`.

- [ ] **Step 1: Rust field + ParamField** — `LayerDesc` += `pub distortion_offset: [f32;3]` (default `[0.0,0.0,0.0]`). `ParamField` += `DistortionOffsetX, DistortionOffsetY, DistortionOffsetZ` (append after `DistortionRotZ`); extend `ALL` (now 29), `label`, `get_param` (`DistortionOffsetX => self.distortion_offset[0]`, etc.) and `set_param` (mirror).
- [ ] **Step 2: GpuLayer layout (reuse pads → 304)** — rename `_pad_di0`(280)→`distortion_offset_x`, `_pad_di1`(284)→`distortion_offset_y`; append `distortion_offset_z`(288) + trailing pad(s) to reach **size 304** (16-multiple). `pack_layer` writes the 3 offset components from `l.distortion_offset` (pads 0.0). Update `gpu_layer_std430_layout`: `size_of==304` + assert offsets 280/284/288; keep existing asserts.
- [ ] **Step 3: WGSL struct** — mirror in `generate.wgsl` `GpuLayer`: rename the two `_pad_di` fields to `distortion_offset_x/y` and add `distortion_offset_z` (+ pad) → 304. (Or a `distortion_offset: vec3<f32>` if the byte layout matches — but three scalars mirrors the Rust exactly; pick what keeps offsets 280/284/288 and passes `naga` + the layout test.)
- [ ] **Step 4: WGSL apply_distortion offset** — add `let ofs = vec3<f32>(L.distortion_offset_x, L.distortion_offset_y, L.distortion_offset_z);` after `var q = drot * p;`. Then:
  - Domain Warp (case 1): `let wp = (q + ofs) * L.distortion_frequency;` (was `q * L.distortion_frequency`).
  - Curl (case 2): replace each `warp_field(L, q ± vec3(...eps...))` with `warp_field(L, q + ofs ± vec3(...eps...))` (add `ofs` to all 6 taps).
  - Turbulence (case 5): `let wp = (q + ofs) * freq;` inside the octave loop (was `q * freq`).
  - Swirl/Polar (cases 3/4) + the `q + warp`/`q + curl`/`q + off*s` result assignments: **unchanged** (offset affects sampling only, not the returned position).
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): distortion warp offset (scroll the warp field; keyframable) for warp/curl/turbulence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: UI — Warp Offset X/Y/Z (keyframable)

**Files:** `v3/src/app.rs`.

- [ ] **Step 1:** in the Distortion `CollapsingHeader`, add **Warp Offset X/Y/Z** rows shown when `distortion_type ∈ {DomainWarp, Curl, Turbulence}` (same gate as the Warp Noise combo). Each is a scalar row wrapped in the existing `anim_param(...)` helper with `ParamField::DistortionOffsetX/Y/Z`, editing `self.layers[i].distortion_offset[0/1/2]`, range `-10.0..=10.0`, speed `0.05` (use the same local-copy + write-back + `mark_dirty` pattern as the other wrapped scalar rows, e.g. the Distortion Rotation rows). So the offset is keyframable like every other scalar.
- [ ] **Step 2: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Distortion UI — keyframable Warp Offset X/Y/Z (wind scroll)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document **Warp Offset X/Y/Z** in the Distortion section: scrolls the warp field for Domain Warp / Curl / Turbulence, and (being keyframable) lets you **animate wind** — e.g. keyframe Warp Offset Z from 0 to a few units over the loop so a Turbulence-distorted flame drifts. Ask the user to report: changing Warp Offset scrolls the turbulent detail; keyframing it produces drifting/wind motion; offset 0 + existing scenes unchanged. Note seamless-loop wrapping is authored via keyframes (auto-wrap helper is deferred).
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): distortion warp offset run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** `distortion_offset` field + layout 304 (T1 §1,§2,§3) ✓; warp-field sampling offset in domain_warp/curl/turbulence, base unshifted (T1 §4) ✓; `ParamField` 3 variants keyframable (T1 §1) ✓; UI Warp Offset XYZ via anim_param, gated to noise-driven types (T2) ✓; default-0 no-op ✓; naga/tests ✓; no readback ✓.

**Type consistency:** `distortion_offset:[f32;3]` (T1) ↔ WGSL `distortion_offset_x/y/z` (T1 §3) read in `apply_distortion` (T1 §4); `ParamField::DistortionOffset{X,Y,Z}` (T1) used by get/set (T1) + `anim_param` UI rows (T2); `GpuLayer` 304 Rust ↔ WGSL.

**Placeholder scan:** all edits concrete against the current `apply_distortion` (quoted per-case); the only choice is scalars-vs-vec3 in the WGSL struct (T1 §3), constrained to keep byte layout + pass naga/layout test.
