# Vol3D v2 · VFX-1 — Heat Channel, Emission & Colored Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a second **heat** channel to the volume (density=opacity, heat=emission), authored as **derived heat** from a per-layer Temperature, colored via the existing ramp, and baked out as RGBA8 for engines.

**Architecture:** The volume goes single-channel R8 → two-channel **RG8** (R=density, G=heat). Density composites exactly as today; heat accumulates additively per layer as `densityContribution × temperature`. Preview maps the color ramp over **heat** for emission and shaped **density** for opacity (ramp-off = current grayscale, unchanged). Export bakes `rgb=ramp(heat)`, `a=shapedDensity` → RGBA8.

**Tech Stack:** TypeScript 5.6, Vite 6, WebGL2 + GLSL ES 3.00, Tauri 2, Vitest. No new deps. No WebGPU.

**Spec:** [docs/superpowers/specs/2026-07-26-vol3d-vfx-1-heat-channel-design.md](../specs/2026-07-26-vol3d-vfx-1-heat-channel-design.md)

## Global Constraints

- No new runtime dependencies. Zero `any`. No `as never`.
- Web + desktop (Tauri) both work (pure WebGL2, no WebGPU).
- **Density behavior must be byte-identical to today** — adding heat must not change the density field, existing (density) exports, or the ramp-OFF grayscale preview.
- Ramp-OFF preview stays byte-identical grayscale (heat unused).
- Schema changes go through the Phase A `presetValidation` + `stateMigration` patterns; bump `CURRENT_PRESET_VERSION`. Existing presets (no temperature) load as cold (temperature 0) → identical look.
- Every task ends green: `npm run build` AND `npm run test` pass before commit.
- Commit after each task with the message in its final step; append trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

New:
- `src/core/heatAccum.ts` (+ `.test.ts`) — pure `accumulateHeat` + `HEAT_ACCUM_GLSL` mirror (Task 2).
- `src/core/emissionBake.ts` (+ `.test.ts`) — pure `(heat, density, ramp, cutoff, contrast) → RGBA` bake for export (Task 4).

Modified:
- `src/types/noise.ts` — `temperature` on `NoiseConfig` (Task 1).
- `src/state/AppState.ts` — default temperature (Task 1).
- `src/state/presetValidation.ts`, `src/state/stateMigration.ts` — validate/migrate temperature + version bump (Task 1).
- `src/ui/panels/PropertiesPanel.ts` — Temperature slider (Task 1).
- `src/core/volume/VolumeTexture.ts` — RG8 format (Task 2).
- `src/core/volume/SliceBuffer.ts` — 2-channel readback (Task 2).
- `src/core/renderer/VolumeGenerator.ts` — vec2 composite, `u_temperature`, RG extract, frame size, RG uploads (Task 2).
- `src/shaders/generation/composite.frag.glsl` — output `vec2(density, heat)` (Task 2).
- `src/core/renderer/ShaderCompiler.ts` — inject `HEAT_ACCUM_GLSL`; `u_temperature` (Task 2).
- `src/ui/viewport/AnimationController.ts` / `src/ui/viewport/animationCache.ts` — 2-byte/voxel frame accounting (Task 2).
- `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` — emission from ramp(heat), opacity from density (Task 3).
- `src/core/export/ExportManager.ts`, `src/core/export/FlipbookExporter.ts`, `src/ui/panels/ExportModal.ts` — baked RGBA8 colored export (Task 4).

---

## Task 1: Per-layer Temperature (schema only, no render effect yet)

**Files:**
- Modify: `src/types/noise.ts`, `src/state/AppState.ts`, `src/state/presetValidation.ts`, `src/state/stateMigration.ts`, `src/ui/panels/PropertiesPanel.ts`
- Test: extend `src/state/presetValidation.test.ts` (or a new test)

**Interfaces:**
- Produces: `NoiseConfig.temperature: number` (0..1, default `0`); a Temperature `Slider` in PropertiesPanel writing it via `updateLayerNoise`.

- [ ] **Step 1: Write the failing validation test**

Add to `src/state/presetValidation.test.ts`:
```ts
it('clamps layer temperature to 0..1 and defaults when absent', () => {
  const hot = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin', temperature: 5 } }] }))
  if (hot.ok) expect(hot.data.layers![0].noise.temperature).toBeLessThanOrEqual(1)
  const absent = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'perlin' } }] }))
  if (absent.ok) expect(absent.data.layers![0].noise.temperature).toBe(0)
})
```

