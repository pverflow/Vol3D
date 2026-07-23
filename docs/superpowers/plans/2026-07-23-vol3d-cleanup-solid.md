# Vol3D Cleanup & SOLID Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix verified export bugs, harden the untrusted-input and GPU-context boundaries, and refactor three god objects into single-responsibility units — without adding speculative abstractions.

**Architecture:** The codebase is already sound (injected state, correct GPU teardown, precise types, zero `any`). This plan is surgical: (1) fix concrete correctness bugs, (2) delete dead code and centralize constants, (3) data-drive the hardcoded switches (OCP), (4) decompose `Viewport`/`TopBar`/`StateManager` by responsibility (SRP), (5) validate the one untrusted input and recover from context loss, (6) strip debug tooling from prod. **No GL abstraction interface** — one implementation, YAGNI; keep the concrete `WebGL2RenderingContext` dependency everywhere. It is the correct call, not a DIP violation.

**Tech Stack:** TypeScript 5.6, Vite 6, WebGL2 + GLSL ES 3.00, Tauri 2, fflate. Vanilla DOM UI (no framework). Vitest added by this plan for the pure-logic checks.

## Global Constraints

- **No new runtime dependencies.** Only `vitest` may be added, and only as a devDependency.
- **WebGL2 + browser/desktop dual operation must keep working** — every change must run identically in the web build and the Tauri build.
- **Preserve layer/preset data behavior** — presets saved by the current app must still load after every task (normalization already handles legacy shapes; do not regress it).
- **Every task ends green:** `npm run build` (runs `tsc -b && vite build`) must pass, and any `npm run test` added must pass, before the commit.
- **Zero `any`** — the current `src/` tree has none; keep it that way. No `as never` casts (one exists at `Viewport.ts:646` and is removed by this plan).
- **Commit after every task** with the message shown in the task's final step.

---

## File Structure

New files this plan creates:

- `vitest.config.ts` — test runner config (node env; Vite handles `?raw` glsl imports).
- `src/utils/imageChannels.ts` — pure `redToGray` helper for image exports (Phase 0).
- `src/core/constants.ts` — shared magic-number constants (Phase 1).
- `src/state/presetValidation.ts` — `parsePreset` validator for untrusted JSON (Phase 4).
- `src/state/stateMigration.ts` — layer/remap/curve normalization moved out of `StateManager` (Phase 4).
- `src/ui/viewport/AnimationController.ts` — animation playback + frame cache extracted from `Viewport` (Phase 3).
- `src/ui/viewport/ViewportOverlay.ts` — overlay DOM extracted from `Viewport`, reusing `Slider` (Phase 3).
- `src/ui/KeyBindings.ts` — app-level keyboard shortcuts extracted from `Viewport` (Phase 3).
- `src/ui/panels/HelpModal.ts`, `src/ui/panels/ExportModal.ts`, `src/ui/panels/PresetsMenu.ts` — extracted from `TopBar` (Phase 3).
- `src/ui/components/anchoredPopup.ts` — shared popup positioning/close helper (Phase 3).

Test files (colocated, `*.test.ts`, vitest auto-discovers):

- `src/utils/imageChannels.test.ts`, `src/state/presetValidation.test.ts`, `src/state/stateMigration.test.ts`, `src/ui/viewport/animationCache.test.ts`, `src/state/reorder.test.ts`.

---

## PHASE 0 — Export correctness (verified bugs)

### Task 1: Test runner + grayscale image export

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add `vitest` devDep + `test` scripts)
- Create: `src/utils/imageChannels.ts`
- Create: `src/utils/imageChannels.test.ts`
- Modify: `src/core/export/ExportManager.ts:78,120` (use the helper)

**Interfaces:**
- Produces: `redToGray(rgba: Uint8Array): Uint8Array` — returns a NEW RGBA buffer where each pixel's red value is copied into G and B, alpha forced to 255. Length unchanged.

- [ ] **Step 1: Add vitest to package.json**

Add to `devDependencies`: `"vitest": "^2.1.0"`. Add to `scripts`:
```json
"test": "vitest run",
"test:watch": "vitest"
```
Run `npm install`.

- [ ] **Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Write the failing test**

`src/utils/imageChannels.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { redToGray } from './imageChannels'

describe('redToGray', () => {
  it('splats red into green and blue, forces alpha 255', () => {
    // one red-only pixel (r=200,g=0,b=0,a=255) as read back from an R8 texture
    const src = new Uint8Array([200, 0, 0, 255])
    const out = redToGray(src)
    expect(Array.from(out)).toEqual([200, 200, 200, 255])
  })

  it('does not mutate the input', () => {
    const src = new Uint8Array([120, 0, 0, 255])
    redToGray(src)
    expect(Array.from(src)).toEqual([120, 0, 0, 255])
  })
})
```

- [ ] **Step 4: Run test, verify it fails**

Run: `npm run test`
Expected: FAIL — cannot import `redToGray` (module missing).

- [ ] **Step 5: Implement the helper**

`src/utils/imageChannels.ts`:
```ts
// Volume slices are read back RGBA from an R8 texture, so G=B=0, A=255.
// For human-viewable image exports, splat red into G and B so density
// renders as grayscale instead of red-on-black.
export function redToGray(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i]
    out[i] = r
    out[i + 1] = r
    out[i + 2] = r
    out[i + 3] = 255
  }
  return out
}
```

- [ ] **Step 6: Use it in the image export paths**

In `ExportManager.exportPNGSequence`, change line 78 area so the buffer fed to `ImageData` is grayscale:
```ts
      const rgba = redToGray(this.readSlice(z, flipY))
```
In `ExportManager.exportSpriteSheet`, change line 120 area:
```ts
      const rgba = redToGray(this.readSlice(z, flipY))
```
Add the import at the top of `ExportManager.ts`:
```ts
import { redToGray } from '../../utils/imageChannels'
```
Leave `exportRaw` using the raw `readSlice` (the red channel carries the real data for raw formats).

- [ ] **Step 7: Run test + build**

Run: `npm run test && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/utils/imageChannels.ts src/utils/imageChannels.test.ts src/core/export/ExportManager.ts
git commit -m "fix: export grayscale PNG/sprite images instead of red-on-black"
```

### Task 2: flipY on raw exports, ext cleanup, throw on unknown format

**Files:**
- Modify: `src/core/export/ExportManager.ts:14-29,141-177`

**Interfaces:**
- Produces: `exportRaw(filename: string, mode: 'r8' | 'rgba8' | 'r32f', flipY: boolean)` — new `flipY` param threaded from `export()`.

- [ ] **Step 1: Thread flipY into exportRaw and its readSlice call**

