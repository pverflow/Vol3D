# Vol3D v3 — Distortion Warp Offset (scrollable field) — Design

**Date:** 2026-08-02
**Status:** Approved (user: turbulence needs an offset so a looping "flame in the wind" is possible — scroll/advect the warp field).
**Parent:** distortion + distortion-improvements cycles + timeline SP1 (so the offset is keyframable).

## Goal

Add a per-layer `distortion_offset: vec3` that **shifts the warp-field sampling position** for the noise-driven distortions (Domain Warp / Curl / Turbulence). Keyframing it (via the SP1 timeline) **scrolls/advects the turbulence field** over the loop — the missing "wind" knob for a moving-but-looping flame. Purely offsets *where the warp noise is sampled*, not the output position (so it advects the pattern, it doesn't just translate the whole volume).

## WGSL (`generate.wgsl` `apply_distortion`)

Add `let ofs = L.distortion_offset;` (vec3). Apply it to the warp-field **sampling** position only (base position stays unshifted so the result advects the field rather than translating the volume):
- **Domain Warp** (case 1): `let wp = (q + ofs) * L.distortion_frequency;` (was `q * freq`). Result still `q + warp`.
- **Curl** (case 2): sample at `(q + ofs) ± eps` — `warp_field(L, q + ofs + vec3(eps,0,0))`, etc. Result still `q + curl`.
- **Turbulence** (case 5): per octave `let wp = (q + ofs) * freq;` (was `q * freq`). Result still `q + off*strength`.
- **Swirl/Polar** (cases 3/4): unchanged (analytic, no noise field — offset is meaningless there).

Because `ofs` scales with each octave's `freq` uniformly (`(q+ofs)*freq`), a linear keyframe on the offset advects all turbulence scales together (physical wind). Default `[0,0,0]` → byte-identical to today.

## Layout (`GpuLayer`, Rust + WGSL) — reuse the two trailing pads

Current size 288 with `_pad_di0`@280, `_pad_di1`@284. **Repurpose** them + append:
- `distortion_offset_x`@280 (was `_pad_di0`), `distortion_offset_y`@284 (was `_pad_di1`), append `distortion_offset_z`@288, then pad to the next 16-multiple → **size 304**. (Offsets 0..280 unchanged; 280/284 were zero pad, default 0 → no data collision.)
- Mirror in the WGSL `GpuLayer` (`distortion_offset: vec3<f32>` or three scalars matching the Rust layout — implementer picks whichever keeps Rust↔WGSL byte-identical; validate with `naga` + the layout test). `pack_layer` writes `distortion_offset` (default `[0,0,0]`). Update `gpu_layer_std430_layout` (size 304 + the new offsets).

## Rust / ParamField (keyframable)

- `LayerDesc` gains `distortion_offset: [f32;3]` (default `[0.0,0.0,0.0]`).
- `ParamField` += `DistortionOffsetX/Y/Z` (→ 29 variants); extend `ALL`, `label`, `get_param`/`set_param` (→ `distortion_offset[0/1/2]`). The existing `param_get_set_roundtrip` test auto-covers the new variants via `ALL`.

## UI (`app.rs` Distortion section)

- **Warp Offset X/Y/Z** rows (deg-style `DragValue`s, range e.g. `-10.0..=10.0`, speed 0.05), shown for the **noise-driven** types (`DomainWarp | Curl | Turbulence`) — same gate as the Warp Noise combo.
- Each row wrapped in the SP1 `anim_param` helper (with `ParamField::DistortionOffsetX/Y/Z`) so it's **keyframable** — the whole point (keyframe offset.z 0→N over the loop = wind scroll). Changes route through `mark_dirty`.

## Scope

**In:** `distortion_offset` field (layout 304), warp-field sampling offset in domain_warp/curl/turbulence, 3 `ParamField` variants (keyframable), UI Warp Offset XYZ.
**Out:** auto-looping/seamless-wrap helpers (the user authors the loop via keyframes); swirl/polar offset; export/presets.

## Testing

- **Unit (Rust):** `GpuLayer` size 304 + new offsets; `param_get_set_roundtrip` covers the 3 new variants; `ParamField::ALL` len 29.
- **Shader:** `naga shaders/generate.wgsl` validates.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** with a Turbulence layer, changing Warp Offset scrolls the turbulent detail; keyframing offset.z over the loop makes the pattern drift like wind; offset `[0,0,0]` + existing scenes unchanged; Domain Warp/Curl offsets also scroll their fields.

## Success criteria

- Warp Offset scrolls the warp field for domain_warp/curl/turbulence and is keyframable (wind on a looping flame is now authorable); default 0 no-op; layout consistent (304) Rust↔WGSL; gates green; no regression.

## Risks

- **Layout drift** (304) — layout test + naga guard; reviewer checks offsets + that 280/284 changed meaning only from zero pad.
- **Offset in output vs sampling** — must offset the *sampling* position (`q+ofs` inside warp_field taps), NOT the returned `q`, or it just translates the volume. Reviewer confirms base stays unshifted.
