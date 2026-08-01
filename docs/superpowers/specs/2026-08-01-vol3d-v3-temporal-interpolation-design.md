# Vol3D v3 — Temporal Interpolation (smooth playback) — Design

**Date:** 2026-08-01
**Status:** Approved (user diagnosed choppy long-loop playback as frame quantization; building the fix).
**Parent:** builds on cycle ④ (dense frame cache) + cycle ⑤ (reduced-res playback bake + occupancy skip).

## Goal

Make playback **smooth at any loop length / frame count** by interpolating between adjacent baked frames instead of snapping to the nearest one. Playback currently binds the **nearest** of N baked frames, so perceived motion = `N / loop_seconds` distinct frames/sec (24 frames over a 10 s loop = 2.4 fps → choppy). Blending frame `i`↔`i+1` by the phase fraction yields continuous motion from few frames — decoupling smoothness from frame count (which caps at 64 and can't smooth a long loop).

## Approach

**Only playback changes** (live/paused stay single-volume). During playback the raymarch samples **two adjacent cached frames** and lerps:
- `f = phase * n`; `i = floor(f) mod n`; `i1 = (i+1) mod n` (wraps the loop); `frac = f - floor(f)` ∈ [0,1).
- Bind BOTH frames' volume textures + BOTH occupancy textures + `frac` (fold into the Cam uniform's spare pad, or a small uniform).
- Per raymarch step: `s = mix(textureSampleLevel(vol_a,pos), textureSampleLevel(vol_b,pos), frac)` (lerp density + color), then shape/composite as today.
- **Occupancy skip uses the union:** `maxd = max(occ_a(mc), occ_b(mc))` — skip a macrocell only if it's empty in BOTH frames (never skip a cell occupied in either, or interpolation would clip motion at boundaries).
- `macro_dim` = `macro_dims(bake_res)` (both frames share `bake_res` + occupancy dims — already the case from cycle ⑤).

## Honest caveat

Linear blend of two frames whose noise domain has *rotated* between them (`animatedDomainOffset`) is a **crossfade**, not true optical-flow motion. For **slow/long loops** (adjacent frames nearly identical — the user's 10 s case) it looks smooth and correct. For **fast** motion (large per-frame domain jump) it can **ghost** (double-image). Mitigation is inherent: more frames or a slower loop shrinks the per-frame jump; and the user hit choppiness precisely in the slow-loop regime where interpolation is cleanest. True velocity-warp interpolation is deferred (much more work).

## Scope

**In:** playback samples + lerps two adjacent frames (volume + occupancy union); `frac`/index plumbing from `app.rs` → callback → raymarch; the raymarch bind group gains a second volume + second occupancy + `frac`. Live/paused unchanged (single volume, no second bind).
**Deferred:** velocity/optical-flow interpolation; interpolating the live (non-cached) path.

## Interaction with existing code

- Reuses cycle-④/⑤ `FrameCache` (frames + per-frame occupancy at `bake_res`), the playback binding, and the occupancy skip. New: `FrameCache` exposes frame/occupancy views **by index** (`view_at(i)`, `occupancy_at(i)`) + `frame_count`; `Renderer::bind_playback` binds the two adjacent frames; the raymarch shader lerps + unions occupancy; `app.rs` computes `i,i1,frac` from `phase` and threads them (or just `phase`, letting the renderer derive `i,i1,frac` from its own `frame_count`).
- wgpu 29 / egui 0.35, under `v3/`, native + WebGPU, zero readback. The raymarch bind group grows (reconcile wgpu-29 via `cargo check`); the Cam uniform stays 80 bytes if `frac` reuses a pad slot (else a tiny extra uniform).

## Testing

- **Unit (Rust):** the index/frac math — `interp_frame(phase, n) -> (i, i1, frac)` (wraps: `phase=0`→(0,1,0); just below a boundary → correct i/frac; `n==1`→(0,0,0)); pure, tested.
- **Shader:** `naga` validates the dual-sample raymarch.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** a 10 s loop with modest frames (e.g. 24) now plays **smoothly** (was choppy); no occupancy clipping (union); fast-turbulence scenes may show mild ghosting (expected); live/paused unchanged.

## Success criteria

- Playback is smooth at long loops + low frame counts (24 frames / 10 s no longer steps); occupancy skip still correct (union, no boundary clipping); live/paused single-volume path unchanged; zero readback; both `cargo check` + naga + clippy + unit tests green.

## Risks

- **Ghosting** on fast motion — inherent to linear blend; documented; velocity-warp deferred.
- **Bind group growth** (2 volumes + 2 occupancy + sampler(s) + frac) — reconcile wgpu-29 binding limits/names via `cargo check`; well within limits.
- **Cam uniform layout** if `frac` folds into a pad slot — keep 80 bytes + the size test.
- **Perf:** 2× texture samples per step during playback — but on the reduced-res (`bake_res`, e.g. 128³) frames + skip, still far cheaper than the old full-res raymarch; net still fast.

## Deferred / future

Velocity/optical-flow interpolation (ghost-free fast motion); interpolating the live path; adaptive frame count.
