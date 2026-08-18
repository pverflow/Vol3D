# Vol3D v3 — Cycle ② Generation Port (vertical slice) — Design

**Date:** 2026-07-29
**Status:** Approved (user waived written-spec review — proceed straight to plan + build).
**Parent:** `docs/superpowers/specs/2026-07-27-vol3d-v3-native-web-wgpu-design.md`; builds on the cycle-① PoC (GPU-confirmed).

## Goal

Replace the PoC's throwaway sphere+noise generator with v2's real, layer-stack generation — ported to a WGSL **compute** shader — as a **vertical slice**: the full compute layer pipeline (blend modes, remap, per-layer color) with a starter noise set, so v3 renders real multi-layer colored volumes and the architecture is proven before the long-tail noise/SDF/distortion ports.

## Compute architecture

**Per-voxel, single dispatch, loop the layer stack** (the fast, GPU-idiomatic shape — matches the "speed" driver; no per-layer passes, no ping-pong 3D textures). Each compute invocation owns one voxel `(x,y,z)`:

1. `uvw = (gid + 0.5) / res`; start `density = 0`, `color = vec3(0)`.
2. For `i in 0..layer_count`: read `GpuLayer[i]`; transform the sample position (`rotation * (uvw * scale) + offset`); `v = noiseEval_<type>(pos)` (dispatch on the layer's noise-type enum via a WGSL switch); apply remap (linear remap → bezier remap curve → feather mask) and `invert`; `blended = applyBlend(blend_mode, density, v * opacity)`; `density = mix(density, blended, opacity)` (v2 composite semantics); composite the layer's ramp color painter's-over: `c = rampLUT(v, i); a = c.a * opacity; color = c.rgb*a + color*(1-a)`.
3. `textureStore(vol, gid, vec4(color, density))`.

This reproduces v2's `composite.frag` + `layer_gen.frag` semantics restructured for compute.

## Data model

- **Layer stack → a storage buffer** of fixed-layout `GpuLayer` structs + a `layer_count` uniform (+ `res`, `globalSeed`, `animPhase`, `animEvolutions` in a small params uniform). `GpuLayer` fields (reserving the deferred ones): `noise_type: u32`, `blend_mode: u32`, `invert: u32`, `worley_mode: u32`; `scale: vec3`, `offset: vec3`, `rotation: mat3x3` (precomputed CPU-side from euler via `mat3FromEuler`), `amplitude: f32`, `seed: f32`, `opacity: f32`; remap: `in_min/in_max/out_min/out_max: f32`, `remap_curve: vec4` (cubic-bezier ctrl pts), `feather: vec3`, `feather_shape: u32`, `feather_curve: vec4`; sdf: `sdf_radius/softness/height: f32`; fbm: `octaves: u32`, `persistence/lacunarity: f32`, `fbm_base: u32`; `distortion_type: u32` (only `none` wired this slice) + reserved distortion params.
- **Per-layer color ramps → one `256×N` RGBA8 LUT texture** (row `i` = layer `i`'s ramp), built CPU-side from each `ColorRamp` (reuse v2's `buildRampLUT` logic, ported to Rust) and uploaded once per generation. Sampled `textureLoad/textureSampleLevel(lut, vec2(v, (i+0.5)/N))`.
- **Raymarch pass unchanged** (already samples the `rgba8` volume `[color, density]`).

## Scope

**In this slice:**
- Full per-voxel layer-loop compute pipeline + the storage-buffer layer model + `256×N` ramp LUT.
- **All 7 blend modes** (port `src/shaders/common/blend_modes.glsl`: normal/add/multiply/screen/overlay/subtract/smooth_min + `applyBlend`).
- **Remap** — linear `remap`, cubic-bezier remap curve (`cubicBezierPoint`/`evaluateBezierCurve`/`applyRemapCurve`), and **feather** (box + sphere, per-axis, bezier feather curve) — port from `src/shaders/generation/layer_gen.frag.glsl`.
- **Per-layer color ramps** (the `256×N` LUT + painter's-over composite).
- **Starter noise set:** port `src/shaders/noise/{perlin3d,simplex3d,fbm,sdf_sphere,value3d}.glsl` (+ their support `src/shaders/common/{hash,math_utils}.glsl`) to WGSL. Each exposes a `noiseEval_<type>(pos, layer)`-style fn.

**Deferred (follow-on cycles/tasks — same pattern, mechanical):** remaining noise (`worley3d`, `voronoi3d`, `white3d`), remaining SDF/flame (`sdf_{box,cone,plume,capsule,cylinder}`), the 4 distortions (`distortion/{domain_warp,curl,swirl,polar}`). `GpuLayer` reserves their enum values + params; the WGSL switch falls back to a safe default (e.g. Value) for not-yet-ported types, and only `distortion_type == none` is applied.

## Test UI (throwaway — cycle ③ builds the real one)

No interactive layers/properties panel yet. Instead: a **hardcoded demo scene** of ~3 layers (e.g. an FBM cloud × a Perlin detail (multiply), masked by an `SdfSphere`, each with a distinct ramp — fire/smoke/ice) built in Rust, driving the storage buffer + LUT. Keep 2-3 global sliders (from the PoC panel) repurposed to prove reactivity (e.g. a global scale, the sphere mask radius, a seed). The interactive layer/property/gradient UI is **cycle ③**.

## Interaction with existing code

- Replaces `VolumeGen`'s PoC compute (`generate.wgsl` sphere+noise) with the layer-stack generation; the texture/format (`rgba8unorm`, D3, STORAGE|TEXTURE) and the whole raymarch/egui-embed path stay as cycle ①.
- wgpu `=29.0.4`, egui/eframe/egui-wgpu `=0.35.0`, all under `v3/`. Native + WebGPU web from one codebase (both `cargo check` gates stay green).

## Testing

- **Unit (Rust, in-sandbox):** `GpuLayer` **std430 size + field offsets** match the WGSL struct (the CamUniform-class landmine — mandatory test); `mat3FromEuler` (port + test vs known rotations); cubic-bezier point eval (if computed CPU-side for any validation); `256×N` ramp-LUT byte layout (row `i` = layer `i`'s stops).
- **Shader:** `naga` validates the generation WGSL (parse + type-check, no GPU).
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **Visual parity vs v2:** the user's GPU run — build the same demo scene concept in v2 and compare the look. (No GPU in-sandbox.)

## Success criteria

- v3 generates a **real multi-layer colored volume** via a compute shader (layer stack from a storage buffer, all 7 blend modes, remap+feather+bezier, per-layer ramps, starter noise set), rendered by the unchanged raymarch, native + WebGPU, zero readback.
- `GpuLayer` layout test + WGSL naga validation + both `cargo check` + clippy + unit tests green.
- The deferred noise/SDF/distortion have reserved slots and a safe fallback — adding them later is localized to the WGSL switch + Rust enum.

## Risks

- **std430 layout of `GpuLayer`** — `mat3x3` in WGSL is 3× `vec4`-aligned columns (48 bytes, not 36); `vec3` aligns to 16. The Rust struct must pad to match exactly, guarded by the size/offset test. Highest-risk item.
- **WGSL noise ports** — GLSL→WGSL differences (no implicit int/float, explicit `let`/`var`, array syntax, `textureLoad` vs `texture`). Port from the authoritative v2 GLSL files; `naga` catches type errors; final correctness is the user's GPU run.
- **Big compile-only diff** before a GPU run (inherent to the slice choice) — mitigated by porting from known-correct v2 GLSL + naga validation + the unit-tested CPU layout.
- Large WGSL switch over noise types — acceptable; not-yet-ported types fall back safely.

## Deferred / future

Remaining noise + SDF/flame + distortions (follow-on); interactive UI (cycle ③); animation + sparse cache (cycle ④); export (⑤); packaging (⑥).
