# Vol3D v2 · VFX-0 — Colored Animated Flipbook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** SDF shapes + noise erosion + a color-ramp transfer function + a rendered-flipbook export, on top of v2 Phase A. Fire/smoke/explosion, end to end. Density-only storage; color and shaping are preview/bake-time.

**Architecture:** SDF primitives ride the existing source/snippet system as new `NoiseType` members whose GLSL returns a 0..1 field (`field = 1 - smoothstep(0, softness, signedDistance)`), so they compose through the current layer/blend/remap/animation pipeline unchanged. A new smooth-min blend merges shapes organically. A global color ramp is baked to a 256×1 LUT texture and sampled in the preview shaders (non-destructive, like Phase A cutoff/contrast). A new flipbook exporter loops the animation, regenerates each frame's volume (reusing `generateFrameData`), renders the colored raymarch offscreen per frame, and packs a sprite sheet + PNG sequence.

**Tech Stack:** TypeScript 5.6, Vite 6, WebGL2 + GLSL ES 3.00, Tauri 2, Vitest. No new deps. No WebGPU.

**Spec:** [docs/superpowers/specs/2026-07-24-vol3d-vfx-0-flipbook-design.md](../specs/2026-07-24-vol3d-vfx-0-flipbook-design.md)

## Global Constraints

- No new runtime dependencies. Zero `any`. No `as never`.
- Web + desktop (Tauri) both work (pure WebGL2).
- No regression to Phase A (direct-to-3D generation, non-destructive cutoff/contrast, drag proxy, context-restore) or to existing exports / the grayscale (ramp-off) preview.
- Volume storage stays single-channel R8 (multi-channel is VFX-1). Color is a preview/bake-time ramp on density.
- Preset/state changes go through the Phase A `presetValidation` + `stateMigration` patterns (validate + migrate + default); bump `CURRENT_PRESET_VERSION` if the schema changes.
- Every task ends green: `npm run build` (`tsc -b && vite build`) AND `npm run test` pass before commit.
- Commit after each task with the message in its final step; append trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

New:
- `src/shaders/noise/sdf_sphere.glsl`, `sdf_box.glsl`, `sdf_cone.glsl` — SDF source snippets (each defines `float noiseEval(vec3 p)`).
- `src/core/sdfField.ts` (+ `.test.ts`) — TS mirror of the SDF field math for parity tests (like Phase A `SHADING_GLSL`).
- `src/core/colorRamp.ts` (+ `.test.ts`) — ramp type, stop→LUT builder (pure), fire/smoke/explosion presets.
- `src/ui/components/GradientEditor.ts` — multi-stop gradient editor widget.
- `src/core/export/FlipbookExporter.ts` — the rendered-flipbook bake.

Modified:
- `src/types/noise.ts` — SDF `NoiseType` members + `sdf?: { radius; softness }` on `NoiseConfig`.
- `src/types/layer.ts` — `BlendMode.SmoothMin`.
- `src/types/preview.ts` (or a new `render` slice) + `src/state/AppState.ts` — ramp state defaults.
- `src/state/presetValidation.ts`, `src/state/stateMigration.ts` — validate/migrate sdf config + ramp state.
- `src/core/renderer/ShaderCompiler.ts` — register SDF snippets; inject ramp LUT sampling into preview programs.
- `src/core/renderer/VolumeGenerator.ts` — set `u_sdfRadius`/`u_sdfSoftness` conditionally; smooth-min blend index.
- `src/shaders/common/blend_modes.glsl` — smooth-min.
- `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` — color-ramp lookup.
- `src/utils/colorMap.ts` — labels/colors for the new SDF source types.
- `src/ui/panels/PropertiesPanel.ts` — radius/softness controls for SDF layers; host the gradient editor + presets.
- `src/ui/viewport/Viewport.ts` — build/bind the ramp LUT texture + `u_colorRamp`/`u_colorRampEnabled` uniforms.
- `src/ui/panels/ExportModal.ts` — flipbook controls + trigger.

---

## Task 1: SDF source primitives (sphere/box/cone) + schema + controls

