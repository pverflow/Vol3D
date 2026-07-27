# Vol3D — Sparse Brick-Grid Animation Cache

**Date:** 2026-07-26
**Status:** Approved direction; design for review. Next: implementation plan (superpowers:writing-plans).
**Driver:** animation playback at high resolution is single-digit FPS because the dense frame cache holds too few frames (0 at 512³ with RG8) → playback regenerates the full volume every frame.

## Goal

Make animation playback smooth at high resolution by caching the loop as **sparse bricks** (only non-empty regions), GPU-resident, sampled directly by the raymarch — so playback does **no per-frame regeneration and no dense per-frame upload**. Bake the loop once, then scrub/play from the cache. WebGL2, all platforms (browser + every Tauri webview).

## Why sparse (the decision)

- Fire/smoke/clouds are typically **80–95% empty**. A dense RG8 512³ frame = 256 MB → a loop is GBs → can't stay GPU-resident → current fallback is full regen per frame → single FPS.
- Storing only **active bricks** (regions with any density/heat) is **5–15× smaller, lossless**, fits a whole loop in a few hundred MB of VRAM, and the same structure gives **empty-space skipping** that also speeds the raymarch.
- Rejected alternatives (from research): gzip/LZ-per-frame (GPU can't decode serial entropy; decompress+dense-upload per frame = the same stall); temporal delta (per-frame decode/upload); dense keyframes (don't fit at 512³). BC/ASTC-3D hardware compression and WebGPU compute are **deferred** (WebGPU-only / Chrome-139+ / no Linux-Tauri). Native/wgpu is a separate future strategic bet, explicitly deferred.
- 8-bit is already banked (volume is RG8, not float).

## Non-goals (this build)

- No WebGPU, no native/Vulkan/wgpu, no BC/ASTC. (Deferred strategic bets.)
- No temporal keyframe interpolation in v1 (many cached sparse frames → nearest-frame playback is smooth enough; interpolation is a later polish and needs care — naive blend ghosts turbulence).
- No change to interactive (non-playing) editing — that stays the Phase A dense direct-to-3D path.
- No on-disk gzip of the cache yet (that's an export/save concern, later).
- Volume stays RG8 (density + heat).

## Settled decisions

1. **Custom brick grid** (not a full VDB/NanoVDB port) — ~90% of the benefit, WebGL2-native, a few hundred lines.
2. **Default brick size 16³** (tunable). Macrocell grid for 512³ = 32³ cells.
3. **Bake-once-then-play:** entering playback bakes the loop into the sparse cache (slow one-time at high res — the "cache" step); playback and scrub read the cache. Editing invalidates it → back to dense interactive.
4. **v1 playback = nearest cached frame** from a high frame count (sparsity lets us store many); interpolation deferred.

## Architecture

### Cache structure (GPU-resident)
- **Brick atlas:** one RG8 3D texture holding all *active* bricks packed across all frames of the loop, e.g. a 3D grid of `16³` brick slots.
- **Indirection texture(s):** per frame, a small 3D texture over the macrocell grid (e.g. 32³ for 512³) mapping each macrocell → its atlas slot index, or a sentinel meaning "empty (skip)". N frames → N indirection tables (tiny) or one array.
- **Threshold:** a brick is "active" if any voxel's density (or heat) exceeds a small epsilon.

### Bake (one-time, on entering playback / when settled)
For each of N loop frames: generate the dense frame via the existing `VolumeGenerator.generateFrameData(phase)` (RG readback, as today) → CPU scans macrocells, copies active bricks into the atlas, writes the indirection table → uploads atlas + indirection to GPU. The dense frame is transient (not retained). Bake cost = N × full-gen (slow at 512³, one-time) + cheap packing. Show progress; cancellable/rebuildable (reuse the existing cache build-id/cancel pattern in AnimationController).

### Sparse sampling (raymarch + slice/projection)
Add a **sparse sampling mode**: given `volumePos`, compute macrocell coord → sample the current frame's indirection → if empty, **skip** (advance the ray, empty-space skip); else compute the atlas brick coord + in-brick offset → sample the atlas. Density/heat come out as today (`.r`/`.g`), feeding the existing shaping + smoke/glow emission unchanged. When NOT playing (interactive), the raymarch samples the dense `u_volume` exactly as now (mode flag / uniform). Keep the dense path byte-identical.

### Playback / AnimationController
- On **play** (or scrub while a cache exists): select the frame by phase, bind its indirection, render sparse. No regen, no dense upload.
- On **edit** (layers/settings change): invalidate the sparse cache → interactive dense path until the next bake.
- Replaces the current dense frame cache + the per-frame-regen fallback for the playing case.

### Frame count / memory
N frames bounded by VRAM: with ~10% active at 512³, a 60-frame loop ≈ 60 × (0.1 × 256 MB) ≈ 1.5 GB worst-case → tune brick size / active-fraction / N; at 256³ trivially fits. Expose N (loop frame count) with a sane default (e.g. 24–48) and cap by a VRAM budget like today's.

## Interaction with existing systems
- **Phase A dense direct-to-3D** interactive generation: unchanged (used when not playing).
- **Drag proxy (Task 4):** unchanged (interactive editing).
- **RG8 volume, smoke/glow emission, ramp, SDF/flame shapes:** unchanged — the sparse cache reconstructs the same (density, heat) the dense path produces, so the look is identical.
- **Export:** unchanged for now; later the sparse cache can feed a colored/animated export (and be gzip'd on disk).

## Testing
- **Unit (pure TS):** the brick packer + indirection builder — given a dense frame, produce (atlas bricks, indirection) that reconstruct the dense frame **exactly** for active regions and mark empties; round-trip test (pack → reconstruct == original within active bricks). Active-brick threshold logic. Frame-count/VRAM budget calc.
- **Visual/GL smoke (real-GPU Playwright, per precedent):** sparse-rendered frame is **visually identical** to the dense render of the same phase (parity); playback FPS at 256³/512³ is dramatically higher than the per-frame-regen baseline (measure); interactive editing (non-playing) unchanged; empty-space skipping doesn't clip visible volume.

## Success criteria
- High-res animation playback goes from single-digit FPS to smooth (target ≥ the intended ~10–30 fps) at 256³ and usable at 512³, WebGL2, all platforms.
- Sparse render is visually identical to dense (lossless within the active-brick threshold).
- Interactive editing and all existing look/features unchanged.
- Bake is a bounded one-time step with progress + cancel.
- `npm run build` + `npm run test` green; zero `any`; web + Tauri both work.

## Deferred / future (noted, not built)
- Dense-keyframe temporal interpolation (smoother motion from fewer frames; velocity-warp to widen spacing).
- On-disk gzip of the saved cache; cache→colored/animated export bake.
- WebGPU compute bake + BC/ASTC-3D GPU decompression (Chrome-139+, no Linux-Tauri).
- Native wgpu renderer / bake sidecar (strategic; separate decision).
