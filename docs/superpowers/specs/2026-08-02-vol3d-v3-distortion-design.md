# Vol3D v3 — Domain Distortion (warp / curl / swirl / polar) — Design

**Date:** 2026-08-02
**Status:** Approved (user: close v2 gap top-down; Cycle B = distortion). Cycle A (noise+SDF) shipped + GPU-confirmed.
**Parent:** v3 `generate.wgsl` sampling path (`sample_noise_at`) + `layer.rs` `GpuLayer`/`LayerDesc` + `app.rs` properties panel.

## Goal

v2 parity for per-layer **domain distortion** — warps the sample position before noise eval. Types (v2 `DistortionType`): **None, DomainWarp, Curl, Swirl, Polar**. Wires the currently-dead `distortion_type` field + adds the 3 params it needs.

v3's `sample_noise_at` already has the exact hook: `// TODO(distortion, out of scope this cycle): applyDistortion(p)` immediately before `return eval_noise(L, p);` — v2 applies `applyDistortion(p)` at that same spot (`layer_gen.frag.glsl:63`, after the SDF/non-SDF branch, so it applies to **both**). This cycle fills that TODO.

## Algorithms (port verbatim from v2 `src/shaders/distortion/*.glsl`)

`u_warpStrength = distortion_strength`, `u_warpFrequency = distortion_frequency`, `u_swirlAmount = distortion_swirl`. `_baseNoiseEval` = the layer's base noise (see below). `TAU = 6.28318`.

- **DomainWarp** (`domain_warp.glsl`): `if s<0.001 return p; wp = p*freq; warp = (vec3(base(wp+(0,1.7,9.2)), base(wp+(8.3,2.8,4.1)), base(wp+(4.0,3.1,6.7))) - 0.5)*2*s; return p + warp;`
- **Curl** (`curl.glsl`): `if s<0.001 return p;` central-difference curl of `base` with `eps=0.01`, `curl = vec3((n4-n3-n6+n5), (n5-n6-n2+n1), (n2-n1-n3+n4)) / (2*eps)`; `return p + curl*s;` (n1..n6 = base at ±eps on x,y,z per the v2 file — copy exactly).
- **Swirl** (`swirl.glsl`): `angle = p.y*swirl*s*TAU; x = p.x*cos-p.z*sin; z = p.x*sin+p.z*cos; return vec3(x, p.y, z);` (no strength cutoff — always applies).
- **Polar** (`polar.glsl`): `if s<0.001 return p; c = p.xy-0.5; radius = length(c)*2; angle = atan2(c.y,c.x)/TAU + 0.5; return mix(p, vec3(angle, radius, p.z), s);`

**`base_noise_eval(L, p)`** (v3 analog of v2's `_baseNoiseEval`, non-recursive — `eval_noise`/`eval_base_noise` never call `apply_distortion`):
- `L.noise_type == Fbm(3u)` → `eval_base_noise(L.fbm_base, p, L.seed)`
- else → `eval_noise(L, p)` (the layer's own noise/sdf).

## GpuLayer layout change

Append 3 `f32` after `distortion_type` (currently the last scalar at offset 204, struct = 208):
`distortion_strength`(208), `distortion_frequency`(212), `distortion_swirl`(216), `_pad_distort`(220) → **size 224** (14×16). Mirror in the WGSL `GpuLayer` struct; update `pack_layer` + the `gpu_layer_std430_layout` test (size 224 + new offsets). `distortion_type` (u32) already exists.

## Rust

- New `enum DistortionType { None=0, DomainWarp=1, Curl=2, Swirl=3, Polar=4 }` (`repr(u32)`, like `NoiseType`/`BlendMode`). `LayerDesc.distortion_type: DistortionType` (currently the packed `GpuLayer.distortion_type` u32 has no ergonomic Rust source — add it) + `distortion_strength/frequency/swirl: f32`. Defaults from v2 `src/state/AppState.ts` `defaultLayer()` distortion block (read them; fallback strength 0.5, frequency 2.0, swirl 1.0).
- `pack_layer` writes the 3 params + `distortion_type as u32`.

## WGSL

- `base_noise_eval(L, p)` + `apply_distortion(L, p) -> vec3<f32>` (switch on `L.distortion_type`, default → p).
- Replace the `// TODO(distortion…)` line in `sample_noise_at` with `p = apply_distortion(L, p);` (before `eval_noise`). Applies to SDF + non-SDF exactly as v2. Because it's inside `sample_noise_at`, it runs per tiled sample (matches v2, whose `applyDistortion` lives in `sampleNoiseAtVolumePos`, called by the 8-tap tileable blend).

## UI (`app.rs` properties panel)

New **Distortion** `CollapsingHeader`: type combo (None/Domain Warp/Curl/Swirl/Polar); **Strength** slider (0–2); **Warp Freq** (domain_warp only, 0.5–10); **Swirl Amt** (swirl only, −5..5). Any change is a layer edit → existing `mark_dirty` path (sets `cache_stale`, triggers regen). Match v2 `PropertiesPanel.buildDistortionSection` gating.

## Scope

**In:** `DistortionType` enum + 3 params (struct+WGSL+pack+layout test); `apply_distortion` + `base_noise_eval` in WGSL wired at the existing hook; UI Distortion section; wire the dead `distortion_type`.
**Out / deferred:** `warpOctaves` (dead in v2 too — skip); feather/remap-curve UI (Medium tier); export (Cycle C); presets (Cycle D). No change to blend/compositing/animation/raymarch/fps-cache.

## Testing

- **Unit (Rust):** `DistortionType` values 0..4; `GpuLayer` size 224 + new offsets; `pack_layer` carries the 3 params + type.
- **Shader:** `naga shaders/generate.wgsl` validates with `apply_distortion`/`base_noise_eval` + the hook.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** each distortion visibly warps a noise layer (domain warp = wobble; curl = swirling flow; swirl = twist along Y; polar = radial remap); strength scales it; frequency (warp) + swirl-amount (swirl) affect their types; None = unchanged; existing scenes with type=None look identical to before.

## Success criteria

- All 4 distortion types apply to the sample position and are UI-authorable; `distortion_type` dead field fixed; type=None is a no-op (existing scenes unchanged); `GpuLayer` layout consistent Rust↔WGSL (224); both `cargo check` + naga + clippy + tests green; no regression.

## Risks

- **Layout drift** (Rust vs WGSL struct at 224) — the layout test + `naga` guard it; reviewer checks offsets.
- **Port fidelity** — copy the 4 GLSL files line-by-line (esp. curl's index pattern + swirl's no-cutoff).
- **Recursion** — `base_noise_eval` must call `eval_noise`/`eval_base_noise` (which never call `apply_distortion`), not re-enter `sample_noise_at`. Reviewer confirms.
- **base_noise for SDF layers** — v2 warps SDF by its own field; v3 mirrors (`eval_noise(L,p)` for the SDF). Acceptable; SDF+distortion is a niche combo.
