# Vol3D v2 Roadmap

**Date:** 2026-07-24
**Status:** Approved decomposition. Built as a sequence of independent cycles — each phase gets its own spec → plan → implementation.

## Goal

v2 raises Vol3D on three axes the user named: **more features, more authoring flexibility, more speed** — without abandoning the browser-first + Tauri-desktop, WebGL2 foundation that v1 ships everywhere.

## The organizing insight

Research (codebase audit + competitive survey + perf analysis + interchange analysis, 2026-07-23) converged on one point: **the refactor that makes generation fast is the same neighborhood of code that makes it multi-channel, and multi-channel is what unlocks most of the flexibility and interchange value.** So the order is dictated by dependency, not just appetite:

- Speed win = render generation directly into the 3D texture (kill the per-slice CPU readback) + move shaping into shaders. Uses `framebufferTextureLayer`, already present in `ExportManager.readSlice`.
- Flexibility asks (ranked): multi-channel/vector volumes, layer-inputs (use layer N as layer M's mask/warp — "80% of a node graph, no editor"), SDF shape primitives.
- Interchange: most target formats (EXR, RGBA DDS, VDB attribute sets, Unreal Sparse Volume Textures) only pay off past single-channel density. The sprite-sheet PNG is *already* an Unreal dense Volume Texture — one metadata sidecar + importer script away from one-click engine assets.

## Phases (each = its own spec → plan → build cycle)

| Phase | Scope | Why here | Rough size |
|---|---|---|---|
| **0. Free wins** | cutoff/contrast→uniform (folded into A), snapshot undo/redo (`serialize()` already exists), export metadata sidecar, per-axis tiling toggle | independent, tiny, high-satisfaction; pick up opportunistically | S each |
| **A. Engine core (speed + precision)** ⭐ FIRST | render→3D-texture, shaping in-shader (non-destructive), RGBA16F accumulators, low-res drag proxy | foundation — kills the readback stall, fixes 8-bit banding, makes 256³ near-live / 512³ tolerable, unblocks B/C/D; universal, low-risk | M |
| **B. Multi-channel volumes** | RGBA/vector output, per-channel layer-group routing, channel packing, curl/gradient derivation | the flexibility + interchange multiplier | M |
| **C. Authoring flexibility** | layer-inputs (mask/warp source = another layer/group), SDF shape primitives + booleans/smooth-min, transfer-function colormap + simple lit raymarch preview | "author freely, readable preview" | M–L |
| **D. Interchange + animated export** | engine recipes (UE dense VT tuning, Unity `.cs` Texture3D importer), uncompressed DDS volume, EXR (WASM: tinyexr/exrs), **animated frame-sequence export** (old FutureFeatures #1 — cheap, `generateFrameData` exists), batch/variation export | pipeline-real; best after B (multi-channel makes formats worth it) | M |
| **E. Deferred ceiling-raisers** | WebGPU compute backend (progressive enhancement only), full node-graph authoring mode, native Tauri sidecar (OpenVDB export, wgpu 1024³ generation), async PBO readback, 1024³ Z-slab streaming export | only if A–D prove insufficient. NOTE: Linux Tauri (WebKitGTK) has no WebGPU and none planned, so WebGL2 stays the baseline regardless | L–XL |

## Settled design decisions (Phase A)

1. **cutoff/contrast = non-destructive, baked on export.** Preview-time uniforms (free to drag); stored volume holds raw layer density; export re-applies them so files still match the preview (v1 export parity).
2. **Storage stays R8; accumulators go RGBA16F.** Float *storage* deferred to B/D where multi-channel / float export needs it.
3. **Phase A includes the low-res drag proxy.** Full "feels live" story, not just "faster."

## Notes carried from research

- WebGPU is a real future ceiling-raiser (512³-live / 1024³-realtime) but a poor v2 *foundation*: Linux Tauri never gets it, so WebGL2 must remain. Adopt only as `navigator.gpu` progressive enhancement if A–D prove insufficient.
- OpenVDB export has no browser WASM writer in 2026 (JS libs are read-only); it belongs in a Tauri native sidecar, not WASM-in-browser. Matches the old `FutureFeatures.md` conclusion.
- A full node graph is deferred because layer-inputs (Phase C) capture ~80% of its value first.

Supersedes the ad-hoc `FutureFeatures.md` backlog (which was half-completed by v1 anyway).