Change the three raw cases in `export()` (lines 20-25) to pass `flipY`:
```ts
      case ExportFormat.RawR8:
        return this.exportRaw(filename, 'r8', flipY)
      case ExportFormat.RawRGBA8:
        return this.exportRaw(filename, 'rgba8', flipY)
      case ExportFormat.RawR32F:
        return this.exportRaw(filename, 'r32f', flipY)
```
Change the `default` case (lines 26-27) to throw instead of silently producing a PNG:
```ts
      default:
        throw new Error(`Unsupported export format: ${format}`)
```
Update the `exportRaw` signature (line 141) and its readback (line 152):
```ts
  private async exportRaw(filename: string, mode: 'r8' | 'rgba8' | 'r32f', flipY: boolean): Promise<void> {
```
```ts
      const rgba = this.readSlice(z, flipY)
```

- [ ] **Step 2: Fix the dead extension ternary**

Replace line 168:
```ts
    const ext = 'raw'
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (no type errors; `exportRaw` has three call sites all updated).

- [ ] **Step 4: Manual smoke check**

Run `npm run dev`, open the app, export each of the 5 formats. Verify: PNG/sprite open as grayscale; the two flip states differ for both PNG and raw; unknown format is unreachable from the UI.

- [ ] **Step 5: Commit**

```bash
git add src/core/export/ExportManager.ts
git commit -m "fix: honor flipY for raw exports and throw on unknown export format"
```

---

## PHASE 1 — Dead code + constants

### Task 3: Delete dead code

**Files:**
- Modify: `src/core/volume/SliceBuffer.ts:72-74` (delete `clearAccumulator`)
- Modify: `src/core/renderer/ShaderCompiler.ts:247-251` (delete `setUniformMat4`)
- Modify: `src/core/renderer/WebGLContext.ts:35-41` (delete `checkExtensions`)
- Modify: `src/shaders/distortion/domain_warp.glsl:8` (delete unused `u_warpOctaves`)
- Modify: `src/types/volume.ts:9` (delete `RawR16F` — enum-only, no UI, not handled)
- Modify: `src/ui/components/BezierCurveEditor.ts:107,113` (delete `handle.dataset.index` writes)
- Modify: `src/ui/viewport/CameraController.ts:119-124` (delete unused `view`/`proj`/`viewProj`/`invViewProj` outputs)
- Keep: `ShaderCompiler.invalidateCache` — Task 14 wires it to context restore.

- [ ] **Step 1: Confirm each item is unreferenced**

Run each grep, expect zero hits outside the definition line:
```bash
grep -rn "clearAccumulator\|setUniformMat4\|checkExtensions\|RawR16F\|dataset.index" src/
grep -rn "u_warpOctaves" src/
```
`getMatrices` outputs: confirm the only caller destructures only `{ eye, forward, right, up }`:
```bash
grep -rn "getMatrices" src/
```
Expected: sole caller is `Viewport.ts:565`.

- [ ] **Step 2: Delete SliceBuffer.clearAccumulator**

Remove the method at `SliceBuffer.ts:72-74`.

- [ ] **Step 3: Delete ShaderCompiler.setUniformMat4**

Remove the method at `ShaderCompiler.ts:247-251`.

- [ ] **Step 4: Delete WebGLContext.checkExtensions**

Remove the method at `WebGLContext.ts:35-41` (and the now-orphaned closing considerations — the class keeps `gl`, `canvas`, `setupLostContext`).

- [ ] **Step 5: Remove the dead shader uniform**

In `src/shaders/distortion/domain_warp.glsl`, delete the `uniform int u_warpOctaves;` line (8). Verify the function body does not reference it (it doesn't).

- [ ] **Step 6: Remove RawR16F from the enum**

Delete `RawR16F = 'raw_r16f',` from `src/types/volume.ts:9`.

- [ ] **Step 7: Remove dead dataset writes**

In `BezierCurveEditor.ts`, delete the two `handle.dataset.index = ...` assignments (107, 113). `readEventPoint` takes `index` as a parameter; nothing reads the dataset.

- [ ] **Step 8: Trim getMatrices**

In `CameraController.getMatrices` (119-124), remove construction of `view`, `proj`, `viewProj`, and `mat4Invert(viewProj)` from the return object; return only `{ eye, forward, right, up }`. Delete any `mat4*` imports that become unused (verify with `grep -n "mat4" src/ui/viewport/CameraController.ts`).

- [ ] **Step 9: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove dead methods, unused shader uniform, and stale enum member"
```

### Task 4: Centralize magic numbers

**Files:**
- Create: `src/core/constants.ts`
- Modify: `src/state/StateManager.ts:155`, `src/ui/viewport/Viewport.ts:335,423,480,481,567,581`

**Interfaces:**
- Produces: exported constants `REGEN_DEBOUNCE_MS = 150`, `ANIMATION_MIN_FRAME_MS = 100`, `ANIMATION_CACHE_BUDGET_BYTES = 96 * 1024 * 1024`, `ANIMATION_CACHE_MAX_FRAMES = 24`, `RAYMARCH_TAN_HALF_FOV = Math.tan(Math.PI / 6)`, `LIGHT_DIR: readonly [number, number, number] = [0.577, 0.577, 0.577]`.

- [ ] **Step 1: Create the constants module**

`src/core/constants.ts`:
```ts
// Debounce before regenerating the volume after a state change.
export const REGEN_DEBOUNCE_MS = 150
// Minimum wall-clock between animation phase advances (~10fps playback).
export const ANIMATION_MIN_FRAME_MS = 100
// Memory budget for the pre-baked animation frame cache.
export const ANIMATION_CACHE_BUDGET_BYTES = 96 * 1024 * 1024
export const ANIMATION_CACHE_MAX_FRAMES = 24
// Raymarch camera: tan(fov/2) with a 60deg vertical FOV.
export const RAYMARCH_TAN_HALF_FOV = Math.tan(Math.PI / 6)
export const LIGHT_DIR: readonly [number, number, number] = [0.577, 0.577, 0.577]
```

- [ ] **Step 2: Replace the literals**

