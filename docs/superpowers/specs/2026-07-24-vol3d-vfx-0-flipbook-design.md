# Vol3D v2 · VFX-0 — Colored Animated Flipbook

**Date:** 2026-07-24
**Status:** Approved design. Next: implementation plan (superpowers:writing-plans).
**Part of:** the "animated colored SDF VFX" vertical (VFX-0 → VFX-1 → VFX-2). This is the first slice.

## Goal

Author an SDF-based shape, erode/animate it with the existing noise + loop system, color it through a gradient ramp, and bake the result to a **rendered flipbook** (sprite sheet + PNG sequence). Fire / smoke / explosion, end to end, built on top of v2 Phase A. Single-channel density + preview-time color; no multi-channel storage.

## Vision context (later slices, NOT this spec)

- **VFX-1:** real multi-channel volume (density + heat + RGB tint), colored *volume-data* export (EXR/RGBA slices/DDS).
- **VFX-2:** directional motion (fire rises, explosion expands), lit/scattered raymarch, more shapes, physical blackbody ramp.

## Non-goals for VFX-0

- No multi-channel / RGB / heat storage (density only; color is a preview-time ramp on density).
- No directional/advected motion — reuse existing loop-phase + noise-evolution.
- No lit/scattering raymarch changes beyond applying color.
- No colored *volume-data* export — the new export is the *rendered* flipbook only. Existing slice/raw exports stay as-is.

## Settled decisions

1. **SDF shapes ride the existing source/snippet system** (not a new layer kind). Minimal plumbing, fully composable with noise layers.
2. **Color ramp maps density → color+alpha** at preview/bake time (non-destructive, like Phase A cutoff/contrast). A separate heat field is VFX-1.
3. **Flipbook bakes the current viewport camera view** (WYSIWYG).

## Design

### 1. SDF primitive layers (source functions)

Add SDF shapes as new **source types** handled by the same snippet-injection mechanism that drives noise (`ShaderCompiler` `NOISE_SNIPPETS` + the data-driven map from Phase A Task 7). Each SDF source provides a `float noiseEval(vec3 p)` that returns a smooth 0..1 field (so it composites through the existing layer/blend/remap pipeline exactly like a noise layer). Example (sphere): `1.0 - smoothstep(r - soft, r, length(p - center))`.

