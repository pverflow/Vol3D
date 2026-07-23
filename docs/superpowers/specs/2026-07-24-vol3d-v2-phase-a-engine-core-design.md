# Vol3D v2 · Phase A — Engine Core: Direct-to-3D Generation, Non-Destructive Shaping, Precision, Live Drag

**Date:** 2026-07-24
**Status:** Approved design. Next step: implementation plan (superpowers:writing-plans).
**Part of:** [Vol3D v2 Roadmap](./2026-07-24-vol3d-v2-roadmap.md) — first build cycle.

## Goal

Make volume generation GPU-only by removing the per-slice CPU readback round-trip; make cutoff/contrast free to drag; remove multi-layer 8-bit banding; and make authoring feel live at any resolution via a low-res drag proxy. **No feature or output changes** — same volumes, same export formats, same visual result. Just fast and smooth.

## Non-goals (explicitly out of scope for Phase A)

- Multi-channel / RGBA / vector output (Phase B). Volume stays single-channel R8 density.
- Layer-inputs, SDF primitives, colormap/lit preview (Phase C).
- Animated export, new interchange formats (Phase D).
- WebGPU, async PBO readback, workers, 1024³ (Phase E).
- Float *storage* of the volume (deferred; only the accumulators become float here).

## Background: the current pipeline (what we're replacing)

Per full regen (any `layers`/`settings` change, 150 ms debounce), for each of `depth` slices — `VolumeGenerator.generateSlice` / `runSliceLoop`:

1. Render each visible layer (layer_gen pass) + composite (ping-pong) into a **2D RGBA8** FBO (`SliceBuffer`).
2. **Synchronous** `gl.readPixels` of N×N×4 bytes (`SliceBuffer.readPixels`) — a full pipeline stall per slice.
3. JS per-pixel loop applies cutoff/contrast and extracts red (`extractAdjustedRedSlice` / `applyVolumeAdjustments` in `VolumeGenerator.ts`).
4. `texSubImage3D` uploads the N×N R8 slice into the 3D texture (`VolumeTexture.uploadSlice`).

The readback (step 2) + JS pass (step 3) dominate; the GPU sits idle waiting on the CPU round-trip. cutoff/contrast are baked into the stored R8 at step 3, so dragging them forces a full regen. Multi-layer blends round at 8-bit because the accumulator FBO is RGBA8.

## Settled design decisions

1. **cutoff/contrast = non-destructive, baked on export.** Become preview-time uniforms; stored volume holds raw layer density; export re-applies them (v1 export parity).
2. **Storage stays R8; ping-pong accumulators become RGBA16F.**
3. **Low-res drag proxy is in scope** for Phase A.

## Design

### A1. Direct-to-3D-texture generation (live path)

Replace the readback round-trip for the **live single-frame** generation path:

- Bind target Z-layer of the volume's R8 3D texture as the composite pass color attachment via `gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume.texture, 0, z)` — the same call already used in `ExportManager.readSlice`.
- The composite fragment shader writes the final density value directly into that slice. No `readPixels`, no JS loop, no `uploadSlice` on the live path.
- Keep the chunked `requestAnimationFrame` loop (slices-per-frame) so the UI stays responsive across many slices — but each slice is now draw-only.
- The layer-gen intermediate + ping-pong accumulator stay as offscreen FBOs; only the *final* composite result is written into the volume layer instead of read back.

**Generator structure:** `VolumeGenerator` gains a live render path that renders into the volume texture (no per-slice sink readback) distinct from the data path (A5). The shared chunk scheduler (`runSliceLoop`) is parameterized by a per-slice action: "write into volume layer Z" (live) vs "read back bytes" (cache/export).

### A2. Non-destructive shaping (cutoff/contrast)

- Port `applyVolumeAdjustments` math to GLSL, applied at **preview** time in the raymarch / slice / projection fragment shaders via new `u_cutoff` / `u_contrast` uniforms (set from `state.settings`).
- Stored 3D texture = raw composited layer density (no global cutoff/contrast baked).
- Dragging cutoff/contrast triggers **no regen** — just the next preview frame re-reads the uniforms.
- **Regen-trigger refinement:** the `settings` entry in `REGEN_TRIGGERS` (from v1 Task 6) becomes field-aware — compares prev/next and regenerates only when a generation-relevant field changed (`resolution`, `depth`, `globalSeed`); `cutoff`/`contrast` changes do **not** regenerate.
- **Export parity:** `ExportManager` receives `cutoff`/`contrast` and applies the same GLSL shaping in its read path (`readSlice`) so exported files match the preview exactly, as in v1. (Export still reads back — see A5.)
- Keep the shaping formula in **one shared TS source of truth** so the export path and a parity test reference identical constants (avoid the GLSL and any TS copy drifting).

