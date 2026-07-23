# Vol3D v2 · Phase A — Engine Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live volume generation GPU-only (no per-slice CPU readback), make cutoff/contrast free to drag (non-destructive, baked on export), remove multi-layer 8-bit banding, and make authoring feel live at any resolution via a low-res drag proxy — with zero feature/output change.

**Architecture:** Render each slice's composite pass directly into the volume's 3D-texture Z-layer via `framebufferTextureLayer` (already used in `ExportManager.readSlice`), deleting the `readPixels`→JS-shaping→`uploadSlice` round-trip from the live path. cutoff/contrast move from generation-time baking to preview-time GLSL uniforms (and are re-applied at export). Ping-pong accumulators become RGBA16F. A capability check falls back to the v1 readback path if a driver rejects render-to-R8-layer or 16F targets. Animation-cache and export paths keep their (synchronous) readback — they genuinely need CPU bytes.

**Tech Stack:** TypeScript 5.6, Vite 6, WebGL2 + GLSL ES 3.00, Tauri 2, Vitest. No WebGPU (Phase E).

**Spec:** [docs/superpowers/specs/2026-07-24-vol3d-v2-phase-a-engine-core-design.md](../specs/2026-07-24-vol3d-v2-phase-a-engine-core-design.md)

## Global Constraints

- No new runtime dependencies. Zero `any`. No `as never` casts.
- Web + desktop (Tauri) dual operation must keep working (pure WebGL2, no WebGPU).
- **Output/behavior parity:** same volumes, same export formats, same on-screen result. Exports still include cutoff/contrast. The only intended visual change is *less* banding.
- Volume storage stays single-channel **R8**. Only the ping-pong accumulators become float (RGBA16F). No multi-channel work (that is Phase B).
- Readback is removed from the **live** generation path only; the animation-cache pre-bake (`generateFrameData`) and export keep their readback.
- A driver that fails the render-to-3D-R8-layer or RGBA16F completeness check MUST fall back to the working v1 path — never a broken render.
- Every task ends green: `npm run build` (`tsc -b && vite build`) AND `npm run test` pass before commit.
- Commit after each task with the message in its final step; append trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

New:
- `src/core/volumeShaping.ts` — single source of truth for the cutoff/contrast (density-shaping) math, shared by the export path and the parity test; documents the exact formula the GLSL mirrors.
- `src/core/volumeShaping.test.ts` — parity/behaviour test for the shaping math.

Modified:
- `src/core/volume/SliceBuffer.ts` — RGBA16F ping-pong accumulators + completeness check; expose a helper to bind an external 3D-texture layer as the composite render target.
- `src/core/volume/VolumeTexture.ts` — helper to bind a given Z-layer as a framebuffer color attachment (or expose `.texture` for the generator to attach).
- `src/core/renderer/VolumeGenerator.ts` — split live render-to-volume path (no readback) from the data-readback path (`generateFrameData`); capability detection + legacy fallback; stop baking cutoff/contrast (generation outputs raw density).
- `src/shaders/generation/composite.frag.glsl` — remains raw density output (no shaping added here).
- `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` — apply `u_cutoff`/`u_contrast` shaping at sample time.
- `src/core/export/ExportManager.ts` — apply shaping (via `volumeShaping`) so exports match preview; receive cutoff/contrast.
- `src/state/StateManager.ts` — field-aware `settings` regen trigger (regen on resolution/depth/globalSeed; not cutoff/contrast).
- `src/ui/viewport/Viewport.ts` (+ `ViewportOverlay.ts`, `PropertiesPanel.ts`) — set the new preview uniforms; interaction (dragging) signal; proxy volume + preview-source swap.
- `src/core/constants.ts` — proxy resolution factor.

---

## Task 1: Shared density-shaping module + parity test

**Files:**
- Create: `src/core/volumeShaping.ts`
- Create: `src/core/volumeShaping.test.ts`
- Modify: `src/core/renderer/VolumeGenerator.ts` (import the shared fn instead of the local copy)

