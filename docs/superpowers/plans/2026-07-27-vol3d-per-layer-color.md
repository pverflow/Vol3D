# Per-Layer Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every layer its own color ramp so multi-layer add/subtract scenes render distinct, non-smeared colors, while the density/shape pipeline stays byte-identical to today.

**Architecture:** Store per-voxel color: RG8 `[density, heat]` → RGBA8 `[colorR, colorG, colorB, density]`. Density (shape) composites via the existing blend modes into the **alpha** channel (unchanged math). Color composites as an independent painter's-"over" of each layer's own `ColorRamp(layerValue)` into RGB. Preview opacity = density (`.a`), emission = stored RGB. The sparse cache, sampling, and export widen to 4 bytes; the machinery is otherwise unchanged.

**Tech Stack:** TypeScript, Vite 6, WebGL2 / GLSL ES 3.00, Vitest, Playwright (real-GPU smoke, scratch install only).

**Spec:** `docs/superpowers/specs/2026-07-27-vol3d-per-layer-color-design.md`

## Global Constraints

- No new dependencies. Zero `any`. No `as never`. Web + Tauri (all webviews).
- Density/shape math (blend modes, remap, SDF, animation, drag proxy) unchanged.
- `npm run build` (`tsc -b && vite build`) + `npm run test` green after every task.
- Dev server: **port 5174 only** (`vite.config.ts` pins it). Free the port with `lsof -ti tcp:5174 | xargs kill` — NEVER `pkill -f vite`/`pkill node` (kills the user's other projects on 5173/5175).
- Real-GPU Playwright smoke installs Playwright in the SCRATCHPAD only, never in the repo.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Storage layout is `[R=colorR, G=colorG, B=colorB, A=density]`** everywhere (volume texture, readback frame bytes, atlas, sparse sample). Density lives in the **alpha** channel.

---

## Task 1: RGBA8 storage + per-layer color generation + dense preview

Dense end-to-end: each layer maps its own value through its own ramp; two layers with different ramps render two colors; a subtract layer carves without recoloring the rest. Sparse cache is fixed in Task 2 (intermediate: sparse playback may show wrong color until then — acceptable, unmerged).

**Files:**
- Modify: `src/types/layer.ts` (add `colorRamp` to `Layer`)
- Modify: `src/types/noise.ts` (mark `temperature` optional/deprecated — see Step 1)
- Modify: `src/state/AppState.ts` (`defaultLayer` gets a default ramp)
- Modify: `src/core/volume/VolumeTexture.ts` (RG8 → RGBA8)
- Modify: `src/core/volume/SliceBuffer.ts` (accumulator clear alpha → 0)
- Modify: `src/shaders/generation/composite.frag.glsl` (per-layer ramp, output `[rgb, density]`)
- Modify: `src/core/renderer/ShaderCompiler.ts` (`buildCompositeShader`: drop heat inject; add nothing else)
- Modify: `src/core/renderer/VolumeGenerator.ts` (build + bind per-layer ramp LUTs; clear-to-zero alpha)
- Modify: `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` (sample `vec4`, emission = `.rgb`, opacity = `.a`)
- Modify: `src/core/sparseSample.ts` (`sampleSparse` returns `vec4`)
- Modify: `src/ui/viewport/Viewport.ts` (drop the global-ramp binding from the preview path; keep the flipbook snapshot fields for Task 4)

**Interfaces:**
- Consumes: `ColorRamp`, `buildRampLUT`, `RAMP_PRESETS` from `src/core/colorRamp.ts` (already exist).
- Produces: `Layer.colorRamp: ColorRamp`. Stored volume/readback bytes are RGBA8 `[colorR, colorG, colorB, density]`. GLSL `sampleSparse(vec3) -> vec4` and `sampleVolume(vec3) -> vec4` returning `[rgb, density]`.

- [ ] **Step 1: Add `colorRamp` to the layer type**

In `src/types/layer.ts`, import the ramp type and add the field to `Layer`:

```typescript
import type { ColorRamp } from '../core/colorRamp'
// ...
export interface Layer {
  id: string
  name: string
  visible: boolean
  locked: boolean
  solo: boolean
  blendMode: BlendMode
  opacity: number    // 0..1
  noise: NoiseConfig
  distortion: DistortionConfig
  remap: RemapConfig
  invert: boolean
  colorRamp: ColorRamp  // per-layer color (VFX-2). Maps this layer's own value 0..1 -> RGBA.
}
```

In `src/types/noise.ts`, change `temperature` to optional and note it's superseded (kept only so old presets type-check; ignored by generation now):

```typescript
  temperature?: number  // DEPRECATED (VFX-2): superseded by per-layer colorRamp; ignored by generation.
```

- [ ] **Step 2: Default ramp on new layers**

In `src/state/AppState.ts` `defaultLayer`, add a default Fire ramp and drop the `temperature` default (leave the field out). Import is already `RAMP_PRESETS`:

```typescript
export function defaultLayer(name?: string, noiseType: NoiseType = NoiseType.Perlin): Layer {
  return {
    // ...existing id/name/visible/... unchanged...
    noise: {
      // ...unchanged... remove the `temperature: 0.5,` line
    },
    // ...distortion, remap unchanged...
    invert: false,
    colorRamp: { enabled: true, stops: [...RAMP_PRESETS.fire] },
  }
}
```

Also remove `temperature` from any inline layer literals in `AppState.ts`'s initial state if present (grep `temperature` in that file).

- [ ] **Step 3: Widen the volume texture to RGBA8**

In `src/core/volume/VolumeTexture.ts`, change the allocation and both uploads from RG to RGBA (comments too). Filtering stays LINEAR.

```typescript
// Allocate storage — RGBA8: RGB=per-layer color, A=density (VFX-2)
gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, resolution, resolution, depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
```
```typescript
// uploadSlice: data is RGBA interleaved, 4 bytes/voxel
gl.texSubImage3D(/* ...same coords... */, gl.RGBA, gl.UNSIGNED_BYTE, data)
```
```typescript
// uploadVolume: data is RGBA interleaved, 4 bytes/voxel (resolution*resolution*depth*4)
gl.texSubImage3D(/* ...same coords... */, gl.RGBA, gl.UNSIGNED_BYTE, data)
```

- [ ] **Step 4: Clear the accumulator alpha to 0**

In `src/core/volume/SliceBuffer.ts`, `clearFbo` currently does `gl.clearColor(0, 0, 0, 1)`. Density now lives in alpha and must start at 0:

```typescript
gl.clearColor(0, 0, 0, 0)  // [colorRGB, density] — density (alpha) starts at 0 (VFX-2)
```

- [ ] **Step 5: Per-layer ramp in the composite shader**

Rewrite `src/shaders/generation/composite.frag.glsl` so density composites into alpha (unchanged blend math) and color composites as painter's-"over" from the layer's own ramp:

```glsl
#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_accumulator;
uniform sampler2D u_layerOutput;
uniform sampler2D u_layerRamp;   // per-layer color LUT (256x1 RGBA8), VFX-2
uniform float u_opacity;
uniform int u_blendMode;

void main() {
  vec4 acc = texture(u_accumulator, vUv);   // [colorRGB, density]
  float base = acc.a;
  float v = texture(u_layerOutput, vUv).r;  // this layer's own value 0..1

  // Density / shape — UNCHANGED math, now on the alpha channel.
  float blended = applyBlend(u_blendMode, base, v);
  float density = mix(base, blended, u_opacity);

  // Color — independent painter's "over" of this layer's ramp(value).
  vec4 c = texture(u_layerRamp, vec2(v, 0.5));
  float a = c.a * u_opacity;
  vec3 rgb = c.rgb * a + acc.rgb * (1.0 - a);

  fragColor = vec4(rgb, density);
}
```

Note: `u_temperature` and the `accumulateHeat` call are removed.

- [ ] **Step 6: Drop the heat injection from the composite build**

In `src/core/renderer/ShaderCompiler.ts` `buildCompositeShader`, remove `HEAT_ACCUM_GLSL` from the concatenation (the composite no longer calls `accumulateHeat`):

```typescript
const frag = [header, blendModes, compositeFrag.replace('#version 300 es', '').replace('precision highp float;', '')].join('\n')
```

Leave the `HEAT_ACCUM_GLSL` import/file in place if other code references it; if nothing else does, remove the now-unused import (build will flag it).

- [ ] **Step 7: Build + bind per-layer ramp LUTs in generation**

In `src/core/renderer/VolumeGenerator.ts`:

(a) Add a LUT texture unit and a helper to build a 256×1 RGBA8 LUT from a `ColorRamp` (reuse `buildRampLUT`). Import at top:

```typescript
import { buildRampLUT } from '../colorRamp'
```

(b) In `generate(...)` and `generateFrameData(...)`, before the slice loop, build one LUT texture per active layer (index-aligned with `activeLayers`), and delete them in the loop's completion. Add a small helper:

```typescript
// Build one 256x1 RGBA8 LUT texture per layer's colorRamp; index-aligned with `layers`.
private buildLayerRampLUTs(layers: Layer[]): WebGLTexture[] {
  const { gl } = this
  return layers.map((layer) => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildRampLUT(layer.colorRamp, 256))
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  })
}
```

Thread the LUT array into the per-slice render so `runCompositePass` can bind the current layer's LUT. `generateSlice`/`generateSliceLive` walk `layers` by index — pass the matching `lutTextures[i]` into `runCompositePass`.

(c) In `runCompositePass`, accept the layer's LUT texture and bind it to a dedicated unit (e.g. unit 2 — units 0/1 are `u_layerOutput`/`u_accumulator`), then set `u_layerRamp`. Remove the `u_temperature` uniform set:

```typescript
private runCompositePass(layer: Layer, layerRampLUT: WebGLTexture, bindTarget: () => void) {
  const { gl, compiler, sliceBuffer } = this
  const compProg = compiler.buildCompositeShader()
  gl.useProgram(compProg.program)
  bindTarget()

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.layerOutput.texture)
  compiler.setUniformi(compProg, 'u_layerOutput', 0)

  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.accumulatorRead.texture)
  compiler.setUniformi(compProg, 'u_accumulator', 1)

  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, layerRampLUT)
  compiler.setUniformi(compProg, 'u_layerRamp', 2)

  compiler.setUniform(compProg, 'u_opacity', layer.opacity)
  compiler.setUniformi(compProg, 'u_blendMode', BLEND_MODE_INDEX[layer.blendMode])

  gl.drawArrays(gl.TRIANGLES, 0, 3)
}
```

(d) In `generateSliceLive`, the "no active layers" branch clears to zero density — change `gl.clearColor(0, 0, 0, 1)` to `gl.clearColor(0, 0, 0, 0)`.

(e) `generateFrameData` currently extracts RG (2 bytes) via `extractRGSlice`. Now keep the full RGBA readback: allocate `resolution*resolution*depth*4` and `frame.set(rgba, z*resolution*resolution*4)` directly (drop `extractRGSlice`; the readback is already RGBA). Update the `generate()` fallback path's `extractRGSlice` use the same way (write the full RGBA slice via `volume.uploadSlice`).

- [ ] **Step 8: Preview shaders sample RGBA**

In `src/core/sparseSample.ts`, change `sampleSparse` to return `vec4` (the atlas texture is 4-channel; Task 2 makes the atlas RGBA8 — until then the extra channels are placeholder):

```glsl
vec4 sampleSparse(vec3 volumePos) {
  vec3 mc = floor(volumePos * u_macroDims);
  vec4 ind = texture(u_indirection, (mc + 0.5) / u_macroDims);
  if (ind.a < 0.5) return vec4(0.0);
  vec3 slot = floor(ind.rgb * 255.0 + 0.5);
  vec3 local = fract(volumePos * u_macroDims);
  vec3 voxel = clamp(floor(local * SPARSE_BRICK), vec3(0.0), vec3(SPARSE_BRICK - 1.0));
  vec3 atlasVoxel = slot * SPARSE_BRICK + voxel;
  vec3 atlasUvw = (atlasVoxel + 0.5) / (u_atlasDimsBricks * SPARSE_BRICK);
  return texture(u_atlas, atlasUvw);   // [colorRGB, density]
}
```

In `src/shaders/preview/raymarch.frag.glsl`: change `sampleVolume` to return `vec4` and drop the `u_colorRamp`/`u_colorRampEnabled` uniforms and the whole `if (u_colorRampEnabled) {...} else {...}` split — there is one path now:

```glsl
vec4 sampleVolume(vec3 p) {
  if (u_sparseEnabled) return sampleSparse(p);
  return texture(u_volume, p);
}
```

Replace the per-step body (inside `if (sampleScene(...))`, after the empty-macrocell skip) with:

```glsl
vec4 texel = sampleVolume(volumePos);              // [colorRGB, density]
float sampleValue = applyDensityShaping(texel.a, u_cutoff, u_contrast);
float density = sampleValue * (u_density * densityMul);
if (density > 0.001) {
  vec3 lightWorldPos = worldPos + u_lightDir * 0.05;
  float shadow = 1.0;
  vec3 lightVolumePos; float lightDensityMul;
  if (sampleScene(lightWorldPos, lightVolumePos, lightDensityMul)) {
    float lightSample = applyDensityShaping(sampleVolume(lightVolumePos).a, u_cutoff, u_contrast);
    shadow = 1.0 - lightSample * lightDensityMul * 0.75;
  }
  float alpha = 1.0 - exp(-density * stepSize * EXTINCTION_SCALE);
  // Faint smoke ambient so a dense-but-uncolored voxel isn't pure black.
  vec3 smoke = mix(SMOKE_SHADOW, SMOKE_LIT, clamp(shadow, 0.0, 1.0));
  vec3 emission = texel.rgb * EMISSION_GAIN;
  vec3 voxelColor = smoke + emission;
  accumulatedColor += voxelColor * alpha * transmittance;
  transmittance *= (1.0 - alpha);
}
```

Do the analogous change in `slice.frag.glsl` and `projection.frag.glsl`: sample `vec4`, density = `.a` (through `applyDensityShaping`), emission = `.rgb`; remove the `u_colorRamp*` uniforms and any heat/ramp branch. (These plane views need no lighting — flat `emission = texel.rgb` plus a small density-grey is fine.)

- [ ] **Step 9: Remove the global-ramp binding from Viewport's preview path**

In `src/ui/viewport/Viewport.ts`, `setRaymarchUniforms`/`renderSlicePlane` call `bindColorRamp(...)`. Remove those preview-path calls and the `u_colorRamp*` uniform wiring (the LUT and `bindColorRamp` machinery can stay for now — Task 4 revisits export; Task 3 removes the global ramp UI). Keep `bindSparseUniforms`. The preview no longer sets `u_colorRampEnabled`. Ensure the file still builds (remove now-dead references TypeScript flags).

- [ ] **Step 10: Build + real-GPU smoke**

Run `npm run build && npm run test` — green (existing suite; no unit test added this task). Then a real-GPU headless Playwright smoke (scratchpad install, port 5174 only): create a scene with two visible layers whose `colorRamp`s are clearly different (e.g. one blue-ish, one orange-ish — set via the app's state-debug hook if present, else a preset), Raymarched preview. Assert: both colors visibly present; where a third Subtract layer carves, the region goes empty (not recolored); a layer with a fully-transparent ramp deposits no color but still shapes. Capture screenshots. Be HONEST if a live smoke can't run — report build+unit only.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: per-layer color — RGBA8 storage + per-layer ramp compositing + dense preview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sparse cache RGBA8

Widen the sparse brick pipeline to 4 bytes/voxel so playback is color-correct. Pure-TS parts are TDD.

**Files:**
- Modify + Test: `src/core/volume/brickPack.ts` + `src/core/volume/brickPack.test.ts`
- Modify: `src/core/volume/BrickCache.ts` (atlas RG8 → RGBA8; `computeMaxBricks` bytes)
- (No further shader change — `sampleSparse` already returns `vec4` from Task 1.)

**Interfaces:**
- Consumes: RGBA8 volume frame bytes `[colorRGB, density]` from `VolumeGenerator.generateFrameData` (Task 1).
- Produces: RGBA8 atlas + indirection; `reconstruct` round-trips 4 bytes; `maxBricksForBudget`/`computeMaxBricks` use 4 bytes/brick.

- [ ] **Step 1: Update round-trip test to RGBA8 (TDD — expect FAIL)**

In `src/core/volume/brickPack.test.ts`, change the existing pack→reconstruct round-trip test(s) so the dense fixture is `res*res*depth*4` bytes and the reconstructed output is compared over 4 bytes/voxel. Add a test asserting the **active-brick threshold tests the density (alpha) byte** only: a brick with high color bytes but density 0 everywhere must be treated as EMPTY (no slot appended); a brick with any density above threshold is active. Add/adjust the dedup test for 4-byte bricks (identical 4-byte brick across frames → `bricksUsed` stays 1). Run → FAIL.

Run: `npx vitest run src/core/volume/brickPack.test.ts`
Expected: FAIL (packer still 2-byte).

- [ ] **Step 2: Widen `brickPack.ts` to 4 bytes**

Change every `* 2` byte-stride to `* 4` and copy 4 bytes:
- `maxBricksForBudget`: `const bytesPerBrick = brick * brick * brick * 4`.
- `AtlasBuilder.data()`: `new Uint8Array(atlasResX*atlasResY*atlasResZ*4)`; `srcI`/`dstI` use `*4`; copy indices `0..3`.
- `packFrame`: `brickData = new Uint8Array(BRICK*BRICK*BRICK*4)`; `srcI = (...)*4`; **active test on density only** → `if (dense[srcI + 3] > threshold) active = true` (drop the `.r`/`.g` OR test); copy 4 bytes into `brickData[dstI..dstI+3]`.
- `reconstruct`: `out = new Uint8Array(res*res*depth*4)`; copy 4 bytes per voxel from the atlas.
- The comments that say "RG (2 bytes/voxel)" → "RGBA (4 bytes/voxel)".

Run → PASS.

- [ ] **Step 3: `bakePlaybackResolution` still fits with 4-byte bricks**

`bakePlaybackResolution` takes `maxBricks` (already computed from the 4-byte budget by `computeMaxBricks`), so no signature change. Add/adjust a test: with a `maxBricks` derived from `SPARSE_CACHE_BUDGET_BYTES` at 4 bytes/brick, the returned res's full loop still fits (`macroDims product ≤ floor(maxBricks/targetFrames)`), and it is ≤ source and brick-aligned. Run → PASS.

- [ ] **Step 4: Atlas texture → RGBA8**

In `src/core/volume/BrickCache.ts`:
- `computeMaxBricks`: `const bytesPerBrick = brick * brick * brick * 4`.
- Atlas `texImage3D`: `gl.RGBA8` + `gl.RGBA` (was `gl.RG8` + `gl.RG`), data still `builder.data()`.
- Update the class comment ("RG8 atlas" → "RGBA8 atlas [colorRGB, density]"). NEAREST filtering + CLAMP_TO_EDGE unchanged. Indirection texture stays RGBA8 (unchanged).

- [ ] **Step 5: Build + test + real-GPU parity smoke**

`npm run build && npm run test` (all green; brickPack tests updated). Then a real-GPU smoke (scratchpad, port 5174): a colored multi-layer scene, hit play at 256³, confirm sparse playback shows the SAME colors as the dense (paused) render (RGBA parity, no color garbage), and at 512³ the loop still bakes a full `ANIM_LOOP_FRAMES_DEFAULT` (bake res will be one step lower than RG8 — report the value). Be honest if no live smoke.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: sparse cache RGBA8 (per-voxel color) — 4-byte bricks, density-alpha threshold

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: UI — per-layer ramp editor + remove temperature/global ramp + preset migration

**Files:**
- Modify: `src/ui/panels/PropertiesPanel.ts` (add per-layer ramp editor; remove temperature slider)
- Modify: wherever the global preview color-ramp control lives (grep `colorRamp` in `src/ui/`) — remove it
- Modify: `src/state/AppState.ts` and/or `src/state/PresetManager.ts` (migrate presets missing `colorRamp`)
- Modify + Test: a small migration helper + its test

**Interfaces:**
- Consumes: `Layer.colorRamp` (Task 1); the existing gradient editor component (grep `GradientEditor`).
- Produces: `migrateLayer(layer)` ensuring `colorRamp` exists (default Fire) and dropping reliance on `temperature`.

- [ ] **Step 1: Migration helper test (TDD)**

Add `src/state/layerMigration.test.ts`: a layer object lacking `colorRamp` (an old preset) → after `migrateLayer`, has `colorRamp` equal to the Fire preset (`enabled: true`); a layer that already has a `colorRamp` keeps it unchanged. Run → FAIL.

- [ ] **Step 2: Implement `migrateLayer`**

Add `src/state/layerMigration.ts`:

```typescript
import type { Layer } from '../types/index'
import { RAMP_PRESETS } from '../core/colorRamp'

// Old presets (pre-VFX-2) have no per-layer colorRamp (and a now-ignored
// `temperature`). Default a missing ramp to Fire so existing scenes still
// look like fire. Idempotent.
export function migrateLayer(layer: Layer): Layer {
  if (layer.colorRamp) return layer
  return { ...layer, colorRamp: { enabled: true, stops: [...RAMP_PRESETS.fire] } }
}
```

Call it wherever layers enter state from persistence/presets (grep `PresetManager` load / `AppState` hydration). Run → PASS.

- [ ] **Step 3: Per-layer ramp editor in Properties**

In `src/ui/panels/PropertiesPanel.ts`, add a "Color" section for the selected layer that mounts the existing gradient editor component bound to `layer.colorRamp`, writing back via the state manager (mirror how the global ramp editor was wired). Remove the per-layer **Temperature** slider.

- [ ] **Step 4: Remove the global preview ramp control**

Remove the global color-ramp UI (the preview-panel ramp editor + its `preview.colorRamp` wiring). Remove `preview.colorRamp` from `AppState` if nothing else reads it (Task 1 dropped the preview shader use; Task 4 handles export). Build will flag stragglers.

- [ ] **Step 5: Build + test + manual/smoke**

`npm run build && npm run test` (migration test green). Real-GPU smoke or manual: load an OLD preset (one saved before this branch) → it renders as fire (migrated), no crash; editing a layer's ramp changes only that layer's color live.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: per-layer color ramp editor UI + preset migration; remove temperature + global ramp

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Colored export

Export the RGBA8 color volume (folds in the parked VFX-1 colored-export task).

**Files:**
- Modify: `src/core/export/ExportManager.ts` (export color, not grayscale-from-red)
- Verify: `src/core/export/FlipbookExporter.ts` (already renders the colored raymarch — confirm, adjust if it referenced the removed global ramp)
- Modify: `src/ui/viewport/Viewport.ts` (`snapshotRaymarchParams`/`renderRaymarchToTarget`: drop the removed `colorRampEnabled/colorRampTexture` fields from `RaymarchParams` if Task 1 left them; the flipbook path renders stored color now)

**Interfaces:**
- Consumes: RGBA8 volume `[colorRGB, density]`.
- Produces: exported RGBA8 assets carrying per-voxel color; density shaping (cutoff/contrast) applied to the alpha channel at export time.

- [ ] **Step 1: Export the color volume**

In `src/core/export/ExportManager.ts`, the readback is already RGBA. Stop mapping red→gray (`redToGray`): output the stored `[colorR, colorG, colorB, density]`. Where shaping is re-applied, apply `applyDensityShaping` (or the existing CPU equivalent) to the **alpha/density** channel; keep RGB as stored color. For the single-slice PNG paths that used `redToGray(this.readSlice(...))`, emit the RGBA slice directly (color + shaped alpha). Remove the now-unused `redToGray` import if nothing else uses it.

- [ ] **Step 2: Confirm the flipbook path**

Read `FlipbookExporter.ts` + `Viewport.renderRaymarchToTarget`: it renders the on-screen raymarch, which now emits stored color, so the flipbook is colored by construction. Remove any reference to the removed `u_colorRampEnabled`/global-ramp snapshot fields (Task 1). If `RaymarchParams` still carries `colorRampEnabled`/`colorRampTexture`, drop them and their uses (they were the global-ramp plumbing).

- [ ] **Step 3: Build + test + smoke**

`npm run build && npm run test` green. Real-GPU smoke or manual: export a single volume (PNG/RawRGBA8) and a flipbook of a two-color scene → the output carries the layer colors (not grayscale), carved regions transparent. Capture/inspect. Honest if no live run.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: colored export (RGBA8 volume + colored flipbook)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** storage RGBA8 (T1 S3), per-layer ramp + composite (T1 S1–7), preview emission (T1 S8–9), sparse RGBA8 + density-alpha threshold (T2), UI ramp editor + remove temperature/global ramp (T3), preset migration (T3 S1–2), colored export incl. VFX-1 Task 4 (T4). All spec sections mapped.
- **Layout invariant** `[R,G,B,A]=[colorR,colorG,colorB,density]` is stated in Global Constraints and used identically in composite output, volume texture, readback frame bytes, packFrame threshold (`+3`), reconstruct, atlas, and `sampleSparse`/`sampleVolume` (`.a` density, `.rgb` color). The two clear sites (SliceBuffer `clearFbo`, VolumeGenerator no-layers branch) set alpha 0 so density starts at 0 — the one easy-to-miss correctness point, called out explicitly.
- **Type consistency:** `Layer.colorRamp: ColorRamp` (T1) is consumed by generation LUTs (T1), migration (T3), and UI (T3); `sampleSparse`/`sampleVolume` are `vec4` from T1 and stay `vec4` in T2 (only the atlas format changes). `migrateLayer` name used consistently in T3.
- **Intermediate state:** between T1 and T2 the atlas is still RG8 while `sampleSparse` returns `vec4`, so sparse *playback* may show wrong color until T2 — noted; the branch merges as a whole, so no broken state ships.
- **Deferred (not in this plan):** playback smoothness (render-proxy/interpolation), brick apron/LINEAR atlas, on-disk gzip.