### A3. Precision — RGBA16F accumulators

- The ping-pong accumulator FBOs in `SliceBuffer` change RGBA8 → RGBA16F (`EXT_color_buffer_float` is already requested in `Viewport`).
- Removes 8-bit rounding between composited layers. The final write into the R8 volume quantizes once at the end (acceptable; float storage deferred).

### A4. Live drag proxy

- While a control is actively being dragged, generate the volume at reduced resolution `proxyRes = max(32, floor(N / 2))` for instant feedback; on release/idle, regenerate at full `N`.
- **Interaction signal:** sliders/curve editors already distinguish `onInput` (dragging) from `onChange` (release). Route an "interacting" flag into the generation scheduler (`Viewport.scheduleGeneration` / `StateManager` dirty path). Dragging → schedule a proxy-res regen; settled → schedule full-res.
- **Preview source:** maintain a proxy volume texture at `proxyRes`; the preview samples the proxy while dragging and the full-res volume once settled. Swap cleanly on completion (a brief sharpen-on-release pop is acceptable).
- Proxy factor is a named constant (configurable), consistent with v1's `constants.ts` convention.

### A5. Scope boundary — where readback stays

Readback is removed from the **live preview** path only. Two paths genuinely need CPU bytes and keep a (synchronous, for now) readback:

- **Animation-cache pre-bake** (`VolumeGenerator.generateFrameData` → `AnimationController`): produces `Uint8Array` frames held in CPU memory for cached playback.
- **Export** (`ExportManager`): reads slices to encode files.

These are far less frequent than live editing. Making them async (PBO/fenceSync) is a deferred Phase-E optimization. The common case — every edit — never reads back after Phase A.

### A6. Guardrails & fallback

- **Capability check at init:** verify (a) the R8 3D-texture layer is framebuffer-complete as a color attachment (`checkFramebufferStatus`, an existing pattern) and (b) RGBA16F accumulators are complete. If either fails on a given driver, **fall back to the v1 readback path** (and RGBA8 accumulators) so the app still works. Robustness, not only speed.
- No new dependencies. Zero `any`. No `as never`. Web + Tauri both (pure WebGL2; no WebGPU).
- Preview modes, layers, animation, presets: behavior unchanged.

## Data flow (after Phase A)

**Live edit (common):** state change → field-aware regen trigger → scheduler picks proxy/full res by interaction state → chunked rAF loop renders layer+composite per slice **directly into the (proxy or full) 3D volume texture** → preview raymarch/slice/projection samples the volume and applies `u_cutoff`/`u_contrast`/`u_density` at draw time. No CPU round-trip.

**cutoff/contrast drag:** state change → regen trigger returns false → no regen → next preview frame uses new uniforms. Free.

**Export / animation cache (occasional):** render per slice → readback (as v1) → (export) apply shaping → encode / (cache) store frame bytes.

## Testing

- **Unit (pure logic):** parity test for the shaping formula — a single shared TS `applyVolumeAdjustments(value, cutoff, contrast)` reference, asserted against known input/output pairs; the GLSL uses the identical constants (documented alongside). This catches drift between the JS export path and the shader.
- **Unit:** field-aware regen trigger — changing `cutoff`/`contrast` returns "no regen"; changing `resolution`/`depth`/`globalSeed` returns "regen". (Testable on `StateManager` without GL, per v1's reorder test pattern.)
- **Manual smoke (no headless GL):** at 128³ / 256³ / 512³ — (1) generation no longer stalls the UI; (2) dragging cutoff/contrast is instant with no regen indicator; (3) dragging scale/rotation/etc. shows a low-res proxy that sharpens on release; (4) exported PNG/sprite/raw match the on-screen preview (cutoff/contrast applied); (5) animation playback still works; (6) force the capability fallback (e.g. simulate incomplete FBO) and confirm the legacy path still renders.

## Success criteria

- No synchronous `readPixels` on the live generation path (grep-verifiable).
- Dragging cutoff or contrast performs zero regeneration.
- 256³ regeneration feels near-interactive; 512³ is usable (not a multi-second freeze); dragging any slider is responsive at every resolution via the proxy.
- Multi-layer blends show no visible 8-bit banding.
- Exports and the animation cache are byte-faithful to v1 behavior (modulo the intended precision improvement), with cutoff/contrast still applied to exports.
- `npm run build` + `npm run test` green; zero `any`; web + Tauri both work.