**Interfaces:**
- Produces: `applyDensityShaping(value: number, cutoff: number, contrast: number): number` — the exact v1 formula, extracted verbatim from `VolumeGenerator.applyVolumeAdjustments`. Also `SHADING_GLSL: string` — a documented GLSL snippet implementing the identical math, for shaders to `#include`/concat (kept beside the TS so they can't drift).

- [ ] **Step 1: Write the failing test**

`src/core/volumeShaping.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { applyDensityShaping } from './volumeShaping'

describe('applyDensityShaping', () => {
  it('matches the v1 threshold+contrast formula', () => {
    // v1: thresholded = max((v-cutoff)/max(1-cutoff,1e-4),0); (t-0.5)*contrast+0.5, clamped 0..1
    expect(applyDensityShaping(0.5, 0.0, 1.0)).toBeCloseTo(0.5, 6)
    expect(applyDensityShaping(0.2, 0.35, 1.5)).toBe(0)          // below cutoff -> 0
    expect(applyDensityShaping(1.0, 0.0, 1.0)).toBeCloseTo(1.0, 6)
    expect(applyDensityShaping(0.5, 0.0, 2.0)).toBeCloseTo(0.5, 6) // midpoint invariant under contrast
  })
  it('clamps to [0,1]', () => {
    expect(applyDensityShaping(1.0, 0.0, 4.0)).toBeLessThanOrEqual(1)
    expect(applyDensityShaping(0.0, 0.0, 4.0)).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module (formula copied verbatim from VolumeGenerator)**

`src/core/volumeShaping.ts`:
```ts
// Single source of truth for global density shaping (cutoff + contrast).
// In v1 this ran on the CPU during generation, baking the result into the R8
// volume. In v2 the volume stores RAW density and this shaping is applied at
// PREVIEW time (see SHADING_GLSL) and re-applied at EXPORT time (via this fn),
// so dragging cutoff/contrast requires no regeneration.

export function applyDensityShaping(value: number, cutoff: number, contrast: number): number {
  const thresholded = Math.max((value - cutoff) / Math.max(1 - cutoff, 0.0001), 0)
  const contrasted = (thresholded - 0.5) * contrast + 0.5
  return Math.max(0, Math.min(1, contrasted))
}

// GLSL mirror of applyDensityShaping — MUST stay numerically identical.
// Concatenated into preview shaders (Task 3). Operates on a float density.
export const SHADING_GLSL = `
float applyDensityShaping(float v, float cutoff, float contrast) {
  float thresholded = max((v - cutoff) / max(1.0 - cutoff, 0.0001), 0.0);
  float contrasted = (thresholded - 0.5) * contrast + 0.5;
  return clamp(contrasted, 0.0, 1.0);
}
`
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Point VolumeGenerator at the shared fn (no behavior change yet)**

In `VolumeGenerator.ts`, replace the body of the local `applyVolumeAdjustments` with a call to `applyDensityShaping` (import from `../volumeShaping`), or delete the local one and use the import at its call site in `extractAdjustedRedSlice`. Behavior identical.

- [ ] **Step 6: Build + test**

Run: `npm run build && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/volumeShaping.ts src/core/volumeShaping.test.ts src/core/renderer/VolumeGenerator.ts
git commit -m "refactor: extract density-shaping math into shared module with parity test"
```

---

## Task 2: RGBA16F ping-pong accumulators + completeness fallback

**Files:**
- Modify: `src/core/volume/SliceBuffer.ts`

**Interfaces:**
- Produces: `SliceBuffer` allocates its accumulator (and layer-output) color textures as `RGBA16F`/`HALF_FLOAT` when `EXT_color_buffer_float` is present and the FBO is complete; otherwise falls back to `RGBA8`/`UNSIGNED_BYTE`. Expose `readonly usingFloat: boolean` for logging/tests. No signature changes to existing methods.

- [ ] **Step 1: Add float-with-fallback allocation**

In `SliceBuffer.ts`, factor the color-texture allocation so the internal format is chosen once: try `gl.RGBA16F` + `gl.HALF_FLOAT` (guarded by `gl.getExtension('EXT_color_buffer_float')`), build the FBO, `checkFramebufferStatus`; if the extension is absent or status ≠ `FRAMEBUFFER_COMPLETE`, recreate as `gl.RGBA8` + `gl.UNSIGNED_BYTE`. Set `this.usingFloat` accordingly. Apply to the ping-pong accumulator targets (the layer-gen intermediate may stay RGBA8 — it only carries a single layer's 0..1 output; keeping it 8-bit is fine, but if simpler, make both float).

- [ ] **Step 2: Verify readPixels still works for the fallback data path**

`SliceBuffer.readPixels` (used by the not-yet-changed generation path and by export/cache) reads `RGBA/UNSIGNED_BYTE`. With float accumulators, the FINAL read target is still the R8 volume path in v1 code — but at this task the generation still reads back from the accumulator. Ensure `readPixels` reads from a target whose format it can express as `UNSIGNED_BYTE`: if the accumulator is float, either (a) read as `FLOAT` and convert, or (b) keep a final RGBA8 resolve target that the float accumulator blits/draws into before readback. Choose (b) — add a small RGBA8 "resolve" FBO that the last accumulator is drawn into, and read that. Document the choice in a comment. (This resolve target disappears in Task 3 when the live path stops reading back.)

- [ ] **Step 3: Build + test**

Run: `npm run build && npm run test`
Expected: PASS.

- [ ] **Step 4: Manual smoke**

`npm run dev`: generate a multi-layer volume (e.g. 3 layers with Multiply/Overlay). Confirm it renders and looks the same or smoother (less banding in gradients). Confirm on a machine/browser without float support it still renders (fallback) — if you can't easily disable the extension, at least confirm the fallback branch compiles and is reachable by reading the code.

- [ ] **Step 5: Commit**

```bash
git add src/core/volume/SliceBuffer.ts
git commit -m "feat: RGBA16F ping-pong accumulators with RGBA8 fallback to kill multi-layer banding"
```

---

## Task 3: Direct-to-3D live generation + non-destructive shaping (the core)

This is one atomic behavioral change: generation writes **raw** density directly into the volume's 3D-texture layers (no readback, no baked shaping) on the live path, and cutoff/contrast become preview-time uniforms re-applied at export. Splitting it would leave an intermediate state with visually wrong (unshaded or double-shaded) output.

**Files:**
- Modify: `src/core/volume/VolumeTexture.ts` (bind-layer-as-target helper)
- Modify: `src/core/renderer/VolumeGenerator.ts` (live render-to-volume path + capability check + fallback; `generateFrameData` keeps readback and now outputs raw density)
- Modify: `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` (apply shaping via `SHADING_GLSL`)
- Modify: `src/ui/viewport/Viewport.ts` (set `u_cutoff`/`u_contrast` uniforms in all three render paths)
- Modify: `src/core/export/ExportManager.ts` (apply shaping so exports match preview)
- Modify: `src/state/StateManager.ts` (field-aware `settings` regen trigger)
- Modify: `src/core/renderer/ShaderCompiler.ts` (inject `SHADING_GLSL` into the three preview programs)

**Interfaces:**
- Consumes: `applyDensityShaping`, `SHADING_GLSL` (Task 1); float accumulators (Task 2).
- Produces: `VolumeTexture.bindAsRenderTarget(fb: WebGLFramebuffer, z: number)` (attaches layer `z` via `framebufferTextureLayer`); `VolumeGenerator` capability flag `canRenderToVolume: boolean`; preview shaders take `uniform float u_cutoff, u_contrast`.

- [ ] **Step 1: Write the failing test for the field-aware regen trigger**

Extend `src/state/reorder.test.ts` or add `src/state/regenTrigger.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { shouldRegenerateOnSettings } from './StateManager'  // export a pure helper

describe('shouldRegenerateOnSettings', () => {
  const base = { resolution: 64, depth: 64, customSliceCount: false, globalSeed: 0, cutoff: 0.35, contrast: 1.5 } as const
  it('does not regenerate when only cutoff/contrast change', () => {
    expect(shouldRegenerateOnSettings(base, { ...base, cutoff: 0.5 })).toBe(false)
    expect(shouldRegenerateOnSettings(base, { ...base, contrast: 2.0 })).toBe(false)
  })
  it('regenerates when resolution/depth/globalSeed change', () => {
    expect(shouldRegenerateOnSettings(base, { ...base, resolution: 128 })).toBe(true)
    expect(shouldRegenerateOnSettings(base, { ...base, depth: 128 })).toBe(true)
    expect(shouldRegenerateOnSettings(base, { ...base, globalSeed: 7 })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test`
Expected: FAIL — `shouldRegenerateOnSettings` not exported.

- [ ] **Step 3: Implement the field-aware trigger**

In `StateManager.ts`, add and export `shouldRegenerateOnSettings(prev, next)` returning true iff `resolution`, `depth`, or `globalSeed` differ. Wire the `settings` entry in `REGEN_TRIGGERS` to use it (replacing `settings: () => true`). Run the test → PASS. (After this, dragging cutoff/contrast will not schedule a regen; the preview uniform work below makes the drag actually update the view.)

- [ ] **Step 4: Add the VolumeTexture render-target helper**

In `VolumeTexture.ts`, add `bindAsRenderTarget(fb, z)` that binds `fb`, calls `gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, z)`, and returns the completeness status (`checkFramebufferStatus`). Mirror the pattern in `ExportManager.readSlice`.

- [ ] **Step 5: Capability check + live render-to-volume path in VolumeGenerator**

- At generator init, probe once: create a scratch framebuffer, attach volume layer 0, `checkFramebufferStatus`; set `canRenderToVolume`. (Also require Task 2's float accumulators OR accept RGBA8 — R8 target itself is core-renderable.)
- Add a live generation path: for each slice `z`, run the layer + composite passes as today, but the composite pass's **final** draw targets the volume layer (`volume.bindAsRenderTarget(fb, z)`) and outputs **raw** density (no cutoff/contrast). No `readPixels`, no `extractAdjustedRedSlice`, no `uploadSlice`.
- If `!canRenderToVolume`, fall back to the v1 path (render to accumulator, readback, JS shaping *removed* → JS writes raw density, upload). Note: even the fallback now writes **raw** density (shaping moved to preview), so the JS shaping call is dropped in both paths; the fallback differs only in using readback+upload.
- `generate()` uses the live path; `generateFrameData()` keeps readback (cache needs CPU bytes) and now also outputs **raw** density (no shaping baked). The `runSliceLoop`/sink structure from v1 stays; add a "render into volume layer" action for the live path alongside the existing "read back into array" action.

- [ ] **Step 6: Inject shaping into the three preview shaders**

- In `ShaderCompiler`, concatenate `SHADING_GLSL` into the raymarch, slice, and projection fragment programs (same injection style as the noise snippets).
- In each of `raymarch.frag.glsl` / `slice.frag.glsl` / `projection.frag.glsl`, add `uniform float u_cutoff; uniform float u_contrast;` and wrap the sampled density: `float d = applyDensityShaping(texture(u_volume, p).r, u_cutoff, u_contrast);` at the point each shader currently reads `.r`.
- In `Viewport.ts`, set `u_cutoff` / `u_contrast` from `state.get('settings')` in `renderRaymarched` and `renderSlicePlane` (both slice and projection).

- [ ] **Step 7: Export parity — apply shaping at export**

In `ExportManager.ts`: the volume now holds raw density, so `export()` must apply shaping to match the preview. Pass `cutoff`/`contrast` into the `ExportManager` (widen its construction/params — `Viewport.handleExport` has `state`), and in the slice read path map each red value through `applyDensityShaping(v/255, cutoff, contrast)` before writing the exported bytes (R8/RGBA8: `*255` round; R32F: keep 0..1). Grayscale image path (`redToGray`) applies it too. Exports must be byte-identical to v1 for the same settings (this is the parity guarantee — verify in smoke).

- [ ] **Step 8: Build + test**

Run: `npm run build && npm run test`
Expected: PASS (shaping parity + regen-trigger tests green).

- [ ] **Step 9: Manual smoke (critical — GL parity)**

`npm run dev`:
1. Generate at 128³/256³/512³ — UI does not freeze; 512³ completes without a multi-second lock.
2. Drag **cutoff** and **contrast** — the preview updates instantly with **no** "Generating…" indicator (no regen).
3. Drag scale/rotation/seed — regen fires (indicator shows). Visual result matches v1.
4. Export PNG + sprite + raw R8/R32F at some cutoff/contrast; compare against a v1 export of the same preset/settings — should match (grayscale, shaping applied). Diff raw byte sizes and spot-check a slice.
5. All three preview modes (Tab) show shaping correctly.
6. Animation: play a loop with evolutions ≥ 2 — cached frames display with shaping (via the uniform).
Report each result explicitly.

- [ ] **Step 10: Commit**

```bash
git add src/core/volume/VolumeTexture.ts src/core/renderer/VolumeGenerator.ts src/core/renderer/ShaderCompiler.ts src/shaders/preview/*.glsl src/ui/viewport/Viewport.ts src/core/export/ExportManager.ts src/state/StateManager.ts src/state/regenTrigger.test.ts
git commit -m "feat: direct-to-3D live generation with non-destructive cutoff/contrast shaping"
```

---

## Task 4: Low-res drag proxy

**Files:**
- Modify: `src/core/constants.ts` (proxy factor)
- Modify: `src/ui/viewport/Viewport.ts` (proxy volume + scheduler res selection + preview source swap)
- Modify: `src/ui/viewport/ViewportOverlay.ts` / `src/ui/panels/PropertiesPanel.ts` / `src/ui/components/Slider.ts` (surface a "dragging" signal, if not already distinguishable via onInput vs onChange)
- Modify: `src/state/StateManager.ts` (carry/expose an interaction flag, or route it through the dirty scheduler)

**Interfaces:**
- Produces: `PROXY_RES_FACTOR = 2` and `PROXY_MIN_RES = 32` in `constants.ts`; a generation scheduler that regenerates at `max(PROXY_MIN_RES, floor(N / PROXY_RES_FACTOR))` while interacting and at full `N` when settled; the preview samples the proxy volume during interaction and the full volume otherwise.

- [ ] **Step 1: Surface an interaction signal**

`Slider` already fires `onInput` (drag) and `onChange` (release), and `BezierCurveEditor` similarly. Introduce a lightweight "interacting" signal the viewport can read: e.g. `Viewport.setInteracting(true/false)` called on pointer-down/up of any generation-affecting control, or a boolean on the dirty scheduler. Keep it minimal — do not add a new global event bus; a method or a state flag is enough. (Choose the smallest wiring; document the choice.)

- [ ] **Step 2: Proxy volume + scheduler res selection**

In `Viewport`: keep the full-res `volume` plus a `proxyVolume` (a `VolumeTexture` at proxy res, lazily (re)created when N changes). `scheduleGeneration` (or `runGeneration`) picks the target: if interacting → generate into `proxyVolume` at proxy res; else → full `volume`. Reuse the existing 150 ms debounce. The generator already parameterizes resolution.

- [ ] **Step 3: Preview source swap**

The render paths sample `this.previewVolume` = `proxyVolume` while interacting (and it holds a fresh proxy), else `volume`. On settle, once the full-res regen completes, switch back to `volume`. A brief sharpen-on-release is acceptable; ensure no flash from a stale/empty proxy (generate the proxy immediately on interaction start, and don't sample it until its first generation completes).

- [ ] **Step 4: Build + test**

Run: `npm run build && npm run test`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

`npm run dev` at 256³ and 512³: drag scale/rotation/warp — feedback is immediate at reduced res and sharpens to full res on release. cutoff/contrast remain instant (no proxy needed — they don't regen). Confirm no visual corruption at the proxy↔full swap, and that a settled volume is always full-res. Export uses the full-res volume (never the proxy).

- [ ] **Step 6: Commit**

```bash
git add src/core/constants.ts src/ui/viewport/Viewport.ts src/ui/viewport/ViewportOverlay.ts src/ui/panels/PropertiesPanel.ts src/ui/components/Slider.ts src/state/StateManager.ts
git commit -m "feat: low-res drag proxy for live full-resolution authoring feel"
```

---

## Self-Review Notes

- **Spec coverage:** A1 direct-to-3D → Task 3; A2 non-destructive shaping → Tasks 1+3; A3 RGBA16F → Task 2; A4 drag proxy → Task 4; A5 scope boundary (cache/export keep readback) → Task 3 steps 5/7; A6 capability fallback → Tasks 2+3. All spec sections mapped.
- **Atomicity call:** Task 3 is deliberately larger than the others because the baked→non-destructive flip is not safely separable (any split leaves an unshaded or double-shaded intermediate). Its steps are ordered so `npm run build`/`test` pass at the end; the manual GL smoke (step 9) is the real gate and must be run.
- **Parity risk:** the one behavior that MUST match v1 is export output. Task 3 step 7 + step 9.4 exist to guarantee it. If exports diverge, the shaping formula or the raw-vs-baked handling is wrong — fix before proceeding.
- **Testability limit:** GL rendering and framebuffer completeness can't be unit-tested headless; those tasks rely on `npm run build` + the explicit manual smoke checklists. Pure logic (shaping math, regen trigger) is unit-tested (Tasks 1, 3).
- **Deferred (correctly, per spec):** async readback for cache/export, multi-channel, float storage, WebGPU — all Phase B+/E.