**Files:**
- Create: `src/shaders/noise/sdf_sphere.glsl`, `sdf_box.glsl`, `sdf_cone.glsl`
- Create: `src/core/sdfField.ts`, `src/core/sdfField.test.ts`
- Modify: `src/types/noise.ts`, `src/core/renderer/ShaderCompiler.ts`, `src/core/renderer/VolumeGenerator.ts`, `src/utils/colorMap.ts`, `src/ui/panels/PropertiesPanel.ts`, `src/state/AppState.ts`, `src/state/presetValidation.ts`, `src/state/stateMigration.ts`

**Interfaces:**
- Produces: `NoiseType.SdfSphere='sdf_sphere'`, `SdfBox='sdf_box'`, `SdfCone='sdf_cone'`; `NoiseConfig.sdf?: { radius: number; softness: number }`; pure `sphereField/boxField/coneField(p, radius, softness): number` in `sdfField.ts` and matching GLSL; `isSdfSource(t: NoiseType): boolean`.
- Consumes: the Phase A data-driven `NOISE_SNIPPETS` map + the `noiseEval` convention.

- [ ] **Step 1: Write the failing SDF field parity test**

`src/core/sdfField.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { sphereField, boxField, coneField } from './sdfField'

describe('sdf fields (1 - smoothstep(0, softness, signedDistance))', () => {
  it('sphere: full inside, ~half at surface band, zero outside', () => {
    expect(sphereField([0,0,0], 0.3, 0.1)).toBeCloseTo(1, 6)      // center: sd=-0.3 -> 1
    expect(sphereField([0.3,0,0], 0.3, 0.1)).toBeCloseTo(1, 6)     // surface: sd=0 -> smoothstep(0,.1,0)=0 -> 1
    expect(sphereField([0.45,0,0], 0.3, 0.1)).toBe(0)             // sd=0.15 > softness -> 0
  })
  it('box: inside corner vs outside', () => {
    expect(boxField([0,0,0], 0.2, 0.05)).toBeCloseTo(1, 6)
    expect(boxField([0.4,0.4,0.4], 0.2, 0.05)).toBe(0)
  })
  it('cone returns a value in [0,1]', () => {
    const v = coneField([0,0.1,0], 0.3, 0.1)
    expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test` → FAIL (module missing).

- [ ] **Step 3: Implement `sdfField.ts` (pure TS mirror)**

```ts
// TS mirror of the SDF field GLSL. field = 1 - smoothstep(0, softness, signedDistance).
// GLSL snippets MUST use identical signed-distance formulas.
type Vec3 = [number, number, number]
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-6)))
  return t * t * (3 - 2 * t)
}
const field = (sd: number, softness: number) => 1 - smoothstep(0, Math.max(softness, 1e-4), sd)

export function sphereField(p: Vec3, radius: number, softness: number): number {
  const len = Math.hypot(p[0], p[1], p[2])
  return field(len - radius, softness)
}
export function boxField(p: Vec3, radius: number, softness: number): number {
  const q = [Math.abs(p[0]) - radius, Math.abs(p[1]) - radius, Math.abs(p[2]) - radius]
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0))
  const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0)
  return field(outside + inside, softness)
}
export function coneField(p: Vec3, radius: number, softness: number): number {
  // simple capped cone along +Y, height = 2*radius, base radius = radius
  const h = radius
  const d2 = Math.hypot(p[0], p[2]) - radius * (1 - (p[1] + h) / (2 * h))
  const dy = Math.abs(p[1]) - h
  const sd = Math.max(d2, dy)
  return field(sd, softness)
}
```
(The cone formula is an approximation; the GLSL must match it exactly. If a cleaner cone SDF is used, update BOTH the TS and GLSL and the test together.)

- [ ] **Step 4: Run test, verify it passes**

Run: `npm run test` → PASS.

- [ ] **Step 5: Write the GLSL snippets (identical math)**

Each file defines `float noiseEval(vec3 p)` reading `uniform float u_sdfRadius; uniform float u_sdfSoftness;` and returning the field, e.g. `sdf_sphere.glsl`:
```glsl
uniform float u_sdfRadius;
uniform float u_sdfSoftness;
float noiseEval(vec3 p) {
  float sd = length(p) - u_sdfRadius;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), sd);
}
```
Mirror `boxField`/`coneField` in `sdf_box.glsl`/`sdf_cone.glsl` with the SAME formulas as the TS.

