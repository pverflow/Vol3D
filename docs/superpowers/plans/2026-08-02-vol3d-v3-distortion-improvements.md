# Vol3D v3 — Distortion Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make distortion useful on all shapes. (1) A dedicated **warp-noise** field so domain_warp/curl/turbulence displace via a real noise (works on SDF/cone — root fix). (2) A **distortion rotation** (Euler XYZ) to orient swirl/polar on any axis. (3) A **Turbulence** type (multi-octave warp) reusing the noise library.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-distortion-improvements-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates.
- **`GpuLayer` append-only**: existing 0..224 offsets UNCHANGED; new fields appended; new size **288**; update `gpu_layer_std430_layout`.
- `distortion_type==None` MUST stay a strict no-op. No change to blend/animation/raymarch/noise/SDF math. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/layer.rs        # MOD: DistortionType+=Turbulence; LayerDesc += distortion_rotation/warp_noise/distortion_octaves; GpuLayer append drot0/1/2+warp_noise+octaves(+pad)=288; pack_layer; layout test
v3/shaders/generate.wgsl # MOD: GpuLayer struct (mirror 288, fix stale "size 208" comment); warp_field; rotation wrap + Turbulence case in apply_distortion
v3/src/app.rs          # MOD: Distortion UI — Turbulence entry, Warp-Noise combo, Octaves, Distortion-Rotation XYZ
```

---

## Task 1: Core — warp-noise field, rotation, turbulence (Rust + shader)

**Files:** `v3/src/layer.rs`, `v3/shaders/generate.wgsl`.

- [ ] **Step 1: Rust enum + fields** — `DistortionType += Turbulence = 5`. `LayerDesc` += `distortion_rotation: [f32;3]` (default `[0.0,0.0,0.0]`), `warp_noise: NoiseType` (default `NoiseType::Perlin`), `distortion_octaves: u32` (default `4`).
- [ ] **Step 2: GpuLayer layout (append-only)** — append `drot0`(224), `drot1`(240), `drot2`(256): `[f32;4]`; `warp_noise: u32`(272), `distortion_octaves: u32`(276), `_pad_di0: f32`(280), `_pad_di1: f32`(284) → **size 288**. `pack_layer`: `let [d0,d1,d2] = mat3_from_euler(rot_x.to_radians(), …)` from `distortion_rotation`; write drot0/1/2, `warp_noise as u32`, `distortion_octaves`, pads 0.0. Update `gpu_layer_std430_layout`: `size_of == 288` + assert offsets 224/240/256/272/276; keep all existing asserts. Add `DistortionType::Turbulence as u32 == 5` to a values test.
- [ ] **Step 3: WGSL struct** — mirror the appended fields in `generate.wgsl` `GpuLayer` (drot0/1/2 vec4, warp_noise u32, distortion_octaves u32, 2 pad) → 288. **Fix the stale `// size 208` doc comment on the struct → 288.**
- [ ] **Step 4: WGSL warp field + rotation + turbulence** —
  - `fn warp_field(L, p) -> f32 { return eval_base_noise(L.warp_noise, p, L.seed); }`. Replace domain_warp's + curl's warp-source calls (currently `base_noise_eval(L, ·)`) with `warp_field(L, ·)`. Retire `base_noise_eval` if now unused.
  - `apply_distortion(L, p)`: keep `None`/default as an early `return p;`. For the active cases: `let drot = mat3x3<f32>(L.drot0.xyz, L.drot1.xyz, L.drot2.xyz); var q = drot * p;` → run the effect on `q` (domain_warp/curl/swirl/polar as today, but on `q` and using `warp_field`) → `return transpose(drot) * q_result;`.
  - Add `case 5u` Turbulence: `if (L.distortion_strength < 0.001) { return p; }` then loop `o in 0..clamp(distortion_octaves,1,8)`: `wp = q*freq; off += (vec3(warp_field(L, wp+vec3(0.0,1.7,9.2)), warp_field(L, wp+vec3(8.3,2.8,4.1)), warp_field(L, wp+vec3(4.0,3.1,6.7))) - 0.5)*2.0*amp; freq *= 2.0; amp *= 0.5;` (freq init = `L.distortion_frequency`, amp init 1.0); `q = q + off * L.distortion_strength;`.
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): distortion warp-noise field + rotation + turbulence (works on SDF; orientable)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: UI

**Files:** `v3/src/app.rs`.

- [ ] **Step 1:** in the Distortion `CollapsingHeader`:
  - Type combo += **Turbulence**.
  - **Warp Noise** combo (Value/Perlin/Simplex/Worley/Voronoi/White → `warp_noise`), shown when type ∈ {DomainWarp, Curl, Turbulence}.
  - **Octaves** slider `1..=8` → `distortion_octaves`, shown when type == Turbulence.
  - **Distortion Rot X/Y/Z** (deg, `-180.0..=180.0`) → `distortion_rotation`, shown when type != None.
  - Every control routes through the existing `mark_dirty(ui.ctx())` path (match the current Distortion controls). No separate regen trigger.
- [ ] **Step 2: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Distortion UI — warp-noise, octaves, rotation, Turbulence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document: distortion now has a **Warp Noise** field (so Domain Warp/Curl/Turbulence work on SDF shapes like the cone), a **Distortion Rotation** (orient swirl/polar on any axis), and a new **Turbulence** type (multi-octave, with Octaves). Ask the user to report: domain_warp/curl now visibly warp a **cone**; rotation makes swirl/polar affect the cone; Turbulence looks like flowing turbulence; changing Warp Noise changes the character; None + existing scenes unchanged.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): distortion improvements run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** warp-noise field root-fix (T1 S4) ✓; distortion rotation drot + wrap (T1 S1,S2,S4) ✓; Turbulence type + octaves (T1 S1,S4) ✓; layout 288 append-only + test (T1 S2,S3) ✓; stale size comment fixed (T1 S3) ✓; UI (T2) ✓; None no-op (T1 S4 early return) ✓; naga/tests ✓; no readback ✓.

**Type consistency:** `DistortionType::Turbulence=5` (T1 S1) ↔ WGSL `case 5u` (T1 S4); `warp_noise`/`distortion_octaves`/drot packed (T1 S2) ↔ read by `warp_field`/rotation/turbulence (T1 S4); `GpuLayer` 288 Rust (T1 S2) ↔ WGSL (T1 S3); UI writes `LayerDesc` fields (T2) consumed by `pack_layer` (T1 S2).

**Placeholder scan:** turbulence offset vectors reuse domain_warp's (concrete); rotation reuses existing `mat3_from_euler`; warp_field reuses existing `eval_base_noise`. No placeholders.