- [ ] **Step 2: Run test, verify it fails** — `npm run test` → FAIL (temperature undefined / not clamped).

- [ ] **Step 3: Add the field + defaults + validation + migration**
- `types/noise.ts`: add `temperature: number` to `NoiseConfig`.
- `AppState.ts` `defaultLayer`: `temperature: 0` in the noise object.
- `presetValidation.ts` `sanitizeNoise`: `temperature: clamp01(asFiniteNumber(rec.temperature) ?? 0)` (reuse existing `clamp01`/`asFiniteNumber`).
- `stateMigration.ts` `normalizeLayer` noise: `temperature: layer.noise?.temperature ?? 0`.
- Bump `CURRENT_PRESET_VERSION`.

- [ ] **Step 4: Run test, verify it passes** — `npm run test` → PASS.

- [ ] **Step 5: Temperature slider in PropertiesPanel**

In `buildNoiseSection` (all layer types), add a `Slider` `{ label: 'Temperature', min: 0, max: 1, step: 0.01, value: layer.noise.temperature, defaultValue: 0, decimals: 2, onInput/onChange: v => updateNoise(id, () => ({ temperature: v })) }`. (No render effect yet — consumed in Task 2.)

- [ ] **Step 6: Build + test** — `npm run build && npm run test` → PASS.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "feat: per-layer Temperature field (schema + control) for derived heat"
```

---

## Task 2: RG8 volume + derived-heat compositing + 2-channel readback

**Files:**
- Create: `src/core/heatAccum.ts`, `src/core/heatAccum.test.ts`
- Modify: `src/core/volume/VolumeTexture.ts`, `src/core/volume/SliceBuffer.ts`, `src/core/renderer/VolumeGenerator.ts`, `src/shaders/generation/composite.frag.glsl`, `src/core/renderer/ShaderCompiler.ts`, `src/ui/viewport/animationCache.ts`

**Interfaces:**
- Produces: `accumulateHeat(heatIn: number, densityContribution: number, temperature: number): number` = `clamp(heatIn + densityContribution * temperature, 0, 1)` + `HEAT_ACCUM_GLSL` mirror. Volume texture is RG8; `VolumeTexture.uploadSlice`/`uploadVolume` take 2-byte/voxel RG data; `SliceBuffer.readPixels` returns RGBA bytes where `[i*4]`=density, `[i*4+1]`=heat.
- Consumes: `NoiseConfig.temperature` (Task 1).

- [ ] **Step 1: Write failing heatAccum test**

`src/core/heatAccum.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { accumulateHeat } from './heatAccum'
describe('accumulateHeat', () => {
  it('adds density-weighted temperature, clamped 0..1', () => {
    expect(accumulateHeat(0, 0.5, 1)).toBeCloseTo(0.5, 6)
    expect(accumulateHeat(0.4, 0.5, 0.4)).toBeCloseTo(0.6, 6)
    expect(accumulateHeat(0.9, 1, 1)).toBe(1)      // clamps
    expect(accumulateHeat(0, 0.5, 0)).toBe(0)      // cold layer adds nothing
  })
})
```

- [ ] **Step 2: Run test, verify fail** — `npm run test` → FAIL.

- [ ] **Step 3: Implement heatAccum.ts**
```ts
export function accumulateHeat(heatIn: number, densityContribution: number, temperature: number): number {
  return Math.max(0, Math.min(1, heatIn + densityContribution * temperature))
}
export const HEAT_ACCUM_GLSL = `
float accumulateHeat(float heatIn, float densityContribution, float temperature) {
  return clamp(heatIn + densityContribution * temperature, 0.0, 1.0);
}
`
```

- [ ] **Step 4: Run test, verify pass** — `npm run test` → PASS.

- [ ] **Step 5: RG8 volume texture**

`VolumeTexture.ts`: `texStorage3D`/`texImage3D` internalformat `gl.RG8`, format `gl.RG`, type `UNSIGNED_BYTE`. `uploadSlice(z, data)` and `uploadVolume(data)` now expect 2 bytes/voxel (RG interleaved). `bind`/sampler unchanged. Update any size math (`res*res*depth*2`).

- [ ] **Step 6: composite shader outputs vec2 + heat accumulation**

`composite.frag.glsl`: read the accumulator as `vec2` (RG); density (`.r`) composited via the existing blend+opacity path unchanged; heat (`.g`) via `accumulateHeat(heatIn, layerDensityContribution, u_temperature)` where `layerDensityContribution` is the same post-opacity density value written to `.r` this layer. Output `vec2(density, heat)`. Inject `HEAT_ACCUM_GLSL` via `ShaderCompiler`. Add `uniform float u_temperature;`.

- [ ] **Step 7: wire u_temperature + RG accumulators/readback in VolumeGenerator + SliceBuffer**
- `VolumeGenerator` composite pass: `setUniform('u_temperature', layer.noise.temperature)` per layer.
- The ping-pong accumulator (already RGBA16F) now uses `.rg`; the live direct-to-3D path renders the composite `vec2` into the RG8 volume layer (Phase A `framebufferTextureLayer` path — target is RG8 now). Verify framebuffer completeness for RG8; fall back to readback path if incomplete.
- `SliceBuffer.readPixels`: still read RGBA/UNSIGNED_BYTE from the resolve target; caller takes `.r`=density, `.g`=heat.
- `VolumeGenerator` readback path (`generateFrameData` + export `readSlice`): build RG `Uint8Array` (2 bytes/voxel): `out[i*2]=rgba[i*4]` (density, shaping NOT applied — Phase A stores raw), `out[i*2+1]=rgba[i*4+1]` (heat). `uploadSlice` RG.

- [ ] **Step 8: animation cache frame accounting**

`animationCache.ts` `computeCacheFrameCount`: `bytesPerFrame = resolution*resolution*depth*2` (RG). `AnimationController` frame buffers sized ×2; `generateFrameData` returns RG frames; uploaded via the RG `uploadVolume`.

- [ ] **Step 9: Build + test + smoke**

`npm run build && npm run test`. Then `npm run dev` (5174): existing density look is UNCHANGED (preview still samples `.r`; ramp still on density until Task 3); raise a layer's Temperature — no visible change yet (heat stored, not shown); generate at 128/256, animate — no regression, no stall.

- [ ] **Step 10: Commit**
```bash
git add -A
git commit -m "feat: two-channel RG8 volume with derived-heat compositing"
```

---

## Task 3: Heat-driven emission in the preview

**Files:**
- Modify: `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` (and `Viewport` only if a uniform changes)

**Interfaces:**
- Consumes: RG volume (Task 2), the existing `u_colorRamp`/`u_colorRampEnabled` (VFX-0).

- [ ] **Step 1: Emission from heat, opacity from density**

In all three preview shaders: sample the volume as before but use `.r` = density and `.g` = heat. Compute opacity from **shaped density** (`applyDensityShaping(density, u_cutoff, u_contrast)`) exactly as today. When `u_colorRampEnabled`: `emission = texture(u_colorRamp, vec2(heat, 0.5))` — RGB used as emission color, its `.a` optionally scaling emission strength; raymarch accumulates `emission * opacity` front-to-back (replace the current density→ramp lookup with heat→ramp; opacity stays density-driven). When ramp disabled: byte-identical current grayscale-density path (heat unused).

- [ ] **Step 2: Build + smoke (the payoff)**

`npm run build && npm run test`. Then `npm run dev`: build a flame-core layer (Temperature ~1) + a cooler smoke layer (Temperature ~0.1), enable the Fire ramp → the hot core glows (ramp color by heat), smoke stays dark, decoupled from density. Toggle ramp OFF → grayscale density exactly as before. Slice/projection also colored by heat. (Headless Playwright A/B if feasible, per VFX-0 precedent.)

- [ ] **Step 3: Commit**
```bash
git add -A
git commit -m "feat: heat-driven emission color in preview (density=opacity, heat=emission)"
```

---

## Task 4: Baked RGBA8 colored export (VFX-1B)

**Files:**
- Create: `src/core/emissionBake.ts`, `src/core/emissionBake.test.ts`
- Modify: `src/core/export/ExportManager.ts`, `src/core/export/FlipbookExporter.ts`, `src/ui/panels/ExportModal.ts`

**Interfaces:**
- Produces: `bakeEmissionRGBA(heat: number, density: number, lut: Uint8Array, cutoff: number, contrast: number): [number,number,number,number]` — `rgb` = LUT sampled at shaped-or-raw heat, `a` = `applyDensityShaping(density,cutoff,contrast)*255`, all bytes. A new "Colored" export format/option producing RGBA8 sprite sheet / PNG slices / flipbook.

- [ ] **Step 1: Write failing bake test**

`src/core/emissionBake.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { bakeEmissionRGBA } from './emissionBake'
import { buildRampLUT, RAMP_PRESETS } from './colorRamp'
const lut = buildRampLUT({ enabled: true, stops: RAMP_PRESETS.fire })
describe('bakeEmissionRGBA', () => {
  it('rgb comes from LUT(heat), alpha from shaped density', () => {
    const [r,g,b,a] = bakeEmissionRGBA(1.0, 1.0, lut, 0, 1)   // max heat, full density
    expect(a).toBe(255)
    expect(r + g + b).toBeGreaterThan(0)                       // fire top = bright
    const cold = bakeEmissionRGBA(0, 1.0, lut, 0, 1)           // no heat
    expect(cold[3]).toBe(255)                                  // still opaque (dense)
  })
  it('alpha is zero below cutoff', () => {
    expect(bakeEmissionRGBA(0.5, 0.1, lut, 0.35, 1.5)[3]).toBe(0)
  })
})
```

- [ ] **Step 2: Run test, verify fail** — `npm run test` → FAIL.

- [ ] **Step 3: Implement emissionBake.ts**

Sample the LUT (256×1 RGBA from `buildRampLUT`) at `heat` for RGB; alpha = `Math.round(applyDensityShaping(density, cutoff, contrast) * 255)` (import from `volumeShaping`). Return the 4 bytes.

- [ ] **Step 4: Run test, verify pass** — `npm run test` → PASS.

- [ ] **Step 5: Wire baked export**

`ExportManager.readSlice` already returns RGBA where `.r`=density, `.g`=heat (Task 2). Add a "Colored (RGBA8)" export path that, per pixel, calls `bakeEmissionRGBA(heat/255, density/255, lut, cutoff, contrast)` → the sprite sheet / PNG-sequence bytes (reuse the existing `redToGray`-style path but produce true RGBA). `FlipbookExporter`: the baked frame already renders the colored raymarch (Task 3) — confirm it captures the emission (it renders the on-screen colored raymarch, so it already bakes emission; no change needed beyond it using the heat-driven shader). Add a **"Colored RGBA8"** option to `ExportModal` for the *slice/sprite* volume export (distinct from the existing density-only R8/RGBA8/raw). The LUT comes from `state.preview.colorRamp`.

- [ ] **Step 6: Build + test + smoke**

`npm run build && npm run test`. Then `npm run dev`: export the fire look as Colored RGBA8 sprite sheet + PNG sequence → slices show emission RGB + density alpha; a flipbook bake shows colored frames; existing R8/raw exports unchanged.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "feat: baked RGBA8 colored volume export (emission RGB + density alpha)"
```

---

## Self-Review Notes

- **Spec coverage:** RG8 + derived heat + compositing → Task 2; Temperature authoring → Task 1; heat→emission / density→opacity preview → Task 3; baked RGBA8 export → Task 4. Migration/version bump → Task 1. All spec sections mapped.
- **No-regression anchors:** density field + ramp-OFF grayscale byte-identical (Tasks 2, 3); existing density exports unchanged (Task 4 adds a new option, doesn't alter old ones); Phase A direct-to-3D/proxy/context-restore intact (Task 2 renders vec2 into the RG8 layer via the same `framebufferTextureLayer` path).
- **Testability:** pure units — `accumulateHeat` (Task 2), `bakeEmissionRGBA` (Task 4), temperature validation (Task 1). RG pipeline + emission + export bake verified by build + manual/Playwright smoke.
- **Atomicity:** Task 2 is the heavy multi-channel change and is deliberately one gated unit (storage + compositing + readback move together; a split leaves a broken half-RG pipeline). Task 1 lands the schema safely ahead of it; Task 3 flips preview to heat; Task 4 exports.
- **Deferred (later slices):** independent RGB tint field, EXR/raw-RG/DDS export, float heat storage, directional motion/lighting (VFX-2).
