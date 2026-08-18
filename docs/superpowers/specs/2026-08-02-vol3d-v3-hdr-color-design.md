# Vol3D v3 — HDR Color (float volume + emission + tonemap) — Design

**Date:** 2026-08-02
**Status:** Approved (user: colors should represent HDR — fire is bright).
**Parent:** volume storage + generation color + the raymarch.

## Problem

Color is baked into an **RGBA8** volume (0–1), so bright/emissive fire clips at white. The raymarch does a plain gamma (`pow(acc, 0.4545)`) with no tonemap, so any accumulation >1 hard-clips.

## Fix (three parts)

1. **Float HDR volume:** the volume texture becomes **`Rgba16Float`** (8 bytes/voxel) so color+emission can exceed 1. `Rgba16Float` is a core-WebGPU storage format (write-capable) and filterable (LINEAR sampling works) — same pattern as the R32Float occupancy. The occupancy pass (reads `.a` density, still 0–1) is unchanged; the raymarch sampler/bindings are unchanged (`texture_3d<f32>` + filterable float).
2. **Per-layer emission:** a per-layer `emission: f32` (default `1.0`) that **scales the baked color** — `stored_rgb = ramp_rgb * emission` — so a fire layer stores bright HDR color (density `.a` unchanged). Emission > 1 is the HDR headroom.
3. **Exposure + filmic tonemap:** the raymarch accumulates HDR color, then applies **exposure × ACES tonemap** before gamma, so values >1 roll off instead of clipping. A global `exposure: f32` (default `1.0`) on the camera uniform.

## VRAM / byte-math (RGBA16F = 8 bytes/voxel)

Every `×4` bytes-per-voxel becomes `×8`. Introduce `const BYTES_PER_VOXEL: u64 = 8;` in `anim.rs` and use it in `playback_bake_dims` (`n * product * BYTES_PER_VOXEL ≤ budget`) and `max_loop_frames` (`budget / (64³ * BYTES_PER_VOXEL)` → 4 GB → 2048). The app's VRAM readout (`product * 4`) → `* 8`. So the fps cache fits ~half as many full-res frames (documented); `playback_bake_dims` reduces per-axis as before.

## WGSL (`generate.wgsl`, `raymarch.wgsl`)

- `generate.wgsl`: `@binding(0) var vol: texture_storage_3d<rgba8unorm, write>` → `<rgba16float, write>`. Where the final color is composed, multiply by emission: `let out_rgb = color * L_emission;` (the per-layer emission for the layer that contributed — apply per layer during the composite, matching how per-layer color composites today; or if color is a single composited result, scale each layer's ramp color by its `emission` before compositing). `textureStore(vol, gid, vec4(out_rgb, density))` (density unchanged). At `emission == 1.0` → identical color to today (just float-stored).
- `raymarch.wgsl`: add `fn aces(x: vec3<f32>) -> vec3<f32>` (Narkowicz: `clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0, 1)`). Change `var col = pow(acc, vec3<f32>(0.4545));` → `var col = pow(aces(acc * C.exposure), vec3<f32>(0.4545));`. The wireframe overlay block after it is unchanged. `Cam` struct gains `exposure: f32`.

## Layout

- `GpuLayer`: reuse a trailing pad for `emission: f32` (currently `warp_loop:u32`@292 + `_pad_do:[f32;2]`@296/300 — take 296 → `emission`, `_pad_do:[f32;1]`@300). **Size stays 304.** `pack_layer` writes it; layout test @296.
- `CamUniform`: reuse `_pad1`@104 (after `wire_alpha`@100) for `exposure: f32`. **Size stays 112.** `basis()` sets `exposure = 1.0` (NOT 0 — 0 would render black). WGSL `Cam` mirrors.

## Rust / UI / serde

- `LayerDesc.emission: f32` (default `1.0`), `#[serde(default = "…")]` (default 1.0) so **old saved scenes without the field still load**. UI: an **Emission** `DragValue` (0..=16, speed 0.05) per layer (near the Color/ramp section) — keyframable via `anim_param` + `ParamField::Emission` (fire brightness is worth animating).
- `Vol3dApp.exposure: f32` (default `1.0`); UI: an **Exposure** slider (top bar or animation panel, 0.1..=4). Add `exposure` to `SceneFile` (`#[serde(default)]` → default 1.0 via `SceneFile::default`) + `to_scene`/`apply_scene`.

## Scope

**In:** RGBA16F volume + byte-math; per-layer `emission` (keyframable) scaling the baked color; global `exposure` + ACES tonemap; UI + serde for both.
**Out:** ramp editor accepting >1 colors directly (emission scalar covers it); bloom; per-tonemap-operator choice (ACES fixed); HDR export (later).

## Expected appearance change (honest note)

An HDR pipeline **tonemaps everything** — the 8-bit output can't preserve LDR exactly *and* roll off HDR. So existing (LDR) scenes look slightly more filmic (a full-white pixel maps to ~0.80 at exposure 1). This is inherent to HDR; **Exposure** compensates. `emission == 1` + `exposure == 1` still stores the same colors, just tonemapped on output. Document it; the user tunes exposure.

## Testing

- **Unit (Rust):** `GpuLayer` size 304 + `emission`@296; `CamUniform` 112 + `exposure`@104; `playback_bake_dims`/`max_loop_frames` with `BYTES_PER_VOXEL=8` (e.g. `max_loop_frames(4 GB)==2048`); `LayerDesc` with a missing-`emission` JSON deserializes (serde default 1.0); `SceneFile` exposure round-trips.
- **Shader:** `naga` validates generate (rgba16float storage) + raymarch (aces + exposure).
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** a fire layer with high **Emission** looks bright/emissive without clipping to flat white (highlights roll off); **Exposure** brightens/darkens the whole render; a plain scene at emission 1/exposure 1 looks like before but slightly filmic; playback still works (cache fits fewer frames at 16F — readout shows the larger MB/frame); saved scenes (pre-HDR) still load (emission defaults to 1).

## Success criteria

- HDR volume (RGBA16F); per-layer emission (keyframable) + global exposure + ACES tonemap; bright fire rolls off instead of clipping; byte-math updated (cache VRAM correct); old saves load (emission/exposure default 1); both `cargo check` + naga + clippy + tests green; no crash.

## Risks

- **Rgba16Float storage support** — core WebGPU + native both support it; `cargo check` + naga gate the declaration; user GPU run confirms it renders (if a browser rejects it, fall back is rgba32float, larger).
- **Byte-math** — a missed `×4` leaves the cache thinking frames are half-size → over-allocation; update all live spots + the readout; unit-test `max_loop_frames`.
- **Appearance shift** — documented; exposure compensates; not a regression, an HDR consequence.
- **serde backward-compat** — new `emission`/`exposure` fields need serde defaults so the user's just-saved scene still loads.