- [ ] **Step 6: Register the sources + schema + uniforms + labels**

- `types/noise.ts`: add `SdfSphere/SdfBox/SdfCone` to `NoiseType`; add `sdf?: { radius: number; softness: number }` to `NoiseConfig`; export `isSdfSource(t)`.
- `ShaderCompiler.ts`: add the three snippets to `NOISE_SNIPPETS`.
- `VolumeGenerator.ts`: when `isSdfSource(layer.noise.type)`, set `u_sdfRadius`/`u_sdfSoftness` from `layer.noise.sdf` (defaulted) — mirror the conditional `u_worleyMode` pattern.
- `AppState.ts` `defaultLayer`: default `sdf: { radius: 0.3, softness: 0.1 }`.
- `presetValidation.ts` / `stateMigration.ts`: coerce/clamp `sdf.radius`/`softness` (clamp to sane ranges e.g. 0..1); enum coercion already covers the new `NoiseType` values via `Object.values`.
- `utils/colorMap.ts`: add `NOISE_LABELS`/`NOISE_COLORS` entries for the three SDF types ("SDF Sphere" etc.).

- [ ] **Step 7: PropertiesPanel radius/softness controls**

When the selected layer's `noise.type` is an SDF source, render `radius` and `softness` sliders (reuse the `Slider` component + `updateLayerNoise` for the `sdf` sub-object), mirroring the existing FBM/Worley conditional sections. Hide them for noise sources.

- [ ] **Step 8: Build + test + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: add an SDF Sphere layer → a soft sphere renders; Box/Cone render; radius/softness sliders reshape it; a noise layer with Multiply blend over the sphere erodes it. Document results.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: SDF primitive source layers (sphere/box/cone) with field parity test"
```

---

## Task 2: Smooth-min union blend

**Files:**
- Modify: `src/types/layer.ts`, `src/core/renderer/VolumeGenerator.ts`, `src/shaders/common/blend_modes.glsl`

**Interfaces:**
- Produces: `BlendMode.SmoothMin='smooth_min'`; its index in `BLEND_MODE_INDEX`; a `smoothMin` branch in `applyBlend`.

- [ ] **Step 1: Add the enum + index + GLSL**

- `types/layer.ts`: add `SmoothMin = 'smooth_min'` to `BlendMode`.
- `VolumeGenerator.ts` `BLEND_MODE_INDEX`: add `[BlendMode.SmoothMin]: 6`.
- `blend_modes.glsl` `applyBlend`: add the `index == 6` branch — smooth-min union of the two fields (treating them as densities), e.g. polynomial smooth-max for densities: `float k = 0.1; float h = clamp(0.5 + 0.5*(b - a)/k, 0.0, 1.0); return mix(a, b, h) + k*h*(1.0-h);` (tune k). This blends the accumulator `a` and layer `b` into a smooth union.

- [ ] **Step 2: Build + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: two SDF spheres, second layer set to Smooth Min → they merge with an organic neck instead of a hard union. Blend badge shows the new mode (the picker is data-driven).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: smooth-min union blend mode for organic SDF shape merging"
```

---

## Task 3: Color ramp state + LUT + colored preview + presets

**Files:**
- Create: `src/core/colorRamp.ts`, `src/core/colorRamp.test.ts`
- Modify: `src/types/preview.ts` (or new render slice), `src/state/AppState.ts`, `src/state/presetValidation.ts`, `src/state/stateMigration.ts`, `src/core/renderer/ShaderCompiler.ts`, `src/shaders/preview/*.frag.glsl`, `src/ui/viewport/Viewport.ts`

**Interfaces:**
- Produces: `RampStop { t: number; color: [number,number,number]; alpha: number }`; `ColorRamp { enabled: boolean; stops: RampStop[] }`; `buildRampLUT(ramp: ColorRamp, size=256): Uint8Array` (pure, RGBA per texel); `RAMP_PRESETS: Record<'fire'|'smoke'|'explosion', RampStop[]>`.

- [ ] **Step 1: Write the failing LUT test**

