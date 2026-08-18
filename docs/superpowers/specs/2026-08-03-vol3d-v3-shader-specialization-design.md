# Vol3D v3 — Per-Scene Shader Specialization — Design

**Date:** 2026-08-03
**Status:** Implemented and verified on the failing hardware (RTX 3080 / Vivaldi 150 / Windows 11).

## Problem

v3's web build did not load on Windows: the page painted nothing — not even egui's own panels —
and the browser eventually lost its GPU process. macOS was unaffected. Reported as "works on mac,
crashes on windows", crash on page load.

## Root cause

`shaders/generate.wgsl` (1118 lines) reaches every generator from runtime `switch`es over
`GpuLayer` fields: 6 noise families, 6 SDF shapes, FBM's 8-octave loop, and `apply_distortion`'s
five modes — where `warp_field` is itself a 6-way noise switch called 3× per octave × 8 octaves,
inside the per-layer loop, and Worley/Voronoi each contain a 3×3×3 (27-iteration) cell loop.

Nothing in that is statically dead, so a backend must compile all of it. Tint → MSL (macOS)
handles it; Tint → HLSL → **DXC** (Windows) inlines and unrolls it into a pipeline creation of
**16–60 seconds**. `wgpu::Device::create_compute_pipeline` is synchronous (wgpu 29 exposes no
async pipeline creation), so the browser's GPU process is blocked for that whole time and
Chromium's watchdog kills it:

```
ERROR:gpu_process_host.cc:1091] GPU process exited unexpectedly: exit_code=2
```

The kill was logged exactly 60 s after page load. Because the old `VolumeGen::new` built that
pipeline during startup, the app died before its first frame.

### Measurements (RTX 3080, Vivaldi, nonce-defeated pipeline cache)

| shader | pipeline creation |
|---|---|
| `occupancy.wgsl` (39 lines) | 65 ms |
| `generate.wgsl` monolithic | **57 799 ms** / 16 293 ms (high variance, always ≫ watchdog) |
| `generate.wgsl` specialized to one noise family | **674 ms** / 359 ms |

Ruled out by direct measurement, not inference: WebGPU availability, adapter selection (NVIDIA
adapter, `maxTextureDimension3D=2048`), 3D `rgba16float` storage-texture support, and memory
pressure — a 24 × 128³ (402 MB) allocation and later a real 120-frame/1920 MB bake both succeeded.

## Design

New module `v3/src/render/specialize.rs`.

- `feature_mask(&[GpuLayer]) -> u32` — which generator families the scene can actually reach:
  each layer's `noise_type`, plus `fbm_base` when the layer is FBM, plus `warp_noise` when the
  layer's distortion is one of the three *warping* modes (`DomainWarp`/`Curl`/`Turbulence`).
  `Swirl`/`Polar` are pure coordinate math and never sample a noise field, so their
  always-populated `warp_noise` must not pull a family in.
- `specialize(src, mask) -> String` — for every family whose bit is clear, replace that
  generator's **body** with a constant `return`. Call sites and switch arms are untouched (no WGSL
  parsing needed), but the expensive helpers become unreachable and Tint's dead-code elimination
  drops them before the HLSL backend sees them.
- `VolumeGen` holds `HashMap<u32, ComputePipeline>` keyed by mask, compiled on demand in
  `generate_into`. `VolumeGen::new` no longer builds any pipeline — the first real scene decides
  which one. Caching (rather than replacing) means toggling a layer back to a previously used
  family is instant instead of re-paying compilation.

The SDF shapes are deliberately *not* gated: they are straight-line distance math, cheap to
compile, and gating them would add mask churn for no gain.

### The invariant this introduces

**Any function reachable from a kept function must have its bit set in the mask.** Stubbing is a
reachability claim, and getting it wrong does not fail loudly — it silently returns a constant.

This bit us once, in review by the user: `warp_loop` layers do not sample `warp_field` at all;
they go through `warp_field_loop`, which **hardcodes `pnoise3_core`** (tileable Perlin) and ignores
`warp_noise`. With Loop Offset on and any non-Perlin selector, `pnoise3_core` was stubbed to `0.5`,
so `warp_field_loop` returned a constant `0.75`, all three turbulence taps came out equal, and the
warp degenerated into a constant diagonal offset — a *rigid translation* of the layer, with Warp
Freq and Octaves having no effect (every octave returning the same value). Measured on an SDF
Plume with Turbulence + Loop Offset, warp = Worley:

| mask rule | mean \|displacement\| | max | std-dev | behavior |
|---|---|---|---|---|
| selected family only (`DISTORT\|WORLEY`) | 1.6238 | 1.6238 | **0.00000** | constant → rigid translation |
| + forced `PERLIN` (`DISTORT\|WORLEY\|PERLIN`) | 0.5812 | 1.3341 | **0.22962** | varies → real warp |

`feature_mask` therefore forces `PERLIN` whenever a warping distortion has `warp_loop` set.

## Tests (10, no GPU required)

- `every_stub_target_exists` — fails if any stub target is renamed in `generate.wgsl`. Without it,
  a rename would silently restore the 60 s stall and the Windows load crash.
- `specialize_with_everything_is_the_original` — full mask is byte-identical to the source.
- `stubbing_removes_the_body_but_keeps_the_signature` — scoped to the stubbed function's own body
  (`noise_voronoi` has an identically shaped loop and is intentionally untouched).
- Mask derivation: FBM base included; warping distortion's `warp_noise` included; `Swirl`/`Polar`
  excluded; demo scene resolves to `FBM|SIMPLEX|PERLIN` with no `DISTORT`; empty scene → 0.
- `mask_of_loop_warp_always_includes_perlin` / `mask_of_non_loop_warp_does_not_force_perlin` —
  the invariant above, across all five non-Perlin selectors.

Line-ending note: the shader may be checked out CRLF or LF. `stub_body` matches only on `\n` so it
is agnostic; the tests normalize before matching literals.

## Verification

`cargo test` 76 passed; `cargo clippy --all-targets` clean; `cargo check --target
wasm32-unknown-unknown` clean. In-browser on the previously failing machine: demo scene compiles
mask `0b01000110` in 0–1 ms, renders at 132–144 fps, Play bakes 120 frames @128³ (1920 MB) without
losing the GPU process.

## Follow-ups (not in this change)

- **Warp Noise selector is inert in Loop Offset mode.** By design `warp_field_loop` always uses
  tileable Perlin, so after this fix all six selections warp correctly but look identical. Either
  disable the control in loop mode, or add tileable variants of the other five families.
- **Cold-load black viewport.** On a fresh load the volume stays black until the first input event;
  generation dispatches only on `pending_regen`. Pre-existing and platform-independent — it was
  simply invisible on Windows while the app could not load at all.
- **Turbulence render cost.** With Turbulence enabled the viewport drops to ~1 fps (1932 ms/frame)
  at 128³. Unrelated to compilation; worth profiling separately.
