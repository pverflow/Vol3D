# Vol3D v3 — Loopable Warp Offset — Design

**Date:** 2026-08-02
**Status:** Approved (user: make the warp offset loop toggleable — infinite scroll still possible, but looping should be possible so a wind-scrolled flame loops seamlessly).
**Parent:** the distortion warp-offset cycle.

## Problem

The warp offset scrolls the warp field, but the field is aperiodic (Value/Simplex/Worley/Voronoi/White never repeat; Perlin repeats only at `289/freq` ≈ 144 — impractical). So there's no clean offset value that returns to the start → a wind-scrolled flame can't loop.

## Fix — a per-layer "Loop offset" toggle

`warp_loop: bool` per layer. **Off (default):** today's behavior — the warp samples `warp_field` (the selected Warp Noise) at `(q+offset)*freq`, aperiodic, scrolls forever. **On:** the warp samples a **periodic** field (reusing the existing periodic Perlin `pnoise3_core(_, rep)`) that **tiles**, and the offset is measured in **loops** — keyframing **Warp Offset 0 → 1 = one seamless loop** (0 → 2 = two loops, etc.). Answers "how far to loop": **1.0**.

## How (WGSL, `apply_distortion`)

Add `const WARP_LOOP_PERIOD: f32 = 32.0;` (the pnoise repeat; large enough that the spatial period `PERIOD/freq` stays well outside the box for normal frequencies) and:
```wgsl
fn warp_field_loop(p: vec3<f32>) -> f32 {
  return pnoise3_core(p, vec3<f32>(WARP_LOOP_PERIOD)) * 0.5 + 0.5; // periodic, 0..1 like warp_field
}
```
**Rule (uniform):** in loop mode the offset always contributes `ofs*WARP_LOOP_PERIOD` to the warp sample argument (replacing the off-mode offset term), and the field is `warp_field_loop` instead of `warp_field`. The base (non-offset) sampling of `q` is unchanged per type. Concretely, branch on `L.warp_loop`:
- **DomainWarp:** off `wp=(q+ofs)*freq` → loop `wp = q*freq + ofs*WARP_LOOP_PERIOD`; taps `warp_field_loop(wp + o1/o2/o3)`.
- **Turbulence:** off per-octave `wp=q*freq_o` (+ ofs folded in as today) → loop `wp = q*freq_o + ofs*WARP_LOOP_PERIOD` per octave; taps `warp_field_loop(wp + o1/o2/o3)`.
- **Curl:** off 6 taps `warp_field(L, q+ofs±eps)` → loop 6 taps `warp_field_loop(q + ofs*WARP_LOOP_PERIOD ± eps)` (curl uses no `freq`, so the base stays `q`; only the offset term is scaled to `ofs*PERIOD`).

**Why ofs 1.0 loops:** `pnoise(x, PERIOD)` has period `PERIOD` in `x`; the offset contributes `ofs*PERIOD` linearly, so `ofs` and `ofs+1` differ by exactly `PERIOD` in the sample argument → identical field → seamless. Holds for all three types + every turbulence octave. At `warp_loop == false` each branch is the exact current code → byte-identical.

Note: loop mode's warp field is periodic-Perlin regardless of the layer's Warp Noise selector (guarantees tileability); the Warp Noise selector still applies in infinite mode. Document this.

## Layout (`GpuLayer`)

Reuse the trailing pad: rename `_pad_do0`(offset 292) → `warp_loop: u32` (Rust `_pad_do: [f32;3]` → a `warp_loop: u32` + `_pad_do: [f32;2]`, or split the array). **Size stays 304.** `pack_layer` writes `warp_loop as u32` (0/1). Update `gpu_layer_std430_layout` (offset 292 assert). WGSL `GpuLayer` mirrors (`warp_loop: u32` at 292).

## Rust / UI

- `LayerDesc.warp_loop: bool` (default `false`).
- UI: a **"Loop offset"** checkbox in the Distortion `CollapsingHeader`, shown for `distortion_type ∈ {DomainWarp, Curl, Turbulence}` (same gate as Warp Noise/Offset). On change → `mark_dirty`. Not keyframable (it's a mode; the *offset* stays keyframable).

## Scope

**In:** `warp_loop` toggle (per layer); periodic warp path (reuse `pnoise3_core`) for DomainWarp/Curl/Turbulence with offset-in-loops; UI checkbox.
**Out:** exposing WARP_LOOP_PERIOD; making non-Perlin warp noises individually tileable (loop mode always uses periodic Perlin); looping the domain-evolution or other params (separate).

## Testing

- **Unit (Rust):** `GpuLayer` size still 304 + `warp_loop`@292; `pack_layer` writes it; `param`/layout tests green.
- **Shader:** `naga shaders/generate.wgsl` validates the branch + `warp_field_loop`.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** with Loop off, offset scrolls forever (unchanged); with Loop on + a Turbulence/DomainWarp layer, keyframing Warp Offset **0 → 1 over the animation loop** gives a **seamless** drift (no jump at the loop seam); `warp_loop` off = identical to before.

## Success criteria

- Per-layer Loop-offset toggle; loop-on makes offset 1.0 a seamless loop; loop-off = byte-identical to today; layout 304 consistent; gates green; no regression.

## Risks

- **Curl offset scaling in loop mode** — must shift the field by exactly one PERIOD at ofs 1.0 (match curl's current `q+ofs` scaling); reviewer verifies the ofs→PERIOD mapping is consistent across DomainWarp/Curl/Turbulence.
- **Spatial repetition** at very high Warp Freq (period `PERIOD/freq` shrinks) — acceptable/edge; PERIOD=32 keeps it out of view for normal freqs.
- **Layout** (reuse pad @292) — Rust↔WGSL + layout test guard; size unchanged (304).
