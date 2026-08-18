# Vol3D v3 — Native + Web (wgpu) Engine — Design

**Date:** 2026-07-27
**Status:** Approved direction; design for review. Next: PoC sub-project spec (superpowers:brainstorming → writing-plans).
**Driver:** **Speed** — generation and animation playback. v2's WebGL2 engine has no compute shaders and forces a per-bake GPU→CPU readback (the sparse animation cache round-trips every baked frame through the CPU). That readback + the fragment-only pipeline is the wall. v3 moves the engine to GPU compute with GPU-resident data.

## What v3 is

A **separate, full-capability product** — a true peer/alternative to v2, not a throwaway native fork and not a merge target. v3 is **one Rust codebase (wgpu + egui)** that ships **both**:
- **Native desktop** (Windows / macOS / Linux) via Vulkan / Metal / DX12, and
- a **WebGPU web build** (wasm).

v2 (the TypeScript / WebGL2 web app) stays on `master` as the other alternative. v2 and v3 **share no code** (different stacks) and v3 **never merges into v2**. Both are maintained independently.

## Why wgpu (not raw Vulkan/Metal/DX12, not in-webview WebGPU)

- **wgpu is native.** Native wgpu links into the binary and issues real Vulkan/Metal/DX12 commands — no browser, no sandbox. WGSL compiles to native SPIR-V/MSL/DXIL. GPU throughput is identical to raw native; the only delta is a small CPU-side command-encoding/validation cost (a few % on submission-bound workloads, negligible for a GPU/shader-bound tool like this). Firefox's WebGPU, Bevy, Rerun, Zed, and Veloren ship wgpu.
- **One codebase, all backends + web.** The same wgpu/WGSL runs native (Vulkan/Metal/DX12) and, via wasm, on **WebGPU** in the browser. Raw per-platform backends would be 3× the code with no meaningful perf gain here.
- **No webview compositing.** Because v3 is fully native (no Tauri webview), the fragile "wgpu-under-webview" compositing problem (Tauri issue #8246, closed unsolved; flicker #9220) never arises.
- **The actual unlock is capability, not API rawness:** compute shaders + 3D storage textures + GPU-resident data with no CPU readback — exactly what WebGL2 lacks.

**Stack (verified, mid-2026):** `wgpu 30.x`, `egui` + `egui-wgpu`/`eframe` `0.35.x`. Production-ready for compute, 3D storage textures, WGSL. (Exact wgpu 30.0.0 date uncertain; version solid.)

## Architecture

- **Host / UI:** `eframe` (egui) — one entry point hosts **native (winit)** and **web (wasm canvas)**. egui panels (layers, properties, gradient/curve editors, presets) around an **embedded wgpu raymarch viewport** via `egui-wgpu`'s paint `CallbackTrait` (`prepare`/`finish_prepare`/`paint`, running our own wgpu passes inside egui's pass). This is Rerun's exact shape — a shipping pro tool with egui panels + a custom wgpu 3D viewport.
- **Engine (WGSL, shared native + web):**
  - **Generation** — a compute shader evaluates the layer stack per voxel and writes an `rgba8` **3D storage texture** `[colorR, colorG, colorB, density]` (the v2 model carried over). No fragment render-to-3D-layer, no readback.
  - **Sparse animation bake + cache** — baked entirely GPU-resident (compute pack into a brick atlas + indirection), **no per-frame CPU readback** (the v2 sparse cache's cost). This is the primary speed payoff.
  - **Raymarch** — a render pass sampling the volume (dense) or the sparse atlas (playback), producing the viewport image consumed by egui's paint callback.
- **Targets & the capability contract:** a capability layer queries adapter limits at startup and gates behavior:

  | Concern | Native | Web (WebGPU) |
  |---|---|---|
  | Max volume resolution | large (VRAM-bound, e.g. 512³–1024³) | clamped (browser 3D-texture + memory limits; e.g. ≤256³–512³) |
  | Compute + 3D storage textures | full | required (WebGPU-only; no WebGL2 fallback) |
  | Read-write 3D storage textures | if backend supports (feature-gated) | avoid — assume write-only; design around it |
  | Threads | native threads | none (wasm) — async / single-threaded scheduling |
  | Adapter init | sync-ish | async (WebGPU adapter/device request) |
  | File I/O | native open/save dialogs | download / file-input |

  **Shared core + per-target gating** — the engine targets the WebGPU capability envelope as the common denominator; native unlocks the ceiling (bigger volumes, extra features) behind capability checks, never by forking the shader logic.

## Non-goals (this product line)

- No merge with v2; no shared code with the TS app.
- No raw Vulkan/Metal/DX12 backends (wgpu's near-native perf + one codebase wins for a shader-bound tool). `wgpu-hal` only if a real CPU-submission bottleneck ever appears.
- **No WebGL2 fallback engine on the web** — WebGL2 has no compute; that path is v2's domain. v3 web requires WebGPU (Chrome/Edge/Safari 26 have it; Firefox Linux rolling out through 2026).
- No exceeding the WebGPU envelope on the web target — huge volumes / exotic features are native-only, capability-gated.

## Decomposition (each its own spec → plan → build cycle)

1. **PoC / engine skeleton** *(first — de-risk)* — `eframe` egui+wgpu app, one panel, a compute shader writing an `rgba8` 3D storage texture, a raymarch render pass, the result embedded in the egui UI via a paint `CallbackTrait`, **zero CPU readback**. Must build and run **native (macOS + Windows + Linux) AND web (WebGPU)** from the one codebase. Proves the one-codebase-two-targets thesis and surfaces per-backend/web 3D-storage-texture limits before any feature work.
2. **Generation → WGSL compute** — port the v2 pipeline: noise (Perlin/Simplex/Worley/Voronoi/Value/White/FBM), SDF/flame shapes (sphere/box/cone/plume/capsule/cylinder), blend modes, remap (Bézier curves, feather), per-layer color ramps → compute, capability-gated. Parity with v2 generation.
3. **egui UI** — layers panel, properties, gradient editor, remap/feather curve editors, presets, viewport camera controls. Parity with v2 UX.
4. **GPU-resident animation + sparse cache** — bake the loop on the GPU (no readback), sparse brick cache in wgpu, reduced-res playback + snap-to-full-res on pause. The speed-payoff cycle; benchmark vs v2's readback baseline.
5. **Export** — colored volume (raw R8/RGBA8/R32F), PNG sequence / sprite sheet, flipbook; native dialogs + web download.
6. **Packaging** — native per-OS builds (winit standalone; signing) + web/wasm deploy.

## Testing strategy

- **PoC gate:** identical shared-path output native vs web (WebGPU); per-backend 3D-storage-texture support verified on real Metal/DX12/Vulkan boxes; confirm zero CPU readback in the frame loop.
- **Per cycle:** Rust unit tests for pure logic (packer, capability math, state); WGSL validated via `naga`; visual/GPU smoke on native + a WebGPU browser; bake perf measured against v2 (the readback baseline) to prove the speed thesis.

## Success criteria

- One Rust/wgpu/egui codebase produces a working native desktop app **and** a WebGPU web build, both rendering a colored raymarched volume from a compute-generated `rgba8` 3D texture with no CPU readback.
- Animation bake/playback is materially faster than v2 at equal resolution (measured), driven by staying GPU-resident.
- Feature parity with v2 (layers, noise/SDF, per-layer color, animation, export) on the native target; web target reaches parity within its capability envelope.
- v2 remains untouched on `master` as the alternative.

## Risks (honest)

- **Full Rust rewrite** — new language/stack vs the TS app; real ramp-up. Two products to maintain (v2 + v3) — the user's explicit choice.
- **Web capability envelope** — designing the engine to WebGPU's common denominator constrains the web target (smaller volumes, no read-write storage textures, no threads, async init). Native-only extras must be cleanly gated, not forked.
- **WebGPU browser coverage** — Firefox Linux still rolling out through 2026; web build drops non-WebGPU browsers (that's v2's job).
- **API churn** — wgpu and egui (immediate-mode) both break between releases; pin versions.
- **Per-backend 3D storage-texture gating** — write-only universal, read-write feature-gated and not on every backend; the PoC must verify early.
- **Linux native windowing** (Wayland/X11) needs real testing.

## Open decisions (recorded, not blocking)

- **Repo layout** — starting on the `v3` branch (per request). For long-term coexistence of two maintained products, a subdirectory-on-master or a separate repo may be cleaner than a permanently-unmerged branch; revisit after the PoC.
- **UI framework** — `egui` chosen (Rerun precedent, cleanest `egui-wgpu` custom-viewport path). `iced` is the fallback if egui's immediate-mode gradient/curve editors prove too costly.
- **v2 parity scope for v3 v1** — how much of v2's feature surface the first shippable v3 must match (decided per-cycle).

## Deferred / future (noted, not built)

- Volumes beyond browser limits on native (1024³+), GPU BC/ASTC-3D compression (native, feature-gated).
- Temporal interpolation for playback; brick-apron/LINEAR atlas de-blocking (carried from v2's deferred list).
- OpenVDB import/export interop.