`src/core/colorRamp.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildRampLUT } from './colorRamp'

const ramp = { enabled: true, stops: [
  { t: 0, color: [0,0,0] as [number,number,number], alpha: 0 },
  { t: 1, color: [255,255,255] as [number,number,number], alpha: 255 },
]}

describe('buildRampLUT', () => {
  it('produces size*4 bytes', () => { expect(buildRampLUT(ramp, 256).length).toBe(256*4) })
  it('interpolates linearly between stops', () => {
    const lut = buildRampLUT(ramp, 256)
    const mid = 128 * 4
    expect(lut[mid]).toBeGreaterThan(100); expect(lut[mid]).toBeLessThan(160) // ~127
    expect(lut[3]).toBe(0)             // first texel alpha = 0
    expect(lut[255*4+3]).toBe(255)     // last texel alpha = 255
  })
  it('clamps before first / after last stop', () => {
    const r2 = { enabled: true, stops: [
      { t: 0.4, color: [10,20,30] as [number,number,number], alpha: 100 },
      { t: 0.6, color: [200,200,200] as [number,number,number], alpha: 200 },
    ]}
    const lut = buildRampLUT(r2, 256)
    expect(lut[0]).toBe(10)            // below first stop -> first stop color
    expect(lut[255*4]).toBe(200)       // above last stop -> last stop color
  })
})
```

- [ ] **Step 2: Run test, verify it fails** — `npm run test` → FAIL.

- [ ] **Step 3: Implement `colorRamp.ts`**

Implement `RampStop`/`ColorRamp` types, `buildRampLUT` (for each texel `i`, `t=i/(size-1)`; find the bracketing stops sorted by `t`; linear-interpolate color+alpha; clamp to the first/last stop outside the range; write RGBA bytes), and `RAMP_PRESETS` with fire (black→red→orange→yellow→white, rising alpha), smoke (transparent→grey), explosion (bright core→smoke tail).

- [ ] **Step 4: Run test, verify it passes** — `npm run test` → PASS.

- [ ] **Step 5: Ramp state + validation/migration**

Add `colorRamp: ColorRamp` to `preview` (or a new `render` slice) in `AppState.defaultState` (default `enabled: false`, stops = `RAMP_PRESETS.fire`). Validate in `presetValidation` (array of stops, each `t` 0..1, color bytes 0..255, alpha 0..255; drop malformed; fall back to default). Migrate (absent → default). Bump `CURRENT_PRESET_VERSION`.

- [ ] **Step 6: LUT texture + uniforms in Viewport**

In `Viewport`, build a 256×1 RGBA texture from `buildRampLUT` whenever `colorRamp` changes (subscribe to the state slice); bind it as `u_colorRamp` (a sampler) and set `u_colorRampEnabled` in all three render paths (`renderRaymarched`, `renderSlicePlane`). Rebuild the LUT texture on change; free it in `destroy`.

- [ ] **Step 7: Colored sampling in preview shaders**

Inject/declare `uniform sampler2D u_colorRamp; uniform bool u_colorRampEnabled;` in raymarch/slice/projection. After computing shaped density `d` (Phase A `applyDensityShaping`), if `u_colorRampEnabled` sample `texture(u_colorRamp, vec2(d, 0.5))` → `rgba`; use `rgba.rgb` as color and `rgba.a` as the per-sample opacity/emission; else keep the current grayscale path unchanged. Keep the raymarch accumulation otherwise intact.

- [ ] **Step 8: Build + test + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: enable ramp with the fire preset on an SDF sphere + noise → fiery colored look; disable ramp → grayscale exactly as before (no regression); switching presets recolors instantly (no regen).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: color-ramp transfer function (LUT) with fire/smoke/explosion presets in preview"
```

---

## Task 4: Gradient editor component

**Files:**
- Create: `src/ui/components/GradientEditor.ts`
- Modify: `src/ui/panels/PropertiesPanel.ts` (host the editor + preset dropdown)

**Interfaces:**
- Produces: `class GradientEditor { readonly el: HTMLElement; constructor(ramp: ColorRamp, onChange: (ramp: ColorRamp) => void) }` — a strip showing the gradient with draggable stop markers; click empty to add a stop, drag to move `t`, a color+alpha picker per selected stop, right-click a stop to remove; emits the updated ramp via `onChange`.

- [ ] **Step 1: Build the widget**

Render a gradient bar (CSS gradient or the LUT), draggable stop handles (reuse `BezierCurveEditor`'s drag patterns — `.slider-track`/handle conventions so the Phase A drag-proxy interaction guard treats it correctly), an `<input type=color>` + alpha slider for the selected stop, add-on-click / remove-on-right-click. On any edit, produce a normalized `ColorRamp` (stops sorted by `t`) and call `onChange`.

- [ ] **Step 2: Wire into PropertiesPanel**

Add a "Color" section: an enable toggle, a preset dropdown (`RAMP_PRESETS` + "Custom"), and the `GradientEditor`. Editor `onChange` → `state.update('preview'|'render', { ...slice, colorRamp })`. Selecting a preset loads its stops.

- [ ] **Step 3: Build + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: edit stops (drag/add/remove/recolor) → preview updates live (no regen); presets load; toggle off → grayscale.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: gradient editor for the color-ramp transfer function"
```

