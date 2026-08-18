# Vol3D v3 — Cycle ④ Animation + Dense GPU Frame Cache — Design

**Date:** 2026-07-29
**Status:** Approved (user: "write spec and write code" — proceed to plan + build).
**Parent:** v3 direction spec; builds on cycles ①–③ (all GPU-confirmed).

## Goal

Add loop animation + a GPU-resident dense frame cache so playback is smooth with **zero CPU readback** — the v3 "speed" thesis. Bake N loop frames on the GPU via the existing generation compute; play back by binding the current frame's 3D texture for the (unchanged) raymarch. GPU sparse brick packing (for 256³+ VRAM) is the deferred follow-on.

## Part 1 — Animation

- **Wire the deferred `animatedDomainOffset`** (v2 `src/shaders/generation/layer_gen.frag.glsl` L27-42) into `generate.wgsl`: port `hash11` (v2 `src/shaders/common/hash.glsl`) + the seed-derived rotating-domain-offset math; `offset = (axisA*cos(angle) + axisB*sin(angle)) * ANIM_RADIUS`, `angle = anim_phase * anim_evolutions * TAU`, axes from `hash11(seed*k + c)`. Applied in the **non-SDF** transform branch only (`p += animatedDomainOffset(L.seed, params.anim_phase, params.anim_evolutions)` after the rotate; SDF bypasses — matches v2 L59 vs L53-54). This is what makes noise evolve across the loop.
- **`GenParams` repack (16 bytes kept):** `{ res: u32, layer_count: u32, anim_phase: f32, anim_evolutions: f32 }` — DROP `global_seed` (dead: unread by the shader, already folded into each layer's `seed` CPU-side) and ADD `anim_evolutions`. Update the Rust `#[repr(C)]`, the WGSL `struct GenParams`, and the 16-byte size test in lockstep.
- **Phase clock:** while playing, advance `phase` by `dt / loop_seconds` (mod 1) using egui frame time. `anim_evolutions` is an integer-ish count (how many full noise cycles per loop).

## Part 2 — Dense GPU frame cache

- **`FrameCache`**: `N` separate GPU 3D textures (`Vec<wgpu::Texture>`, each `res³` `rgba8unorm`, `STORAGE|TEXTURE`). Bake = run the **existing generation compute** into each `frames[i]` at `anim_phase = i/N` (compute writes the 3D texture directly — **GPU-resident, zero readback**). No sparse packing, no atomics, no raymarch shader change.
- **Playback = bind `frames[frame_for_phase(phase, N)]`** as the volume the raymarch samples. The raymarch already samples one bound 3D texture (cycles ①–③); playback just swaps which texture is bound before the draw. Non-playing keeps the live single-volume path (cycle ③).
- **Invalidation:** any layer/settings/resolution/evolutions edit marks the cache stale (a cache-key over the bake inputs); next Play re-bakes. Editing while playing → invalidate + (re-bake or pause — see UI).
- **Memory guard:** dense cost = `N × res³ × 4` bytes. Clamp N (or refuse a too-large bake) via `max_frames(res, budget)`; fine at 128³/32 (256MB), warned/clamped at 256³ (2GB). This ceiling is exactly what the deferred GPU sparse packing removes.
- **Bake cost:** N full generations — a brief one-time pause on Play (fast at 128³). Show a "baking…" state; chunking across frames is optional polish (note, not required this cycle).

## Playback flow

1. **Not playing:** live volume — edit → debounced regen → single volume (cycle ③ unchanged).
2. **Play:** if cache stale, bake N frames into `FrameCache` (GPU). Then each frame advance `phase`, bind `frames[frame_for_phase(phase,N)]`, raymarch it → smooth, no regen. The **fps/ms counter** (already added) shows the win vs per-frame regen.
3. **Edit while playing:** invalidate; re-bake on the next play tick (or pause playback — pick the simpler: invalidate + auto-rebake, or invalidate + pause and require re-Play). 
4. **Pause / scrub:** pause stops the clock; the phase scrub sets `phase` (binds the nearest cached frame if a valid cache exists, else regenerates that phase live).

## UI (egui, an Animation section)

Play/Pause toggle, loop duration (seconds `DragValue`), evolutions (`DragValue`), frame-count N (`DragValue`/combo), a phase scrub `Slider` (0..1), and a small bake/stale indicator. Editing loop/evolutions/N marks the cache stale.

## Interaction with existing code

- Reuses the cycle-② generation compute (`VolumeGen::generate` — now called per bake frame at a given `anim_phase`) + cycle-③ authoring UI + the raymarch embed. The raymarch **shader** is unchanged; only which 3D texture is bound changes for playback. `render/*` grows a `FrameCache`; `app.rs` gains animation state + controls. wgpu 29 / egui 0.35, all under `v3/`, native + WebGPU.

## Scope

**In:** `animatedDomainOffset` wiring + `GenParams` repack; animation controls UI + phase clock; dense GPU `FrameCache` (bake via existing compute, playback binds current frame); invalidate-on-edit; `max_frames` memory clamp.
**Deferred:** GPU sparse brick packing (256³+ VRAM) → follow-on cycle; reduced-res bake; temporal interpolation between frames; chunked/progress bake polish.

## Testing

- **Unit (Rust, in-sandbox):** `advance_phase(phase, dt, loop_seconds) -> f32` (wraps mod 1, handles loop_seconds→0); `frame_for_phase(phase, n) -> usize` (nearest, wraps, n≥1); `max_frames(res, budget_bytes) -> usize` (≥1, dense `res³*4` math); cache-key/`is_stale` predicate; `GenParams` 16-byte size test (post-repack).
- **Shader:** `naga` validates the `animatedDomainOffset`-wired `generate.wgsl`.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** noise visibly animates over the loop; Play bakes then plays smoothly (fps counter high + steady, no per-frame regen); scrub works; editing invalidates + re-bakes; memory sane at 128³.

## Success criteria

- Playing a loop bakes N frames GPU-resident (zero readback) and plays back by binding cached frames — smooth, no per-frame regeneration — with `animatedDomainOffset` making the noise evolve; the fps counter shows steady high fps during playback.
- `GenParams` repack + all pure-helper unit tests + `naga` + both `cargo check` + clippy green.
- No regression to cycles ①–③ (live editing, gradient editor, generation) — the raymarch shader is unchanged; non-playing path intact.

## Risks

- **`animatedDomainOffset` fidelity** — `naga` checks types, not math; port `hash11` + the axis/angle expressions verbatim from v2; the user's GPU run confirms the evolving look. Reviewer compares line-by-line to v2.
- **Dense VRAM at high res** — guarded by `max_frames`; the sparse follow-on is the real fix. Be honest in the UI (clamp + note) rather than OOM.
- **Bake pause at high res** — N generations on Play; acceptable brief pause at 128³, flagged.
- **`GenParams` repack** must stay byte-matched Rust↔WGSL (16-byte test) — same std-layout discipline as prior cycles.

## Deferred / future

GPU sparse brick cache (atomic slot allocation, 256³+); reduced-res playback bake; temporal interpolation; chunked bake with progress; export of the animation (cycle ⑤).
