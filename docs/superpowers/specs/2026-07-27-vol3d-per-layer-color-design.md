# Vol3D — Per-Layer Color (independent shape + color) — Design

**Date:** 2026-07-27
**Status:** Approved direction; design for review. Next: implementation plan (superpowers:writing-plans).
**Driver:** Multi-layer scenes (add/subtract to build complex shapes) can't be colored independently. The current model stores one global `heat` scalar and applies one global color ramp, so every layer fights over a single gradient — colors smear. Users need a color per layer.

## Goal

Each layer carries its **own color ramp**, mapping that layer's own value to color, independent of every other layer. Shape (density) compositing is **unchanged** — subtract still carves, add still builds. Color is a second, independent channel that rides alongside density. WebGL2, all platforms (browser + every Tauri webview).

## The decision (settled with the user)

- **Per-layer gradient**, not a flat per-layer color or a global-ramp tint. Each layer maps its own generated value (0..1) through its own `ColorRamp`.
- **Separate shape + color**: the density/blend-mode pipeline stays byte-identical to today (shape = alpha). Color accumulates independently, painter's-"over", in layer order, regardless of a layer's blend mode.
- The "color of a carved region" ambiguity is moot: preview opacity comes from density, so where a subtract layer carves density to 0 the voxel is invisible regardless of its stored color.

## Model

### Storage: RG8 → RGBA8
Per voxel: `[colorR, colorG, colorB, density]`. The single global `heat` channel is removed. Color is stored per voxel; density (shape) is the alpha channel. 2 bytes/voxel → 4 bytes/voxel.

### Per-layer color ramp
Each `Layer` gains a `colorRamp: ColorRamp` (the existing `ColorRamp` type — reuse the type and the editor component). This **replaces** both:
- the global `preview.colorRamp` (removed), and
- the per-layer `noise.temperature` (removed).

### Generation (composite pass) — two independent accumulations
Accumulator (`SliceBuffer`, RGBA16F) holds `[colorR, colorG, colorB, density]`. For each layer, given the layer's own generated value `v = u_layerOutput.r`:

1. **Density (shape) — unchanged math**, operating on the alpha channel:
   `base = accum.a; blended = applyBlend(u_blendMode, base, v); density = mix(base, blended, u_opacity)` → new `.a`.
2. **Color — painter's "over"**, independent of blend mode:
   `vec4 c = layerRamp(v); float a = c.a * u_opacity; rgb = c.rgb * a + accum.rgb * (1.0 - a)` → new `.rgb`.

Output `vec4(rgb, density)`. A layer whose ramp is transparent at `v` deposits no color but still carves/builds density — the same "temperature-0 on a subtract layer" trick users already discovered, now explicit and per-position.

`layerRamp(v)` samples a **per-layer LUT texture** (256×1 RGBA8, built via the existing `buildRampLUT`) bound before that layer's composite pass. LUTs depend only on `layer.colorRamp`, so build one LUT per active layer once at `generate()` start and reuse it across all slices (not per-slice).

### Preview (raymarch / slice / projection)
Sample the stored `vec4`: `density = .a`, `color = .rgb`. Opacity = the existing density shaping (cutoff/contrast/`u_density`) applied to `.a` — unchanged. Emission = `color.rgb` (× an emission gain). Remove the global-ramp lookup and the `u_colorRamp*`/heat uniforms. Keep a small density-based ambient so a dense-but-uncolored voxel (transparent ramp) reads as faint smoke rather than pure black. No global ramp toggle — color is always the stored RGB.

### Sparse cache — same machinery, RGBA8
The sparse brick cache (reduced-res bake, cross-frame dedup, dedicated budget) carries over unchanged in structure; only the per-voxel format widens to 4 bytes:
- `constants`: brick byte size reflects 4 bytes/voxel (`BRICK³ × 4`).
- `BrickCache.computeMaxBricks`: uses 4 bytes/voxel → fewer bricks fit the same budget → the reduced-res helper (`bakePlaybackResolution`) automatically picks a slightly lower bake res so the full loop still fits (512³ bakes ~one res-step lower than the RG8 192³).
- `BrickCache` atlas 3D texture: RG8 → RGBA8.
- `brickPack`: `AtlasBuilder` brick byte length 2→4; `packFrame` **active-brick threshold tests density (the `.a` channel)** only (color with no density is invisible); `reconstruct` round-trips 4 bytes; dedup hash over 4-byte bricks (same logic, wider stride).
- `sampleSparse` GLSL: returns `vec4(rgb, density)` instead of `vec2(density, heat)`; preview shaders consume it identically to the dense sample.

