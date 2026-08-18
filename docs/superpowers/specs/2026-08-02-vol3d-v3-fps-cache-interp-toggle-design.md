# Vol3D v3 — FPS-Driven Cache + Interpolation Toggle — Design

**Date:** 2026-08-02
**Status:** Approved (user: raise budget to 4 GB, keep the dense cache; make interpolation a user toggle; control = fps, default 30 "for games not movies").
**Parent:** builds on cycle ④ (dense frame cache) + cycle ⑤ (reduced-res bake + occupancy skip) + temporal-interpolation (crossfade lerp).

## Problem

Playback smoothness was tied to a raw frame **count** (1..64) and a 512 MB cache. Over a long loop the effective framerate = `N / loop_seconds` (24 frames / 20 s = 1.2 fps → choppy). The user wants to author in **fps** — "type 30, get 30 updates/sec" — and to **choose** whether the ghosty crossfade interpolation is on.

## Decision

Keep the dense-cache architecture (no live-regen rewrite). Three changes:

1. **Budget 512 MB → 4 GB** (`min-spec: 4 GB free VRAM`). One constant.
2. **Control becomes `fps`** (default **30**), replacing the raw `Frames` count. Baked frame count `N = round(fps × loop_seconds)`, clamped to `[1, max_loop_frames(budget)]`. `playback_bake_res` already picks the largest res in `{256,192,128,64} ≤ source_res` that fits `N` frames in budget — so a real game loop (30 fps, 2–10 s) lands at 128³–192³; longer loops soften to 64³; never busts VRAM (clamp). Playback plays the N frames at real time → **N / loop_seconds = fps** distinct states/sec. `loop_seconds` is now a **bake input** (changing it changes N → re-bake).
3. **Interpolation toggle** (`interp: bool`, default **off**). Off = bind the **nearest** baked frame (`frame_for_phase`, `frac = 0`) → crisp true-fps steps, no ghost. On = the existing two-frame crossfade lerp (`interp_frame`) → smoother, may ghost on fast motion.

## What 4 GB buys (auto-res)

Max N per res at 4 GB: 256³ → 64, 192³ → 151, 128³ → 512, 64³ → 4096 frames. So:
- 30 fps stays ≥128³ up to ~17 s loops (64³ beyond, to ~136 s).
- 60 fps stays ≥128³ up to ~8.5 s loops (64³ beyond, to ~68 s).
- `max_loop_frames(4 GB) = 4 GB / (64³ × 4) = 4096` — N is clamped here so the floor-res bake always fits (no OOM).

## Approach (per file)

- `anim.rs`: **new** `max_loop_frames(budget_bytes) -> u32 = (budget / (64³ × 4)).max(1)` (+ unit test). The N-clamp ceiling (floor-res = 64 fits budget). `max_frames`/`MAX_FRAMES_CAP` untouched (only the old 64-count default path; now unused by the fps flow).
- `render/frame_cache.rs`: `FRAME_CACHE_BUDGET_BYTES: 512 MB → 4 GB`; update the doc comment's example numbers. No logic change (bake already fits N by construction via `playback_bake_res`).
- `render/mod.rs`: `bind_playback(device, phase, interp: bool)`. `interp == true` → current `interp_frame` two-frame path. `interp == false` → `let i = frame_for_phase(phase, n); bind view_at(i)/occupancy_at(i)` to **both** a and b slots, return `Some(0.0)` (frac 0 → shader `mix(sa,sa,0)=sa`). None-safe on empty cache.
- `render/raymarch.rs`: `RaymarchCallback` gains `interp: bool`; `prepare` passes it to `bind_playback`. (Shader unchanged — frac already drives the blend; 0 = nearest.)
- `app.rs`:
  - **State:** replace the `Frames` control with `pub fps: u32` (default **30**); add `pub interp: bool` (default **false**). Keep `frame_count: u32` as the **derived** baked N (recomputed whenever `fps` or `loop_seconds` changes): `frame_count = (fps as f32 * loop_seconds).round().clamp(1.0, max_loop_frames(BUDGET) as f32) as u32`. Expose the budget (a `pub const` in `frame_cache.rs`, or pass the number) for the clamp.
  - **Re-bake triggers:** `fps` DragValue `.changed()` → `cache_stale = true` + recompute N. `loop_seconds` DragValue `.changed()` → `cache_stale = true` + recompute N (loop is now a bake input). `evolutions` unchanged (already re-bakes).
  - **UI:** `fps` DragValue (default 30, range `1..=120`); `interp` checkbox; keep Loop/Evolutions/Phase/Play. Readout: `baked {N} @ {bake_res}³ ({GB} GB) — {N/loop_seconds:.0} fps` (bake_res via `frame_cache.bake_res()`; GB = `N × bake_res³ × 4 / 2^30`). When `interp` off, label the mode ("steps"), else ("smooth").
  - Playback path (`need_bake`/`use_cache`/`playback_phase`) unchanged except it now passes `self.interp` into the callback.

## Honest caveats

- **Bake stall on Play** scales with N: a 30 fps × 17 s loop = 510 generate dispatches → a one-time ~1–2 s hitch on Play (or on fps/loop/param change while playing). Acceptable for now; **progressive/async bake is a deferred follow-up.**
- **Interp on** still crossfades (ghosts on fast motion) — that's exactly why it's now a toggle, default off.
- **4 GB is a minimum spec.** Cards with less that try a huge N will hit the clamp (lower effective fps) or, below 4 GB free, could fail the alloc — documented as the min requirement.
- Live-regen (VRAM-free, ghost-free) remains the deferred alternative if the cache ceiling is ever hit in practice.

## Scope

**In:** budget → 4 GB; `fps` control (default 30) + derived/clamped N; `loop_seconds` as bake input; interpolation on/off toggle (nearest vs crossfade); `max_loop_frames` helper + clamp; readout (N, res, GB, effective fps).
**Out / deferred:** live-regen playback; progressive/async bake; restore responsive paused-scrub; per-adapter VRAM query; velocity-warp interpolation.

## Testing

- **Unit (Rust, in-sandbox):** `max_loop_frames(budget)` (4 GB → 4096; floors at 1); N-derivation/clamp math if extracted to a pure helper.
- **Shader:** `naga` (unchanged raymarch/occupancy/generate still validate).
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** type 30 → ~30 distinct updates/sec; type 60 → ~60; interp off = crisp steps, on = smooth (ghosts on fast); real game loops bake at 128³–192³; long loops soften to 64³ not crash; readout matches.

## Success criteria

- Playback framerate follows the `fps` control (N = fps × loop, played real-time) for loops within the 4 GB budget; N clamps (no OOM) beyond it.
- Interpolation is a user toggle, default off (crisp), on = crossfade.
- Budget = 4 GB; readout shows baked N, res, GB, effective fps.
- Both `cargo check` + naga + clippy + unit tests green; no regression to generation / per-layer color / occupancy skip / pause-snap.
