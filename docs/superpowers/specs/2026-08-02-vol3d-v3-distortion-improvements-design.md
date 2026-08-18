# Vol3D v3 — Distortion Improvements: warp-noise field + rotation + turbulence — Design

**Date:** 2026-08-02
**Status:** Approved (user feedback on the shipped distortion: "most have no effect on a cone — distortion only goes in one direction; add rotation; add a turbulence field reusing the noises we have").
**Parent:** Cycle B (distortion). Iterates on `apply_distortion` in `generate.wgsl` + `layer.rs`/`app.rs`.

## Root cause (systematic-debug)

domain_warp/curl currently drive their warp from `base_noise_eval(L,p)` = `eval_noise(L,p)` — i.e. the **layer's own field**. For an SDF layer (cone), that field is flat (0 outside the shape, 1 inside) → **zero gradient → ~zero displacement** → "no effect." Swirl/polar are separately axis-locked (Y / XY-plane), so on a Y-symmetric cone they do nothing visible. Both are real limitations, not bugs in the ports.

## Fixes

1. **Dedicated warp-noise field** (`warp_noise: NoiseType`, default **Perlin**): domain_warp / curl / turbulence sample `eval_base_noise(L.warp_noise, p, L.seed)` (a real periodic noise) instead of the layer's own field. Restricted to the non-fbm/non-sdf noises (Value/Perlin/Simplex/Worley/Voronoi/White) — the exact set `eval_base_noise` already handles → **efficient reuse of the existing noise library.** Root fix for "no effect on SDF/cone."
2. **Distortion rotation** (`distortion_rotation: [f32;3]` Euler deg → CPU mat3 via existing `mat3_from_euler`, packed as `drot0/1/2`): `apply_distortion` rotates `p` into the distortion frame (`drot*p`), applies the effect, rotates back (`transpose(drot)*·`). Reorients swirl/polar (and the warp) onto any axis — the "distortion only goes in one direction" fix.
3. **Turbulence** (`DistortionType::Turbulence = 5`, `distortion_octaves: u32`): multi-octave domain warp = sum of `distortion_octaves` noise displacements at doubling frequency / halving amplitude, using `warp_noise`. A richer flow field than single-octave domain_warp, reusing the same noise.

## GpuLayer layout (append-only — keep existing 0..224 offsets)

Current size 224. **Append** (existing offsets unchanged → minimal churn):
- `drot0`(224), `drot1`(240), `drot2`(256) — `[f32;4]` each (16-aligned; 224 is a 16-multiple).
- `warp_noise: u32`(272), `distortion_octaves: u32`(276), `_pad_di0`(280), `_pad_di1`(284) → **size 288**.

Mirror in the WGSL `GpuLayer` struct (same order); update `pack_layer` (`distortion_rotation` → `mat3_from_euler(.to_radians())` → drot0/1/2; `warp_noise as u32`; `distortion_octaves`) and the `gpu_layer_std430_layout` test (size 288 + the new offsets; keep all existing asserts). **Also fix the stale `// size 208` doc comment on the WGSL struct (now 288)** (parked minor from Cycle B).

## Rust

- `DistortionType` += `Turbulence = 5`.
- `LayerDesc`: `distortion_rotation: [f32;3]` (default `[0,0,0]`), `warp_noise: NoiseType` (default `Perlin`), `distortion_octaves: u32` (default `4`).
- `NoiseType` may need a helper to list the warp-eligible set (non-fbm, non-sdf) for the UI combo — reuse `is_sdf()` + exclude `Fbm`.

## WGSL

- Replace domain_warp/curl's `base_noise_eval(L, ·)` calls with `warp_field(L, p) = eval_base_noise(L.warp_noise, p, L.seed)`. (Drop/retire `base_noise_eval` if now unused, or keep — reviewer's call.)
- `apply_distortion(L, p)`:
  - `let drot = mat3x3(L.drot0.xyz, L.drot1.xyz, L.drot2.xyz); var q = drot * p;` then the per-type effect on `q`, then `return transpose(drot) * q_out;`. `None` stays a strict early no-op (`return p;` before any drot math).
  - Add `case 5u` (Turbulence): loop `distortion_octaves` (clamp 1..8), `freq = distortion_frequency`, `amp = 1.0`; each octave `wp = q*freq; off += (vec3(warp_field(wp+o1), warp_field(wp+o2), warp_field(wp+o3)) - 0.5)*2.0*amp; freq *= 2.0; amp *= 0.5;` then `q = q + off * distortion_strength;` (reuse domain_warp's offset vectors o1/o2/o3). `<0.001` strength early-out like the others.

## UI (`app.rs` Distortion section)

- Type combo += **Turbulence**.
- **Warp Noise** combo (Value/Perlin/Simplex/Worley/Voronoi/White) — shown for DomainWarp / Curl / Turbulence.
- **Octaves** slider (1..=8) — shown for Turbulence.
- **Distortion Rotation** X/Y/Z (deg, e.g. −180..180) — shown when type != None (helps swirl/polar most).
- All via the shared `mark_dirty` edit path.

## Scope

**In:** warp-noise field (root fix), distortion rotation, Turbulence type + octaves; struct/layout (288) + WGSL + UI; fix the stale size comment.
**Out:** export (Cycle C), presets (Cycle D). No change to blend/animation/raymarch/noise/SDF math.

## Testing

- **Unit (Rust):** `DistortionType::Turbulence == 5`; `GpuLayer` size 288 + new offsets (224/240/256/272/276); `pack_layer` writes drot (rotation), warp_noise, octaves; existing offsets unchanged.
- **Shader:** `naga shaders/generate.wgsl` validates (warp_field, rotation wrap, turbulence loop).
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** domain_warp/curl now visibly warp a **cone/SDF** (via the noise field); distortion rotation reorients swirl/polar so they affect a Y-aligned cone; Turbulence gives a richer flow; warp-noise choice changes the warp character; None + existing scenes unchanged.

## Success criteria

- domain_warp/curl visibly affect SDF shapes (warp-noise field); swirl/polar orientable via rotation; Turbulence works; warp-noise + octaves authorable; None no-op; layout consistent (288) Rust↔WGSL; gates green; no regression.

## Risks

- **Layout drift** (288, Rust↔WGSL) — layout test + naga guard; reviewer verifies offsets. Append-only keeps existing offsets stable.
- **transpose(drot)** — for a pure rotation matrix, transpose == inverse; confirm `mat3_from_euler` yields orthonormal columns (it does — composed rotations).
- **Turbulence cost** — `octaves × 3` noise taps per voxel during generation (one-time, not raymarch); clamp octaves ≤ 8.
- **warp_field on fbm/sdf index** — UI restricts warp_noise to the 6 valid noises; `eval_base_noise` defaults unknown → value, so a stray value is safe.
