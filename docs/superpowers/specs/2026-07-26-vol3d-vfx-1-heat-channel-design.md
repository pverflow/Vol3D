# Vol3D v2 · VFX-1 — Heat Channel, Emission Color & Colored Export

**Date:** 2026-07-26
**Status:** Approved design. Next: implementation plan (superpowers:writing-plans).
**Part of:** the animated colored VFX vertical (VFX-0 shipped → **VFX-1** → VFX-2).

## Goal

Give the volume a second **heat/emission** channel so fire reads physically: density drives opacity/shape, heat drives emission color. Author heat as **derived** from a per-layer **Temperature** (hot layers glow, cold layers stay dark). Then bake the colored result out for engines as RGBA8. Builds on VFX-0 (SDF shapes, color ramp, gradient editor, flipbook).

## Non-goals (VFX-1)

- No independent painted RGB tint field (that was the "full" option — deferred to a later slice if wanted).
- No fully-general per-layer channel routing UI — heat is derived from Temperature, not a separately-targeted field.
- No EXR / raw-RG / DDS export yet — VFX-1B ships **baked RGBA8** only (EXR/raw are follow-ups).
- No directional motion or lit scattering (VFX-2).
- Storage stays 8-bit per channel (RG8); float storage deferred.

## Settled decisions

1. **Volume becomes 2-channel RG8:** R = density (opacity/shape), G = heat (emission).
2. **Derived heat:** each layer has a `temperature`; heat accumulates as an emissive, density-weighted contribution during compositing (no independent heat field, no channel-routing UI).
3. **Emission color = colorRamp(heat)**; opacity = shaped density. Ramp OFF → current grayscale-density preview, unchanged.
4. **Export 1B = baked RGBA8** (emission RGB from ramp(heat) + density in alpha) via the existing sprite/slice/flipbook machinery.

## Design

### Data model — RG8 volume

`VolumeTexture` changes from `R8` to `RG8` (`gl.RG8` / `gl.RG` / `UNSIGNED_BYTE`), 2 bytes/voxel (512³ = 256 MB — acceptable, was 128 MB). R = density, G = heat. This is the cross-cutting change; touch points: `VolumeTexture` (format + upload), generation `layer_gen`/`composite` shaders (output `vec2`), `SliceBuffer` readback (2 channels; accumulators already RGBA16F so use RG of them), `VolumeGenerator` (2-channel readback + red/green extract), preview shaders (sample `.rg`), export (2-channel). Keep a **capability fallback** consistent with Phase A: RG8 as a color-renderable target is core WebGL2 — but verify framebuffer completeness at init and fall back / surface an error rather than render garbage.

### Authoring — per-layer Temperature (derived heat)

- Add `temperature: number` (0..1, default e.g. 0.0 = cold) to the layer noise/config; a **Temperature** slider in PropertiesPanel (all layer types).
- **Compositing math (v1, emissive-additive):** the layer-gen pass outputs the layer's scalar field `v` as today. The composite pass now maintains `vec2(density, heat)`:
  - Density channel: composited exactly as today (blend mode + opacity) — no behavior change to density.
  - Heat channel: accumulated **additively**, weighted by the layer's contributed density and its temperature:
    `heat_out = clamp(heat_in + layerContribution * u_temperature, 0.0, 1.0)`
    where `layerContribution` is the same density value the composite writes for this layer (post-opacity). Emission is additive by nature (light adds), so hot dense material glows brighter as it stacks. (Per-channel *blend-mode* semantics for heat are deliberately NOT applied in v1 — additive is predictable and correct for emission; refine later only if needed.)
- Result stored per voxel: R = final composited density, G = accumulated heat.

### Preview — emission model

- Opacity: shaped density (`applyDensityShaping(density, cutoff, contrast)`) — unchanged from VFX-0.
- Emission color: the color ramp's input switches from density to **heat** — `emission = rampColor(heat)` (RGB) with the ramp's alpha optionally modulating emission strength. Raymarch accumulates `emission * opacity` along the ray (front-to-back, as today).
- **Ramp OFF:** fall back to the exact current grayscale-density path (byte-identical) — heat simply unused. No regression when the ramp is disabled.
- Slice/projection preview: sample density for the plane view; apply ramp(heat) when enabled (consistent with raymarch).

### Phases (one spec, two plan-phases)

- **VFX-1A — heat channel + emission preview:** RG8 volume, Temperature slider, derived-heat compositing, heat-driven ramp emission in the three preview shaders, 2-channel readback for the animation cache. First visible win: real fire on screen (bright flame / dark smoke).
- **VFX-1B — baked RGBA8 colored export:** at export/flipbook time, bake per voxel/pixel `rgb = rampColor(heat)`, `a = shaped density` → RGBA8 sprite sheet / PNG slices / flipbook + metadata. Reuses `ExportManager`/`FlipbookExporter`; the existing R8/RGBA8/raw exports remain (density-only) for back-compat.

### Migration / validation

- `temperature` added to the layer schema (default cold); RG volume is internal (not serialized). Validate/clamp `temperature` 0..1, default on absent, via the Phase A `presetValidation`/`stateMigration` patterns. Bump `CURRENT_PRESET_VERSION`. Existing presets (no temperature) load as cold → identical density look, no emission until the user raises temperature + enables the ramp.

## Testing

- **Unit (pure TS):** derived-heat accumulation helper (given per-layer density contribution + temperature, the additive-clamped heat matches expected) — extract the formula as a pure fn mirrored in GLSL (like Phase A `SHADING_GLSL`). LUT/ramp already tested (VFX-0). Export bake mapping: `(heat,density) → rgba` (emission RGB = ramp(heat), a = shaped density) as a pure fn + test.
- **Manual smoke (GL/visual):** a flame-core layer (high temperature) + a smoke layer (low temperature) → flame glows via the fire ramp, smoke stays dark, decoupled from density; ramp OFF → grayscale density unchanged (no regression); existing density exports unchanged; VFX-1B baked RGBA8 sprite sheet + flipbook show the colored emission and drop into an engine as a colored volume texture. Verify via headless Playwright where feasible (per VFX-0 precedent).

## Success criteria

- Two-channel RG8 volume; density behavior identical to before; a new per-layer Temperature drives an emissive heat field.
- Fire reads correctly: hot layers emit (ramp color), cold dense layers are dark — decoupled.
- Ramp-off preview is byte-identical grayscale (no regression); existing exports unchanged.
- VFX-1B exports a baked RGBA8 colored volume (sprite/slices/flipbook) usable in Unreal/Unity.
- `npm run build` + `npm run test` green; zero `any`; web + Tauri both work.