### Export
The volume is now RGBA8 color, so export is natively colored:
- Single-volume export (`ExportManager`): export the RGBA8 color volume (density in alpha).
- Flipbook export (`FlipbookExporter`): already renders the colored raymarch preview — unchanged in approach, now correct by construction. This folds in the previously-parked "baked RGBA8 colored export" (VFX-1 Task 4).

### UI
- `PropertiesPanel`: a per-layer `ColorRamp` editor (reuse the existing ramp editor component used today for the global preview ramp). Remove the per-layer temperature slider.
- Remove the global preview color-ramp control.
- `LayerPanel`: optional small color swatch preview per layer (nice-to-have, not required).

## Interaction with existing systems
- **Density/shape** (blend modes, remap, SDF/flame shapes, drag proxy, animation): unchanged.
- **Phase A direct-to-3D generation**: unchanged in structure; the final composite now writes RGBA8 and the per-layer LUT is bound in the composite pass.
- **Sparse cache** (reduced-res bake + dedup + budget): unchanged in structure, RGBA8 format.
- **Presets / migration**: old presets have no per-layer `colorRamp` and a `temperature` field. On load, a layer missing `colorRamp` defaults to the Fire ramp (so existing scenes still look like fire); `temperature` is ignored. Backward-compatible default, no hard version break required.

## Non-goals (this build)
- No global master tint/grade on top of per-layer color (exposure already exists).
- No per-layer *blend mode for color* — color is always painter's "over". (Blend modes stay density-only.)
- No change to the density/shape math, remap, SDF, or animation.
- No WebGPU/native, no BC/ASTC, no temporal interpolation (separate deferred bets).
- Playback smoothness work (render-proxy during motion / interpolation) is separate and deferred.

## Testing
- **Unit (pure TS):** `brickPack` round-trip with 4-byte RGBA8 bricks (pack → reconstruct == original within active bricks); active-brick threshold on the density channel; cross-frame dedup on 4-byte bricks; `bakePlaybackResolution` still returns a res whose full loop fits with the 4-byte brick size. `buildRampLUT` unchanged.
- **Visual/GL smoke (real-GPU Playwright, per precedent, scratch install, port 5174 only):** two layers with different ramps (e.g. blue + orange) both render with their own colors and mix correctly where they overlap; a subtract layer carves a hole (invisible) without recoloring the rest; a transparent-ramp layer deposits no color but still shapes; sparse playback is visually consistent with the dense render (RGBA parity); export produces a colored result.

## Success criteria
- Each layer has an independent color ramp; multi-layer add/subtract scenes render distinct, non-smeared colors.
- Density/shape behavior is unchanged from today.
- Sparse cache + reduced-res playback + export all work in RGBA8; the full loop still bakes (at a slightly lower res at 512³).
- `npm run build` + `npm run test` green; zero `any`; no `as never`; web + Tauri both work.

## Rough decomposition (for the plan, not binding)
1. Types + storage + generation color pipeline (RGBA8, per-layer LUT, composite shader) + preview shaders.
2. Sparse cache RGBA8 (brickPack, BrickCache, sparseSample, constants, reduced-res helper).
3. UI (per-layer ramp editor; remove temperature + global ramp) + preset migration default.
4. Export colored (single-volume + confirm flipbook) — folds in VFX-1 Task 4.

## Deferred / future (noted, not built)
- Playback smoothness: render-proxy during motion (raymarch at lower canvas scale / fewer steps while playing, crisp on pause) and/or temporal interpolation for more perceived frames.
- Brick apron / LINEAR atlas to reduce sparse blockiness.
- On-disk gzip of the saved cache.