- **Primitives (v0):** sphere, box, cone. (Torus only if it drops in trivially.)
- **Transform:** reuse the existing per-layer scale/rotation/offset uniforms for placement — no new transform system.
- **Per-shape params:** `radius` and `softness` (edge falloff). Add an optional `sdf?: { radius: number; softness: number }` to `NoiseConfig` (defaulted; validated + migrated via the Phase A `presetValidation`/`stateMigration` patterns). Set the uniforms in `generateSlice` the same conditional way `u_worleyMode` is set today.
- **Boolean ops:** reuse existing blend modes (add ≈ union, multiply ≈ intersect, subtract ≈ carve). Add ONE new blend: **smooth-min union** (organic merging of shapes) — a new entry in the blend enum + `BLEND_MODE_INDEX` + `blend_modes.glsl` (the Phase A data-driven blend map).
- **UI:** the SDF sources appear in the existing layer noise-type picker automatically (it's data-driven); PropertiesPanel shows `radius`/`softness` sliders when the layer source is an SDF shape (a small conditional section, mirroring the FBM/Worley conditional controls).

### 2. Color ramp (transfer function)

- **State:** a global ramp `colorRamp: { stops: { t: number; color: [r,g,b]; alpha: number }[] }` (plus `colorRampEnabled: boolean`) on a new `render` settings slice (or `preview` — implementer picks the cleaner home; must be serialized + validated + migrated per Phase A patterns).
- **LUT:** build a 256×1 RGBA8 (or RGBA16F) 1D-style texture from the stops whenever they change; bind in the preview shaders as `u_colorRamp` + `u_colorRampEnabled`.
- **Preview shaders:** in raymarch (and slice/projection for consistency), after computing shaped density `d` (Phase A `applyDensityShaping`), look up `u_colorRamp` by `d` to get `color.rgb` and a per-sample `alpha`, and composite color. When `colorRampEnabled` is false, fall back to the current grayscale path (no regression).
- **UI:** a new **gradient editor** component (multi-stop: drag stops along 0→1, edit color + alpha per stop, add/remove stops). Reuse the interaction patterns from `BezierCurveEditor` (drag handles, right-click reset). Ship **fire / smoke / explosion presets** (stop arrays) selectable from a dropdown.
- Dragging ramp stops is free (preview-time, no regen) — same as Phase A cutoff/contrast.

### 3. Animation

Unchanged. Existing loop-phase + evolution + the animation frame cache drive motion.

### 4. Flipbook export (new output)

A new **Render Flipbook** export path (new module, e.g. `src/core/export/FlipbookExporter.ts`, or a mode in `ExportManager`). It bakes the *rendered* colored raymarch, not slices:

- Inputs/controls (in the export modal, new "Flipbook" section): **frame count** N, **FPS** (metadata), **tile resolution** (px per frame), **columns** (grid width); reuse `flipY` where relevant.
- For each frame `i` in `0..N-1`: set animation phase `= i / N`; generate that frame's volume (reuse `VolumeGenerator.generateFrameData` → upload to a volume texture, exactly as the animation cache does); render the colored raymarch into an offscreen FBO at `tileRes`; read it back; blit/draw into the sprite-sheet canvas at grid cell `(i % cols, floor(i / cols))`.
- Output: a **sprite-sheet PNG** and/or a **PNG sequence (zip)** (reuse `fflate` + the existing canvas-capture + `fileAccess` save path). Write a metadata sidecar (dims, N, fps, cols, tileRes, camera) — small, and seeds later interchange.
- **Camera:** the current viewport camera (WYSIWYG). A fixed/orthographic option is a later nicety.
- This path uses the full-res volume (never the drag proxy) and is independent of the live preview loop.

## Reused vs new

- **Reused:** layer/blend/remap/animation/generation pipeline; Phase A preview-shading pattern + `applyDensityShaping`; the data-driven source + blend maps; `generateFrameData` + animation-cache frame generation; canvas-capture + `fflate` + `fileAccess` export; `BezierCurveEditor` interaction patterns; `presetValidation`/`stateMigration`.
- **New:** 3-4 SDF source snippets + a smooth-min blend; a gradient/LUT component + ramp state + presets; colored raymarch sampling (ramp LUT); the flipbook bake exporter + its modal controls.

## Data / control flow

Author SDF + noise layers (compose via blends incl. smooth-min) → generation produces a scalar density volume (Phase A direct-to-3D, unchanged) → preview raymarch shades density (cutoff/contrast) then maps through the color-ramp LUT to colored output → flipbook export loops the animation, regenerates each frame's volume, renders the colored raymarch per frame, packs a sprite sheet / PNG sequence + metadata.

## Testing

- **Unit (pure TS):** ramp→LUT stop interpolation (given stops, LUT sample at t returns the correct interpolated color/alpha, incl. before-first/after-last-stop clamping). Extract this as a pure function with a test.
- **Unit (pure TS parity):** SDF distance/field formulas mirrored in TS (like Phase A's `SHADING_GLSL`) — assert sphere/box/cone return known field values at sample points, and the GLSL uses identical math.
- **Manual smoke (GL/visual):** SDF sphere/box/cone render as shapes; smooth-min merges two shapes organically; a fire preset ramp colors a noise-eroded sphere convincingly; dragging ramp stops updates instantly (no regen); flipbook export produces a correct sprite sheet grid + PNG sequence at the chosen frame count/tile res, matching the on-screen animation; grayscale path still works when the ramp is disabled.

## Success criteria

- Can build an explosion/fire look: SDF sphere/cone + noise erosion + a fire ramp, animated on the existing loop.
- Color ramp editor with fire/smoke/explosion presets; stop edits are instant (no regen).
- Flipbook export writes a sprite sheet + PNG sequence + metadata that plays back matching the in-app animation.
- No regression to existing generation, exports, or the grayscale (ramp-off) preview.
- `npm run build` + `npm run test` green; zero `any`; web + Tauri both work.
