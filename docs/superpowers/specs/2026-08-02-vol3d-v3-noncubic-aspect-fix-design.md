# Vol3D v3 — Non-Cubic Aspect Fix (min-normalize + camera fit) — Design

**Date:** 2026-08-02
**Status:** Approved (user: making the box taller shrinks the sides / the SDF feels bigger — fix the aspect so sides stay put and the box just gets taller).
**Parent:** the non-cubic-volume cycle.

## Root cause (systematic-debug)

1. **Max-normalization shrinks the non-tall axes.** `aspect_from_dims = dims / max(dims)`, so `[64,64,256] → [0.25,0.25,1.0]`. Growing the tall axis raises `max`, which shrinks X/Y → the box gets narrower on the sides, and an SDF sphere (authored in absolute `scale` units) fills more of the now-narrow width → "feels bigger."
2. **Camera targets a hardcoded `[0.5,0.5,0.5]`** (`camera.rs::basis`), not the box center. For a non-cubic box `[0,aspect]` the true center is `aspect*0.5` — so the box is framed off-center (compounds the weirdness).

## Fix

1. **Min-normalize:** `aspect_from_dims = dims / min(dims)` (min ≥ 1). `[64,64,256] → [1,1,4]`; `[128,128,128] → [1,1,1]` (identity preserved). The smallest axis stays 1, so growing another axis **extends the box in that axis without shrinking the others** — sides keep their size, an SDF sphere keeps its proportions (X/Y sample range `±0.5*scale` unchanged from the cube), the box just shows more extent along the long axis.
2. **Camera frames the box:** `basis()` gains the box aspect (vec3). `center = box_aspect * 0.5`; `eye = center + dir * distance * fit` where `fit = length(box_aspect)/sqrt(3)` (the box's bounding-radius ratio vs the unit cube). At `[1,1,1]`: `center=[0.5,0.5,0.5]`, `fit=1` → byte-identical to today. For a tall box, `fit>1` zooms out just enough to keep the whole box framed (so it doesn't clip top/bottom), and the target is the real box center.

Generation already handles any aspect correctly (`p = (uvw[-0.5]) * aspect * scale`), so min-norm needs no generation change — X/Y ranges are unchanged from the cube; the long axis simply covers more. Occupancy skip + fps-cache derive from voxel `dims`/`bake_dims` (not normalization) → unaffected.

## Changes

- `anim::aspect_from_dims` (`anim.rs`): `max` → `min` (`.min().unwrap().max(1)`). Update its unit test (`[64,64,256]→[1,1,4]`, `[128;3]→[1;1;1]`, `[0;3]→[0;3]`).
- `camera.rs::basis(fov_aspect, steps)` → `basis(fov_aspect, steps, box_aspect: [f32;3])`: `center = [box_aspect[i]*0.5]`; `eye = center + dir*distance*fit`, `fit = (len(box_aspect)/3f32.sqrt())`. Update the `basis_is_orthonormal_and_looks_at_center` test to the box center (still `[0.5]³` at aspect `[1,1,1]`).
- `render/raymarch.rs::prepare`: compute `asp = aspect_from_dims(dims)` (from the BOUND dims — already done, just move it before `basis`) and pass it into `basis`; set `cam.box_aspect_* = asp` as today. (The march box `[0,asp]`, `uvw=pos/asp`, and the per-axis skip already work for `asp > 1`.)

## Scope

**In:** min-normalization; camera box-center + fit-distance. **Out:** per-axis camera auto-fit tuning beyond the bounding-radius heuristic; any generation/occupancy/cache change (none needed).

## Testing

- **Unit (Rust):** `aspect_from_dims` min cases; `basis` at `[1,1,1]` still centers `[0.5]³` + orthonormal (identity), and at `[1,1,4]` targets `[0.5,0.5,2.0]` with a larger eye distance.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`. `naga` (raymarch unchanged, still validates).
- **User GPU run:** `[128,128,128]` identical; growing Z (e.g. `[64,64,256]`) makes the box **taller without the sides shrinking**, an SDF sphere keeps its size on the sides, and the camera keeps the whole tall box in frame (centered, not clipped/off-to-the-side).

## Success criteria

- Taller box = same-size sides + same SDF proportions + more vertical extent; camera centered on and fitting the box; `[128,128,128]` byte-identical; gates green.

## Risks

- **Camera identity at cubic** — `fit=1`, `center=[0.5]³` must be exact at `[1,1,1]`; reviewer + the basis test verify.
- **`basis` signature change** — one caller (`raymarch.rs::prepare`); reconcile.
- **Very asymmetric boxes** (e.g. `[1,1,16]`) render very tall/thin + zoomed way out — correct behavior, not a bug.
