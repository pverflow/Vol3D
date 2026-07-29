# Vol3D v3 — Cycle ① PoC / Engine Skeleton — Design

**Date:** 2026-07-27
**Status:** Approved direction; design for review. Next: implementation plan (superpowers:writing-plans).
**Parent:** `docs/superpowers/specs/2026-07-27-vol3d-v3-native-web-wgpu-design.md`

## Goal

Prove the v3 stack end-to-end, on **one codebase, two targets**, before any feature work:

> An `eframe` (egui) app with a compute shader that writes an `rgba8` **3D storage texture**, raymarched in a render pass, embedded in the egui UI via an `egui-wgpu` paint callback, with **zero CPU readback** — building and running **native (macOS + Windows + Linux) AND web (WebGPU/wasm)** from the same source.

This is a **de-risk slice**, not a feature. It answers the questions that would sink the whole product line if wrong: does the same wgpu/WGSL run native + WebGPU; does compute→3D-storage-texture→raymarch→embedded-in-egui work with no readback; and what are the per-backend / web 3D-storage-texture limits.

## Scope (minimal — proves the STACK, not features)

- A Cargo project at **`v3/`** in the repo (on the `v3` branch), so v2's files are untouched alongside it. `eframe`-based, single entry that targets native (winit) and web (wasm canvas).
- **egui UI:** a side panel with a few controls — resolution (64³ / 128³ / 256³), an iso/threshold slider, a noise-scale slider — and the **embedded raymarch viewport** filling the rest.
- **Compute pass:** dispatch over the 3D grid; write an `rgba8` 3D storage texture `[colorR, colorG, colorB, density]`. Content is a deliberately trivial procedural field — a centered **sphere SDF → density**, modulated by a cheap **hash/value noise**, colored by a hard-coded gradient — chosen only so the result is visibly 3D and colored. (This is NOT v2's noise/SDF library; that's cycle ②.)
- **Raymarch pass:** render the 3D texture to the viewport (front-to-back alpha, one cheap light). **Orbit camera** (drag rotate, wheel zoom).
- **Embedding:** `egui-wgpu` `CallbackTrait` (`prepare`/`paint`) runs the compute (on change) and raymarch passes into the panel's viewport rect. The 3D texture and rendered image stay **GPU-resident** — never mapped/read back to the CPU.
- **Regeneration:** re-run the compute pass only when a control changes (not every frame).
- **Capability probe at startup:** log adapter name, backend, `max 3D texture dimension`, and storage-texture access support; assert the app's `rgba8` 3D **write** storage-texture usage is available, degrade with a clear message if not.

## Files (small, focused)

```
v3/
  Cargo.toml
  index.html            # web (trunk) shell
  Trunk.toml            # web build config
  src/
    main.rs             # eframe entry; native + #[cfg(wasm32)] web start
    app.rs              # egui UI + app state (controls, camera, dirty flag)
    renderer.rs         # wgpu device/queue, 3D texture, pipelines, passes, capability probe
    camera.rs           # orbit camera math
  shaders/
    generate.wgsl       # compute: write rgba8 3D storage texture (sphere SDF + noise)
    raymarch.wgsl       # render: raymarch the 3D texture to the viewport
```

## Targets & build

- **Native:** `cargo run` in `v3/` (Vulkan / Metal / DX12 auto-selected by wgpu). Verified on macOS, Windows, Linux.
- **Web:** `trunk serve` / `trunk build` → wasm + WebGPU; verified in a WebGPU browser (Chrome/Edge/Safari 26). Async adapter/device init; single-threaded (no wasm threads).
- **Force the wgpu backend + WebGPU on web:** `eframe` defaults to pulling `glow` (WebGL) on wasm. Configure `eframe` with the `wgpu` renderer (disable the `glow` default feature) and build the `wgpu::Instance` on web with the **WebGPU** backend — **not** WebGL2 (WebGL2 has no compute; the whole PoC needs compute). Select `Backends::PRIMARY` / `BROWSER_WEBGPU`, not `GL`.
- **Versions (resolved, confirmed compiling here):** `wgpu 30.0.0`, `egui`/`eframe`/`egui-wgpu 0.35.0`, `bytemuck 1.25.x`, `pollster 1.x` (native). Pin exact patches in `Cargo.toml`.

## Non-goals (explicitly out — later cycles)

v2 noise/SDF variety, layers, per-layer color UI, remap/feather curves, animation + sparse cache, export, presets, packaging/signing. None of it. Just the stack proof.

## Testing / de-risk gates

1. **Builds** native (macOS + Windows + Linux) and web (wasm/WebGPU).
2. **Renders** a recognizable colored 3D volume (sphere + noise); orbit + zoom work; the viewport is embedded in the egui panel (panels around it, not fullscreen).
3. **Reactivity:** changing a control re-runs the compute pass and updates the view.
4. **Zero readback:** confirm the frame loop never maps/reads the 3D texture or the rendered image back to the CPU (code inspection + no `map_async`/`get_mapped_range` on the render path).
5. **Capability report:** startup logs adapter/backend/limits on each target; **document any backend or the web target where `rgba8` 3D-storage-texture write is unavailable or feature-gated** — this directly informs cycle ②'s design.
6. **WGSL validates** via `naga` (part of the wgpu build).

## Success criteria

- The same source produces a working **native app AND a WebGPU web build**, each showing a colored raymarched volume generated by a compute shader into an `rgba8` 3D texture, **with no CPU readback**, panels around an embedded viewport.
- Per-backend / web 3D-storage-texture reality is documented (the input to cycle ②).
- v2 remains untouched on `master`; all v3 work is under `v3/` on the `v3` branch.

## Verification model (confirmed)

The agent sandbox now has Rust `1.97.1` (installed to `~/.cargo`; `source ~/.cargo/env` per shell) + the `wasm32-unknown-unknown` target, and **both `cargo check` (native) and `cargo check --target wasm32-unknown-unknown` compile the full `eframe`+`wgpu` tree here**. So implementation gates that CAN run in-sandbox:
- `cargo check` native **and** wasm32 (both must stay green),
- `cargo clippy`, `cargo fmt --check`,
- `naga` WGSL validation (pure CPU — parse + validate each `.wgsl`),
- Rust unit tests for pure logic (camera math, capability calc).

What CANNOT run here (no GPU / no display / no WebGPU browser) → **deferred to the user's machine**: the actual GPU visual render, orbit interaction, and the WebGPU-browser smoke. The plan must be honest about this split — never claim a visual pass that only the user can observe.

## Risks

- **GPU verification is the user's machine.** Compile/shader-validation is covered in-sandbox; the visual render (native + WebGPU browser) is confirmed only by the user. Structure the PoC so a failed GPU run gives a clear diagnostic (log adapter/limits, validate pipelines at creation).
- **Web specifics:** async device init and no threads on wasm change app startup vs native — handle both from one entry.
- **Per-backend storage-texture gating** — the exact risk this PoC exists to measure; write-only `rgba8` 3D storage should be broadly supported, but verify (Metal/DX12/Vulkan + WebGPU).
- **egui-wgpu callback** viewport sizing / DPI / lifetime of GPU resources across frames.

## Open decisions (non-blocking)

- Web bundler: `trunk` (default, eframe's documented web path) vs `wasm-pack` + manual — default `trunk`.
- Whether the camera/UI polish matters for the PoC — no; minimal orbit is enough.