Import the needed constants in `StateManager.ts` and `Viewport.ts` and replace: the `150` at `StateManager.ts:155` and `Viewport.ts:335`; `minFrameMs = 100` at `Viewport.ts:423`; `96 * 1024 * 1024` at `:480`; `24` at `:481`; `Math.tan(Math.PI / 6)` at `:567`; `0.577, 0.577, 0.577` at `:581` (spread `...LIGHT_DIR`).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/constants.ts src/state/StateManager.ts src/ui/viewport/Viewport.ts
git commit -m "refactor: extract shared magic numbers into constants module"
```

---

## PHASE 2 — Data-drive the switches (Open/Closed)

### Task 5: Type the export event seam

**Files:**
- Modify: `src/ui/panels/TopBar.ts:426-431,464-472` (build `<option>`s from data, type the event)
- Modify: `src/ui/viewport/Viewport.ts:91-94,639-654` (type the handler, drop `as never`)
- Modify: `src/types/volume.ts` (add label metadata if needed; `ExportFormat`/`ExportConfig` already exist)

**Interfaces:**
- Consumes: `ExportFormat` enum and `ExportConfig` interface (already in `types/volume.ts`).
- Produces: `EXPORT_FORMAT_OPTIONS: { value: ExportFormat; label: string }[]` exported from `types/volume.ts`; a typed `vol3d-export` CustomEvent carrying `ExportConfig`.

- [ ] **Step 1: Add the option metadata to types**

Append to `src/types/volume.ts`:
```ts
export const EXPORT_FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: ExportFormat.PNGSequence, label: 'PNG Sequence (ZIP)' },
  { value: ExportFormat.SpriteSheet, label: 'Sprite Sheet (PNG)' },
  { value: ExportFormat.RawR8, label: 'Raw R8 (grayscale bytes)' },
  { value: ExportFormat.RawRGBA8, label: 'Raw RGBA8' },
  { value: ExportFormat.RawR32F, label: 'Raw R32F (float)' },
]
```

- [ ] **Step 2: Build the `<option>` list from data in TopBar**

Replace the five hardcoded `<option>` lines (426-431) by generating them from `EXPORT_FORMAT_OPTIONS` (map to `<option value="${o.value}">${o.label}</option>`). Import `EXPORT_FORMAT_OPTIONS`, `ExportFormat`, and `ExportConfig` from `../../types/index`.

- [ ] **Step 3: Dispatch a typed event**

At the dispatch site (464-472), validate the selected value is a real `ExportFormat` (guard: `Object.values(ExportFormat).includes(value as ExportFormat)`) and dispatch `new CustomEvent<ExportConfig>('vol3d-export', { detail: { format, filenameBase, flipY } })`. Note the field is `filenameBase` per `ExportConfig` — rename the payload field accordingly.

- [ ] **Step 4: Type the consumer and drop `as never`**

In `Viewport.ts`, change the listener (91-94) to read `(e as CustomEvent<ExportConfig>).detail` and change `handleExport` (639) to take `opts: ExportConfig`, calling `mgr.export(opts.format, opts.filenameBase, opts.flipY)` — no cast.

- [ ] **Step 5: Build + smoke**

Run: `npm run build`, then `npm run dev` and export one PNG + one raw to confirm the seam still works end to end.

- [ ] **Step 6: Commit**

```bash
git add src/types/volume.ts src/ui/panels/TopBar.ts src/ui/viewport/Viewport.ts
git commit -m "refactor: type the export event and drive format options from data"
```

### Task 6: Data-drive regeneration triggers

**Files:**
- Modify: `src/state/StateManager.ts:39-58`

**Interfaces:**
- Produces: a module-level `REGEN_TRIGGERS: Partial<Record<StateKey, (prev: unknown, next: unknown) => boolean>>` consulted by `applyUpdate`.

- [ ] **Step 1: Define the trigger table**

Above the class in `StateManager.ts`:
```ts
const REGEN_TRIGGERS: Partial<Record<keyof AppState, (prev: any, next: any) => boolean>> = {
  layers: () => true,
  settings: () => true,
  animation: (prev, next) => prev.evolutions !== next.evolutions,
}
```
(`any` is confined to this internal table's comparator params; the public API stays typed. If you prefer strict, type each comparator per key — acceptable either way.)

- [ ] **Step 2: Replace the hardcoded branch**

Rewrite the tail of `applyUpdate` (48-57) to:
```ts
    const trigger = REGEN_TRIGGERS[key]
    if (trigger && trigger(prevValue, value)) {
      this.scheduleDirty(`${source}:${String(key)}`)
    }