---

## Task 5: Flipbook export

**Files:**
- Create: `src/core/export/FlipbookExporter.ts`
- Modify: `src/ui/panels/ExportModal.ts`, `src/ui/viewport/Viewport.ts` (expose a render-to-target hook if needed)

**Interfaces:**
- Produces: `FlipbookExporter` that, given the generator/volume/camera/compiler + `{ frames, fps, tileRes, cols, filenameBase }`, bakes the colored raymarch over the animation loop into a sprite sheet PNG (+ optional PNG-sequence zip) + a metadata sidecar. Reuses `generateFrameData`, the raymarch program, canvas capture, `fflate`, `fileAccess`.

- [ ] **Step 1: Implement the bake loop**

For `i` in `0..frames-1`: phase `= i/frames`; `generateFrameData(...)` for that phase → upload to a volume texture; render the colored raymarch (current camera, ramp LUT applied) into an offscreen FBO at `tileRes×tileRes`; read pixels; draw into a sprite-sheet canvas at cell `(i%cols, floor(i/cols))`. Grid size = `cols × ceil(frames/cols)`. Use the FULL-res volume path (never the drag proxy). Reuse the async/awaited frame generation the animation cache uses. Produce the sprite-sheet PNG via canvas `toBlob` (with the existing `toDataURL` fallback), optionally also a zip of per-frame PNGs, and a JSON metadata sidecar (`{ frames, fps, cols, tileRes, dims, camera }`). Save via `fileAccess`.

- [ ] **Step 2: ExportModal controls**

Add a "Flipbook" section/format to `ExportModal`: `frames` (default 32), `fps` (default 24, metadata only), `tileRes` (e.g. 128/256/512), `cols` (default ceil(sqrt(frames))). On confirm, dispatch to the flipbook path (extend the typed export event, or a dedicated callback) with a `FlipbookConfig`. Keep the existing volume/slice export formats unchanged.

- [ ] **Step 3: Build + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: set up a fire look, open Export → Flipbook, bake 16 frames at 128px / 4 cols → a 4×4 sprite sheet whose frames match the in-app animation progression; try a PNG sequence; confirm exports use full res and the ramp coloring. Verify normal slice/raw exports still work.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: rendered-flipbook export (sprite sheet + PNG sequence + metadata)"
```

---

## Self-Review Notes

- **Spec coverage:** SDF primitives + schema + controls → Task 1; smooth-min → Task 2; ramp state/LUT/colored preview/presets → Task 3; gradient editor → Task 4; flipbook export → Task 5. All spec sections mapped.
- **Testability:** pure units tested — SDF field parity (Task 1) and LUT interpolation (Task 3). SDF/blend/ramp GL rendering and the flipbook bake are GL/visual → `npm run build` + explicit manual smoke per task. The SDF cone formula must stay identical between `sdfField.ts` and `sdf_cone.glsl` (Task 1 step 3 note).
- **No-regression anchors:** ramp OFF must render byte-identical grayscale to Phase A; existing slice/raw exports untouched (Task 5); Phase A direct-to-3D/proxy/context-restore not modified.
- **Parity/precision:** color is preview/bake-time only; density volume + existing exports unchanged. Flipbook uses full-res volume, never the proxy.
- **Deferred (VFX-1/2):** multi-channel/heat/RGB tint, colored volume-data export, directional motion, lit scattering — not in this plan.