```
Leave the `settings` normalization at 39-41 as-is (it is a separate concern from regen triggering).

- [ ] **Step 3: Build + smoke**

Run: `npm run build`. Then `npm run dev`: change a layer, change resolution, change evolutions — each regenerates; change camera/preview — no regen.

- [ ] **Step 4: Commit**

```bash
git add src/state/StateManager.ts
git commit -m "refactor: data-drive regeneration triggers instead of hardcoded key checks"
```

### Task 7: Data-drive the base-noise-alias decision in shader assembly

**Files:**
- Modify: `src/core/renderer/ShaderCompiler.ts:44-50,88-95`

**Interfaces:**
- Produces: `DISTORTION_NEEDS_BASE_NOISE: Set<DistortionType>` declared beside `DISTORTION_SNIPPETS`.

- [ ] **Step 1: Declare the set next to the snippets**

After `DISTORTION_SNIPPETS` (line 50):
```ts
// Distortions whose GLSL calls _baseNoiseEval and thus need the alias
// injected when the layer noise is not FBM.
const DISTORTION_NEEDS_BASE_NOISE = new Set<DistortionType>([
  DistortionType.DomainWarp,
  DistortionType.Curl,
])
```

- [ ] **Step 2: Use it in buildLayerGenShader**

Replace the hardcoded condition (90-91):
```ts
    if (DISTORTION_NEEDS_BASE_NOISE.has(distortion) && noiseType !== NoiseType.FBM) {
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build`. Then `npm run dev`: add a non-FBM layer, set distortion to Domain Warp and to Curl — both must render without a shader link error (check console).

- [ ] **Step 4: Commit**

```bash
git add src/core/renderer/ShaderCompiler.ts
git commit -m "refactor: data-drive which distortions need the base-noise alias"
```

### Task 8: Collapse the four build* shader methods

**Files:**
- Modify: `src/core/renderer/ShaderCompiler.ts:120-168`

**Interfaces:**
- Produces: `private buildSimpleProgram(key: string, vertSrc: string, fragSrc: string, name: string): CompiledProgram`. `buildCompositeShader/buildRaymarchShader/buildSliceShader/buildProjectionShader` keep the same public signatures and delegate to it.

- [ ] **Step 1: Add the shared builder**

```ts
  private buildSimpleProgram(key: string, vertSrc: string, fragSrc: string, name: string): CompiledProgram {
    const cached = this.cache.get(key)
    if (cached) return cached
    const vert = this.compile(vertSrc, this.gl.VERTEX_SHADER)
    const frag = this.compile(fragSrc, this.gl.FRAGMENT_SHADER)
    const prog = this.link(vert, frag, name)
    const compiled = { program: prog, uniforms: this.collectUniforms(prog, fragSrc) }
    this.cache.set(key, compiled)
    return compiled
  }
```

- [ ] **Step 2: Rewrite the four methods as one-liners**

```ts
  buildCompositeShader(): CompiledProgram {
    const header = `#version 300 es\nprecision highp float;\n`
    const frag = [header, blendModes, compositeFrag.replace('#version 300 es', '').replace('precision highp float;', '')].join('\n')
    return this.buildSimpleProgram('composite', fullscreenVert, frag, 'Composite')
  }
  buildRaymarchShader(): CompiledProgram {
    return this.buildSimpleProgram('raymarch', raymarchVert, raymarchFrag, 'Raymarch')
  }
  buildSliceShader(): CompiledProgram {
    return this.buildSimpleProgram('slice', fullscreenVert, sliceFrag, 'Slice')
  }
  buildProjectionShader(): CompiledProgram {
    return this.buildSimpleProgram('projection', fullscreenVert, projectionFrag, 'Projection')
  }
```

- [ ] **Step 3: Build + smoke**

Run: `npm run build`. Then `npm run dev`: cycle all three preview modes (Tab) — all render.

- [ ] **Step 4: Commit**

```bash
git add src/core/renderer/ShaderCompiler.ts
git commit -m "refactor: collapse four near-identical shader builders into one"
```

### Task 9: Collapse the generate / generateFrameData loops

**Files:**
- Modify: `src/core/renderer/VolumeGenerator.ts:37-137`

**Interfaces:**
- Produces: `private runSliceLoop(resolution: number, depth: number, sink: (z: number, red: Uint8Array) => void, onProgress?: ProgressCallback, onComplete?: () => void): void` — the shared chunked scheduler. `generate` and `generateFrameData` become thin wrappers that supply a sink.

- [ ] **Step 1: Extract the scheduler**

Add a private method that holds the `SLICES_PER_FRAME`, `currentSlice`, `processChunk`, and `rafId` logic once. It calls `this.generateSlice(...)` and `this.sliceBuffer.readPixels()` per slice, applies `extractAdjustedRedSlice`, then hands `(z, red)` to `sink`. It requires `layers/globalSeed/animPhase/animEvolutions/cutoff/contrast` — pass them in, or capture via a small options object. Keep `SLICES_PER_FRAME = resolution <= 64 ? resolution : 8`.

- [ ] **Step 2: Rewrite generate() to use it**

`generate` supplies a sink that calls `volume.uploadSlice(z, red)` and wires `onProgress`/`onComplete`.

- [ ] **Step 3: Rewrite generateFrameData() to use it**

`generateFrameData` allocates `frame = new Uint8Array(resolution*resolution*depth)`, supplies a sink that does `frame.set(red, z*resolution*resolution)`, and resolves the promise in `onComplete`.

- [ ] **Step 4: Build + smoke**

Run: `npm run build`. Then `npm run dev`: generate a volume (non-animated) and play an animation with evolutions ≥ 2 (exercises the frame-cache path). Both must produce correct output.

- [ ] **Step 5: Commit**

```bash
git add src/core/renderer/VolumeGenerator.ts
git commit -m "refactor: share one chunked slice scheduler between generate and generateFrameData"
```

---

## PHASE 3 — SRP: decompose the god objects

> These are extract-and-rewire tasks: move existing code into a focused module and have the origin call it. Cite the source line ranges; do not rewrite the logic. After each task the app must behave identically.

### Task 10: Extract AnimationController from Viewport

**Files:**
- Create: `src/ui/viewport/AnimationController.ts`
- Create: `src/ui/viewport/animationCache.ts` (pure frame-count math, testable)
- Create: `src/ui/viewport/animationCache.test.ts`
- Modify: `src/ui/viewport/Viewport.ts` (remove the moved members; delegate)

**Interfaces:**
- Produces: pure `computeCacheFrameCount(resolution: number, depth: number): number` in `animationCache.ts` (the body of the current `getAnimationCacheFrameCount`, `Viewport.ts:478-482`, using the Phase-1 constants).
- Produces: `class AnimationController` constructed with `{ state: StateManager, cacheGenerator: VolumeGenerator, getVolume: () => VolumeTexture }`. Public methods (moved verbatim from `Viewport`): `advanceAnimation(now: number)`, `handleAnimationChange(next: AnimationSettings)`, `buildAnimationCacheIfNeeded()`, `invalidateAnimationCache()`, `tryApplyCachedAnimationFrame(phase: number): boolean`. Owns fields `lastAnimationTick, lastAnimationState, animationCacheFrames, animationCacheKey, animationCacheBuildId, animationCacheBuilding, currentCachedFrame`.
- Consumes: needs `scheduleGeneration()` — pass it in as a callback `onNeedsGeneration: () => void`.

- [ ] **Step 1: Write the failing test for the pure math**

`src/ui/viewport/animationCache.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { computeCacheFrameCount } from './animationCache'

describe('computeCacheFrameCount', () => {
  it('caps at the max frame count for small volumes', () => {
    // 32^3 = 32768 bytes/frame; budget allows far more than the 24 cap
    expect(computeCacheFrameCount(32, 32)).toBe(24)
  })
  it('is limited by the memory budget for large volumes', () => {
    // 512^3 = 134,217,728 bytes/frame > 96MB budget -> 0 frames
    expect(computeCacheFrameCount(512, 512)).toBe(0)
  })
  it('never returns negative', () => {
    expect(computeCacheFrameCount(512, 512)).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the pure module**

`src/ui/viewport/animationCache.ts`:
```ts
import { ANIMATION_CACHE_BUDGET_BYTES, ANIMATION_CACHE_MAX_FRAMES } from '../../core/constants'

export function computeCacheFrameCount(resolution: number, depth: number): number {
  const bytesPerFrame = resolution * resolution * depth
  const byBudget = Math.floor(ANIMATION_CACHE_BUDGET_BYTES / Math.max(bytesPerFrame, 1))
  return Math.min(ANIMATION_CACHE_MAX_FRAMES, Math.max(0, byBudget))
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Create AnimationController**

Move `advanceAnimation` (404-435), `handleAnimationChange` (437-458), `invalidateAnimationCache` (460-467), `getAnimationCacheKey` (469-476), `buildAnimationCacheIfNeeded` (484-537), `tryApplyCachedAnimationFrame` (539-554), and the seven cache fields (25-30) into the class. Replace `getAnimationCacheFrameCount` calls with `computeCacheFrameCount(this.getVolume().resolution, this.getVolume().depth)`. Replace `this.volume` with `this.getVolume()`, `this.scheduleGeneration()` with `this.onNeedsGeneration()`, keep `this.cacheGenerator`/`this.state` as injected deps.

- [ ] **Step 6: Rewire Viewport**

In `Viewport` constructor create `this.animation = new AnimationController({ state, cacheGenerator: this.cacheGenerator, getVolume: () => this.volume, onNeedsGeneration: () => this.scheduleGeneration() })`. Replace: `renderFrame` calls `this.animation.advanceAnimation(performance.now())` (was `this.advanceAnimation`); the `animation` subscription (85) calls `this.animation.handleAnimationChange(...)`; the `layers`/`settings` subscriptions (72,77) call `this.animation.invalidateAnimationCache()`; `runGeneration`'s completion (363) calls `this.animation.buildAnimationCacheIfNeeded()`; `resizeVolume` (330) resets via the controller. Remove the moved methods and fields from `Viewport`.

- [ ] **Step 7: Build + smoke + test**

Run: `npm run build && npm run test`. Then `npm run dev`: play an animation at 32³ (cached path, evolutions ≥ 2) and at 512³ (uncached path). Verify smooth loop + no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/ui/viewport/AnimationController.ts src/ui/viewport/animationCache.ts src/ui/viewport/animationCache.test.ts src/ui/viewport/Viewport.ts
git commit -m "refactor: extract AnimationController out of Viewport (SRP)"
```

### Task 11: Extract ViewportOverlay and reuse the Slider component

**Files:**
- Create: `src/ui/viewport/ViewportOverlay.ts`
- Modify: `src/ui/viewport/Viewport.ts` (remove `buildOverlay` 103-314 and `attachRangeReset` 708-714; delegate)
- Reference: `src/ui/components/Slider.ts` (existing full-featured control with built-in right-click reset at `Slider.ts:105`)

**Interfaces:**
- Produces: `class ViewportOverlay { readonly el: HTMLElement; constructor(state: StateManager) }`. Internally builds the mode/projection/axis segmented buttons and the four sliders using the existing `Slider` component (not raw `<input type=range>`), subscribes to `'preview'` for `syncOverlay`, and exposes the generating indicator. All state reads/writes go through the injected `state`, exactly as today.

- [ ] **Step 1: Move the overlay DOM into ViewportOverlay**

Move the entire `buildOverlay` body (103-314) into the new class's constructor, assigning the root element to `this.el`. Replace each of the four hand-rolled sliders (`posSlider`, `densitySlider`, `stepSlider`, `tilePreviewDensitySlider`, lines 168-270) with `Slider` instances configured with the same min/max/step/label and the same onInput state update. Use `Slider`'s built-in right-click reset (pass the default) and delete the local `attachRangeReset`.

- [ ] **Step 2: Delegate from Viewport**

In `Viewport` constructor replace `this.el.appendChild(this.buildOverlay())` with `this.overlay = new ViewportOverlay(state); this.el.appendChild(this.overlay.el)`. Delete `buildOverlay` and `attachRangeReset` from `Viewport`.

- [ ] **Step 3: Build + smoke**

Run: `npm run build`. Then `npm run dev`: verify all overlay controls work (mode switch, axis, slice position, density, steps, repeat alpha), that right-click resets each slider, and that controls show/hide correctly per preview mode.

- [ ] **Step 4: Commit**

```bash
git add src/ui/viewport/ViewportOverlay.ts src/ui/viewport/Viewport.ts
git commit -m "refactor: extract ViewportOverlay and reuse Slider instead of raw range inputs"
```

### Task 12: Extract app-level keyboard shortcuts

**Files:**
- Create: `src/ui/KeyBindings.ts`
- Modify: `src/ui/viewport/Viewport.ts:96-97,656-698` (keep only view-local keys), `src/main.ts` (wire KeyBindings)

**Interfaces:**
- Produces: `class KeyBindings { constructor(state: StateManager, viewport: { cyclePreviewMode(): void; toggleTilePreview(): void; focusCamera(): void }) ; destroy(): void }`. Owns the `keydown` listener. Handles: Delete (remove layer), Ctrl+D (duplicate), Ctrl+Shift+N (add `defaultLayer()`), Ctrl+E (dispatch `vol3d-show-export`), Tab (cycle), T (tile), F (focus). The Tab/T/F cases call the small viewport methods so the viewport keeps owning view-local behavior.
- Produces on Viewport: public `cyclePreviewMode()`, `toggleTilePreview()`, `focusCamera()` (extracted from the current `handleKey` Tab/T/F bodies, 661-676).

- [ ] **Step 1: Add the three view-local methods to Viewport**

Extract the Tab (661-667), T (669-672), F (674-676) bodies into `cyclePreviewMode()`, `toggleTilePreview()`, `focusCamera()`. Remove `handleKey` and the `window.addEventListener('keydown', ...)` (97) from `Viewport`. This removes the `defaultLayer`/`defaultState` import coupling from `Viewport` (verify: `grep -n "defaultLayer\|defaultState" src/ui/viewport/Viewport.ts` — should only remain if still used elsewhere; if not, drop the import).

- [ ] **Step 2: Create KeyBindings**

Move the app-level cases (Delete/Ctrl+D/Ctrl+Shift+N/Ctrl+E, 678-697) plus the Tab/T/F dispatch into the new class. Guard the input-focus early-return (657) as today. Store the listener reference and remove it in `destroy()`.

- [ ] **Step 3: Wire in main.ts**

After the viewport is created in `main.ts`, add `new KeyBindings(state, viewport)`. (`viewport` already exists as a local.)

- [ ] **Step 4: Build + smoke**

Run: `npm run build`. Then `npm run dev`: exercise every shortcut (Tab, T, F, Delete, Ctrl+D, Ctrl+Shift+N, Ctrl+E). All behave as before; typing in an input still suppresses shortcuts.

- [ ] **Step 5: Commit**

```bash
git add src/ui/KeyBindings.ts src/ui/viewport/Viewport.ts src/main.ts
git commit -m "refactor: move app-level keyboard shortcuts out of Viewport into KeyBindings"
```

### Task 13: Collapse the three render paths behind a preview-renderer map

**Files:**
- Modify: `src/ui/viewport/Viewport.ts:376-402,556-637` and the Tab-cycle (now in `cyclePreviewMode`)

**Interfaces:**
- Produces: `private readonly previewRenderers: Record<PreviewMode, (w: number, h: number) => void>` built once in the constructor; `renderFrame` looks up `this.previewRenderers[preview.mode]`. `cyclePreviewMode` iterates `Object.keys(this.previewRenderers)` (or a `PREVIEW_MODE_ORDER` array) instead of a duplicated literal.

- [ ] **Step 1: Extract a shared pass preamble**

Add `private beginPass(prog: CompiledProgram) { const gl = this.ctx.gl; gl.useProgram(prog.program); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return gl }` and use it at the top of all three render methods (replaces the repeated `useProgram`/`bindFramebuffer null` lines at 560-561, 593-594, 617-618).

- [ ] **Step 2: Merge renderSlice + renderProjection**

They are ~90% identical (589-637). Fold into one `renderSlicePlane(isProjection: boolean)` that sets the shared uniforms (`u_sliceAxis`, `u_exposure`, `u_planeAspect`, `u_screenAspect`, `axisMap`) and only adds `u_projMode`/`u_steps` when `isProjection`. Lift the shared `const axisMap: Record<SliceAxis, number> = { x: 0, y: 1, z: 2 }` to a module constant (it is duplicated verbatim at 597 and 621).

- [ ] **Step 3: Build the renderer map**

In the constructor: `this.previewRenderers = { [PreviewMode.Raymarched]: (w, h) => this.renderRaymarched(w, h), [PreviewMode.Slice]: () => this.renderSlicePlane(false), [PreviewMode.Projection]: () => this.renderSlicePlane(true) }`. Rewrite `renderFrame`'s switch (389-399) as `this.previewRenderers[preview.mode]?.(w, h)`.

- [ ] **Step 4: Build + smoke**

Run: `npm run build`. Then `npm run dev`: cycle all three modes via buttons and Tab; verify slice and projection still render at the correct aspect for X/Y/Z axes and both projection modes.

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewport/Viewport.ts
git commit -m "refactor: drive preview rendering from a mode->renderer map and merge slice/projection"
```

### Task 14: Split TopBar into HelpModal / ExportModal / PresetsMenu

**Files:**
- Create: `src/ui/panels/HelpModal.ts`, `src/ui/panels/ExportModal.ts`, `src/ui/panels/PresetsMenu.ts`
- Create: `src/ui/components/anchoredPopup.ts`
- Modify: `src/ui/panels/TopBar.ts` (wire buttons to the new modules; keep the toolbar controls)
- Modify: `src/ui/panels/LayerItem.ts:219-241`, `src/ui/panels/LayerPanel.ts:167-188` (reuse `anchoredPopup`)

**Interfaces:**
- Produces: `openAnchoredPopup(anchor: HTMLElement, popup: HTMLElement): () => void` in `anchoredPopup.ts` — positions `popup` under `anchor` clamped to the viewport (the verbatim block at `LayerItem.ts:220-230` / `LayerPanel.ts:168-178`, margin 8), appends it, wires the `setTimeout(10)` + outside-`mousedown` close, and returns a `close()` fn.
- Produces: `class HelpModal { open(): void }` (the HTML at `TopBar.ts:475-557`), `class ExportModal { constructor(state: StateManager); open(): void }` (412-473, dispatches the typed `vol3d-export` event from Task 5), `class PresetsMenu { constructor(state: StateManager, presets: PresetManager); open(anchor: HTMLElement): void }` (323-410, owns import/export IO).

- [ ] **Step 1: Create anchoredPopup and adopt it in the two layer popups**

Extract the shared positioning/close logic. Replace the bodies of `LayerItem.showBlendMenu` (220-230 positioning) and `LayerPanel.showAddMenu` (168-178 positioning) to call `openAnchoredPopup`. Verify blend-mode menu and add-layer menu still position and close correctly (`npm run dev`).

- [ ] **Step 2: Extract HelpModal**

Move the help modal builder (475-557) into `HelpModal`. `TopBar`'s help button calls `new HelpModal().open()` (or a shared instance).

- [ ] **Step 3: Extract ExportModal**

Move the export dialog (412-473) into `ExportModal`, using the typed event + `EXPORT_FORMAT_OPTIONS` from Task 5. `TopBar`'s export button and the `vol3d-show-export` listener (34) call `exportModal.open()`.

- [ ] **Step 4: Extract PresetsMenu**

Move the presets menu + import/export handlers (323-410) into `PresetsMenu`, using `openAnchoredPopup` for placement. Drop the unused `_state` parameter noted in review. Add user-facing feedback on preset import/export failure (currently swallowed to `console.error` at 384/394) — a simple `window.alert` on catch is sufficient here.

- [ ] **Step 5: Slim TopBar**

`TopBar` now builds only the toolbar controls and wires three buttons to the three modules. Verify it no longer contains modal/menu HTML.

- [ ] **Step 6: Build + smoke**

Run: `npm run build`. Then `npm run dev`: open Help, open Export (and export), open Presets (save/load/delete/import/export), and confirm the blend + add-layer popups still work.

- [ ] **Step 7: Commit**

```bash
git add src/ui/panels/HelpModal.ts src/ui/panels/ExportModal.ts src/ui/panels/PresetsMenu.ts src/ui/components/anchoredPopup.ts src/ui/panels/TopBar.ts src/ui/panels/LayerItem.ts src/ui/panels/LayerPanel.ts
git commit -m "refactor: split TopBar into HelpModal/ExportModal/PresetsMenu and share popup helper"
```

### Task 15: Route LayerPanel drag-reorder through StateManager; single source of truth for defaults

**Files:**
- Create: `src/state/reorder.test.ts`
- Modify: `src/ui/panels/LayerPanel.ts:82-101` (use `state.reorderLayers`)
- Modify: `src/ui/panels/PropertiesPanel.ts` (read reset defaults from `defaultLayer()`)

**Interfaces:**
- Consumes: existing `StateManager.reorderLayers(from, to)` (`StateManager.ts:119`).

- [ ] **Step 1: Write a reorder test against the existing method**

`src/state/reorder.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { StateManager } from './StateManager'
import { defaultLayer } from './AppState'

describe('StateManager.reorderLayers', () => {
  it('moves a layer from index to index preserving the others', () => {
    const sm = new StateManager()
    sm.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') },
    ])
    sm.reorderLayers(0, 2)
    expect(sm.get('layers').map(l => l.name)).toEqual(['B', 'C', 'A'])
  })
})
```

- [ ] **Step 2: Run test, verify it passes (method already exists)**

Run: `npm run test`
Expected: PASS. This locks the behavior before the UI is rewired.

- [ ] **Step 3: Rewire the drag handler**

In `LayerPanel` (82-101), translate the drop target to source/dest indices (remember the visual list is reversed) and call `this.state.reorderLayers(from, to)`. Delete the inline reverse/splice/`insertAt` math.

- [ ] **Step 4: Read reset defaults from defaultLayer in PropertiesPanel**

Replace the hardcoded slider `defaultValue` literals (scale 3.0, amplitude 1.0, octaves 4, persistence 0.5, lacunarity 2.0, distortion strength 0.3, warpFrequency 2.0, swirlAmount 1.0, both bézier curves) with reads from a single `const D = defaultLayer()` reference (e.g. `D.noise.scale[0]`, `D.remap.remapCurve`). Import `defaultLayer` from `../../state/AppState`.

- [ ] **Step 5: Build + smoke + test**

Run: `npm run build && npm run test`. Then `npm run dev`: drag-reorder layers (order matches drag); right-click each slider in Properties (resets to the AppState default).

- [ ] **Step 6: Commit**

```bash
git add src/state/reorder.test.ts src/ui/panels/LayerPanel.ts src/ui/panels/PropertiesPanel.ts
git commit -m "refactor: route layer reorder through StateManager and source reset defaults from defaultLayer"
```

---

## PHASE 4 — Robustness & security

### Task 16: Validate untrusted preset JSON at the import boundary

**Files:**
- Create: `src/state/presetValidation.ts`
- Create: `src/state/presetValidation.test.ts`
- Modify: `src/state/PresetManager.ts:150-177` (use it in both `loadPreset` and `importPreset`)

**Interfaces:**
- Produces: `parsePreset(raw: string): { ok: true; data: Partial<AppState> } | { ok: false; error: string }`. It: JSON-parses inside try/catch; requires the root to be an object; if `layers` is present, requires `Array.isArray` and drops non-object entries; coerces each enum field (`blendMode`, `noise.type`, `noise.fbm.baseNoise`, `distortion.type`, `featherShape`, `worleyMode`) against its allowed value set, falling back to the default on a miss; clamps numeric ranges (`octaves` 1–8, `opacity` 0–1, `resolution`/`depth` to the allowed literal sets). It does NOT need to fully normalize — `StateManager.loadState` still runs `normalizeLayer` afterward; `parsePreset` only makes the input safe to hand there.

- [ ] **Step 1: Write failing tests**

`src/state/presetValidation.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parsePreset } from './presetValidation'

describe('parsePreset', () => {
  it('rejects invalid JSON', () => {
    const r = parsePreset('{ not json')
    expect(r.ok).toBe(false)
  })
  it('rejects a non-array layers field', () => {
    const r = parsePreset(JSON.stringify({ layers: 5 }))
    expect(r.ok).toBe(false)
  })
  it('accepts a well-formed preset', () => {
    const r = parsePreset(JSON.stringify({ settings: { resolution: 64 }, layers: [] }))
    expect(r.ok).toBe(true)
  })
  it('coerces a bogus enum to the default rather than passing it through', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ blendMode: 'HACK', noise: { type: 'perlin' } }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.layers![0].blendMode).not.toBe('HACK')
  })
  it('clamps octaves into range', () => {
    const r = parsePreset(JSON.stringify({ layers: [{ noise: { type: 'fbm', fbm: { octaves: 1e9 } } }] }))
    if (r.ok) expect(r.data.layers![0].noise.fbm.octaves).toBeLessThanOrEqual(8)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement parsePreset**

Create `src/state/presetValidation.ts`. Import the enums from `../types/index` and `defaultLayer` from `./AppState`. Build allowed-value `Set`s from `Object.values(Enum)`. Implement the guards/coercions described in the Interfaces block. Return the discriminated union.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Use it in PresetManager**

Rewrite `loadPreset` (150-157) and `importPreset` (168-177) to call `parsePreset` and, on `ok`, `this.state.loadState(result.data)`; on failure, `window.alert('Could not load preset: ' + result.error)` (import already reads text; there is no more bare `JSON.parse` without a guard).

- [ ] **Step 6: Build + smoke**

Run: `npm run build && npm run test`. Then `npm run dev`: import a valid exported preset (loads), and import a hand-edited file with `"layers": 5` and with a garbage `blendMode` (both fail gracefully or coerce, no crash).

- [ ] **Step 7: Commit**

```bash
git add src/state/presetValidation.ts src/state/presetValidation.test.ts src/state/PresetManager.ts
git commit -m "fix: validate untrusted preset JSON at the import boundary"
```

### Task 17: Extract state migration + add preset version field

**Files:**
- Create: `src/state/stateMigration.ts`
- Create: `src/state/stateMigration.test.ts`
- Modify: `src/state/StateManager.ts:221-301` (move the free functions out), `serialize()` (179-182)
- Modify: `src/state/PresetManager.ts` (stamp/read `version`)

**Interfaces:**
- Produces: `stateMigration.ts` exporting `normalizeLayer`, `normalizeRemap`, `normalizeBezierCurve`, `legacyPowerToBezier` (moved verbatim from `StateManager.ts:221-297`, plus the `clamp01` helper). `StateManager` imports `normalizeLayer` from it.
- Produces: a `CURRENT_PRESET_VERSION = 1` constant and a `version?: number` field written into the serialized payload; migration branches may key on it going forward (heuristic sniffing stays as the fallback for version-less blobs).

- [ ] **Step 1: Write a migration test (locks legacy behavior)**

`src/state/stateMigration.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizeBezierCurve, legacyPowerToBezier } from './stateMigration'

describe('bezier normalization', () => {
  it('passes a valid 4-tuple through clamped', () => {
    expect(normalizeBezierCurve([0.25, 0.25, 0.75, 0.75], [0, 0, 1, 1])).toEqual([0.25, 0.25, 0.75, 0.75])
  })
  it('converts a legacy scalar power to a bezier curve', () => {
    const c = legacyPowerToBezier(2)
    expect(c).toHaveLength(4)
    c.forEach(v => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) })
  })
  it('falls back on a malformed curve', () => {
    expect(normalizeBezierCurve('nope' as never, [0, 0, 1, 1])).toEqual([0, 0, 1, 1])
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test`
Expected: FAIL — module missing.

- [ ] **Step 3: Move the functions**

Cut `normalizeLayer`/`normalizeRemap`/`normalizeBezierCurve`/`legacyPowerToBezier`/`clamp01` (221-301) into `stateMigration.ts` and `export` them. Import `normalizeLayer` back into `StateManager`. Leave `normalizeVolumeSettings` (303-316) in `StateManager` (it is live-state settings normalization, not legacy migration) — or move it too if you prefer; keep it wherever `loadState` and `applyUpdate` can call it.

- [ ] **Step 4: Run test, verify it passes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Add the version field**

In `StateManager.serialize` include `version: CURRENT_PRESET_VERSION` in the emitted object (define the constant in `stateMigration.ts`). `loadState`/`parsePreset` ignore unknown/absent versions today; the field just future-proofs migrations.

- [ ] **Step 6: Build + smoke + test**

Run: `npm run build && npm run test`. Then `npm run dev`: load each built-in preset and a previously exported user preset — all still load (legacy normalization intact); a freshly exported preset now carries `"version":1`.

- [ ] **Step 7: Commit**

```bash
git add src/state/stateMigration.ts src/state/stateMigration.test.ts src/state/StateManager.ts src/state/PresetManager.ts
git commit -m "refactor: extract state migration module and stamp preset version"
```

### Task 18: WebGL context-loss recovery + complete teardown

**Files:**
- Modify: `src/ui/viewport/Viewport.ts` (listen for restore; hold listener refs; complete `destroy`)
- Modify: `src/ui/viewport/CameraController.ts` (add `destroy()`)
- Modify: `src/core/renderer/VolumeGenerator.ts` (guard the chunk loop with `gl.isContextLost()`)

**Interfaces:**
- Produces: `CameraController.destroy()` that removes the `window` `mousemove`/`mouseup` listeners it adds (`CameraController.ts:31,54`).
- Consumes: existing `ShaderCompiler.invalidateCache()` (kept alive from Task 3).

- [ ] **Step 1: Use an AbortController for Viewport's window listeners**

In the `Viewport` constructor create `this.listeners = new AbortController()` and pass `{ signal: this.listeners.signal }` to the `window.addEventListener('vol3d-export', ...)` (91) call (the keydown one moved to KeyBindings in Task 12). Add a `window.addEventListener('webgl-restored', () => this.handleContextRestored(), { signal: this.listeners.signal })`.

- [ ] **Step 2: Implement handleContextRestored**

```ts
  private handleContextRestored() {
    this.compiler.invalidateCache()
    this.animation.invalidateAnimationCache()
    const s = this.state.get('settings')
    this.resizeVolume(s)      // rebuilds VolumeTexture + generator slice buffers
    this.scheduleGeneration()
  }
```

- [ ] **Step 3: Guard the generator chunk loop**

At the top of the shared `runSliceLoop` chunk callback (from Task 9), early-out if the context is lost:
```ts
      if (this.gl.isContextLost()) { this.rafId = null; return }
```

- [ ] **Step 4: Complete Viewport.destroy and store the subscriptions/observer**

Store the six `state.subscribe(...)` unsubscribe functions (71-88, 302) in an array, the `ResizeObserver` in a field, and the VAO. `destroy()` (700-705) now also: `this.listeners.abort()`, disconnect the observer, call each unsubscribe, clear `dirtyTimer`, `this.camera.destroy()`, `gl.deleteVertexArray(this.vao)`, and (via the controller) cancel the cache generator.

- [ ] **Step 5: Add CameraController.destroy**

Store the `mousemove`/`mouseup` handler references (or use an `AbortController` in `CameraController` too) and remove them in `destroy()`.

- [ ] **Step 6: Build + smoke**

Run: `npm run build`. Then `npm run dev`: use the app normally (no behavior change). If practical, simulate context loss via the DevTools WebGL loseContext extension or `gl.getExtension('WEBGL_lose_context')` in the console and confirm the volume rebuilds instead of freezing.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewport/Viewport.ts src/ui/viewport/CameraController.ts src/core/renderer/VolumeGenerator.ts
git commit -m "fix: recover from WebGL context loss and make teardown reverse construction"
```

### Task 19: Harden fileAccess (browser cancel + dedupe)

**Files:**
- Modify: `src/platform/fileAccess.ts:28-72,97-123`

**Interfaces:**
- Produces: a single private `saveViaTauri(bytesOrText, opts, writer)` helper backing both `saveBytes` and `saveText` (currently ~40 lines duplicated, 28-49 vs 51-72).

- [ ] **Step 1: Resolve the browser open-dialog cancel hang**

In `openTextFile` (97-123, browser branch), in addition to the input `change` listener, add a one-shot `window` `focus` fallback that resolves `null` if no file was chosen shortly after focus returns (native cancel fires no `change`). Ensure the promise always settles.

- [ ] **Step 2: Dedupe saveBytes/saveText**

Extract the shared Tauri-vs-browser branching into one helper parameterized by the write function (`writeFile` vs `writeTextFile`) and the blob type; have `saveBytes` and `saveText` delegate. Keep `describePlatformError` wrapping on the Tauri path; add matching try/catch on the browser path (currently absent).

- [ ] **Step 3: Build + smoke (both builds)**

Run: `npm run build`. Then `npm run dev` (web): import a preset and cancel the dialog — no hang. If a Tauri toolchain is available, `npm run tauri:dev` and repeat save/open via native dialogs.

- [ ] **Step 4: Commit**

```bash
git add src/platform/fileAccess.ts
git commit -m "fix: resolve browser open-dialog cancel hang and dedupe save helpers"
```

---

## PHASE 5 — Production hygiene

### Task 20: Gate and memoize stateDebug

**Files:**
- Modify: `src/utils/stateDebug.ts` (compute config once), `src/state/StateManager.ts:184-218` (dev-gate the debug calls)

**Interfaces:**
- Produces: `getStateDebugConfig()` computes `new URLSearchParams(...)` + localStorage reads at most once (module-level memo), not per state update.

- [ ] **Step 1: Memoize the config read**

In `stateDebug.ts`, cache the parsed config in a module-level variable computed on first call; return the cache thereafter. This removes the per-mutation `URLSearchParams`/localStorage cost.

- [ ] **Step 2: Dev-gate the debug logging**

Wrap the bodies of the six `debugLog*` methods (or their call sites) so they are inert unless `import.meta.env.DEV`. Simplest: at the top of each `debugLog*` add `if (!import.meta.env.DEV) return` (Vite statically replaces `import.meta.env.DEV` with `false` in the prod build, so the bodies dead-strip). Verify the debug URL param (`?stateDebug=...`) still works in `npm run dev`.

- [ ] **Step 3: Build + verify strip**

Run: `npm run build`. Grep the built bundle to confirm the debug strings are gone from prod:
```bash
grep -rc "state] notify\|stateDebug" dist/ || echo "debug strings stripped"
```
Expected: not present (or the `|| echo` fires).

- [ ] **Step 4: Commit**

```bash
git add src/utils/stateDebug.ts src/state/StateManager.ts
git commit -m "perf: gate stateDebug behind DEV and memoize its config read"
```

### Task 21: Replace regex uniform scraping with ACTIVE_UNIFORMS introspection

**Files:**
- Modify: `src/core/renderer/ShaderCompiler.ts:203-216,115,132,143,154,165` and the `build*` signatures

**Interfaces:**
- Produces: `collectUniforms(program: WebGLProgram): Map<...>` — no `source` parameter; enumerates real active uniforms via `gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)` + `gl.getActiveUniform`. This also correctly handles arrays/structs and cannot be fooled by precision qualifiers or commented-out declarations.

- [ ] **Step 1: Rewrite collectUniforms**

```ts
  private collectUniforms(program: WebGLProgram): Map<string, WebGLUniformLocation | null> {
    const { gl } = this
    const uniforms = new Map<string, WebGLUniformLocation | null>()
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (!info) continue
      // Array uniforms report a name like "u_foo[0]"; normalize to "u_foo".
      const name = info.name.replace(/\[0\]$/, '')
      uniforms.set(name, gl.getUniformLocation(program, name))
    }
    return uniforms
  }
```

- [ ] **Step 2: Drop the source argument everywhere**

Remove the second argument from all five `collectUniforms(prog, ...)` call sites (115, 132, 143, 154, 165) and from `buildSimpleProgram` (Task 8). No `build*` method needs to thread `source` anymore.

- [ ] **Step 3: Build + smoke**

Run: `npm run build`. Then `npm run dev`: generate a volume and cycle all preview modes — every uniform still binds (if a uniform were missed, the preview would render black or wrong). Check the console for no GL warnings.

- [ ] **Step 4: Commit**

```bash
git add src/core/renderer/ShaderCompiler.ts
git commit -m "refactor: discover uniforms via ACTIVE_UNIFORMS instead of source regex"
```

---

## Self-Review Notes

- **Coverage:** every Critical/Important finding from the review maps to a task — export bugs (T1–T2), preset validation (T16), context loss (T18), the three god objects (T10–T15), and all four OCP switches (T5–T8, plus T13). Minor findings (dead code, magic numbers, dup save funcs, stateDebug, regex uniforms) are T3–T4, T19–T21.
- **Deliberately skipped (YAGNI, noted so they're not silently dropped):** no GL abstraction interface (one implementation); `preview.exposure` plumbing left in place (harmless, and a future exposure slider would use it — removing it now just to re-add later is churn); the per-pixel CPU post-processing in `VolumeGenerator` (T9 shares the loop but does not move cutoff/contrast into the shader — that is a perf optimization to do only if 512³ generation is a real complaint); raw-export memory ceiling at 512³ (add a warning only if users hit it).
- **Ordering rationale:** bugs first (ship value immediately), then dead-code/constants (shrink surface), then OCP (small, enables clean extraction), then SRP decomposition (largest, safest once the seams are typed), then robustness/security, then prod hygiene. Each phase is independently shippable.
- **Test strategy:** vitest covers only pure logic that had no coverage and is now extractable (channel splat, cache frame math, reorder, preset validation, migration). DOM/GL behavior is verified by the `npm run dev` smoke step in each task — no jsdom/headless-GL harness (YAGNI for a solo tool).
