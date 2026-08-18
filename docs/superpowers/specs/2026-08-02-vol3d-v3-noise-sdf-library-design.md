# Vol3D v3 — Generation Library Parity: Noise + SDF Shapes — Design

**Date:** 2026-08-02
**Status:** Approved (user: close the v2 feature gap top-down; Cycle A = generation-library parity).
**Parent:** v3 generation (`generate.wgsl`) + `layer.rs`/`app.rs` UI. First of the "Big" parity cycles (A noise/SDF, B distortion, C export, D presets).

## Goal

Bring v3's generation primitives to v2 parity for **noise** and **SDF shapes**. Today v3 has Value/Perlin/Simplex/FBM + SdfSphere only. Add:
- **Noise:** Worley (F1 / F2 / F2−F1 via `worley_mode`), Voronoi, White.
- **SDF shapes:** Box, Cone, Capsule, Cylinder, Plume (v3 has Sphere only).
- Fix the two dead stubs in this area: **`worley_mode`** (carried but unread/no UI) and **`sdf_height`** (has a UI control but unread on GPU).

All ports mirror v2's proven GLSL — cited per item. Zero readback; native + WebGPU; `naga`-validated; visual = user GPU run.

## Enum layout (append-only — no renumber, low churn)

`NoiseType` (`layer.rs`), current 0..4 unchanged; append:
```
Value=0 Perlin=1 Simplex=2 Fbm=3 SdfSphere=4         // existing
Worley=5 Voronoi=6 White=7                            // new noise
SdfBox=8 SdfCone=9 SdfCapsule=10 SdfCylinder=11 SdfPlume=12   // new SDF
```
**`is_sdf(t) = (t == 4u) || (t >= 8u)`** — one predicate in WGSL and Rust. All non-SDF noise are 0,1,2,3,5,6,7; all SDF are 4 and 8..12. (No persistence exists yet, so appending is safe; keeps existing layout tests' 0..4 values.)

## Noise ports (v2 GLSL → WGSL in `generate.wgsl`)

v3 already carries `hash33(vec3)->vec3` and `hash23` (ported "for parity", currently unused). White needs **`hash13(vec3)->f32`** — port from `src/shaders/common/hash.glsl`. Seed folds into the hash input (v2 does `hash33(ip + cell + u_seed)`; v3 uses `L.seed` → add `vec3(seed)` / `seed*k` exactly as v2).

- **Worley** (`src/shaders/noise/worley3d.glsl`): 3×3×3 cell search returning `(F1,F2)` via `hash33(ip+cell+vec3(seed))`; `worley_mode` 0→`clamp(1-F1*1.5,0,1)`, 1→`clamp(1-F2*1.1,0,1)`, 2→`clamp((F2-F1)*2,0,1)`. Signature `noise_worley(p, seed, mode: u32) -> f32`.
- **Voronoi** (`src/shaders/noise/voronoi3d.glsl`): 3×3×3, `hash33(cell + vec3(seed*0.1))`, returns `clamp((F2−F1)*2.5,0,1)`. `noise_voronoi(p, seed) -> f32`.
- **White** (`src/shaders/noise/white3d.glsl`): `hash13(floor(p) + vec3(seed*0.91))`. `noise_white(p, seed) -> f32`.

Wire into:
- `eval_noise` switch: `case 5u → noise_worley(p, L.seed, L.worley_mode)`, `6u → noise_voronoi`, `7u → noise_white`.
- `eval_base_noise` (fbm base): add `case 5u/6u/7u` so FBM can use Worley/Voronoi/White as its base (v2 allows any non-fbm/non-sdf base). Keep 0/1/2.

## SDF ports (v2 `src/core/sdfField.ts` + `src/shaders/noise/sdf_*.glsl` → WGSL)

Each returns the **soft field**, matching the existing sphere exactly:
`let sd = <signed distance>; return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);`
Params from `GpuLayer`: `sdf_radius`, `sdf_softness`, `sdf_height`. Use each shape's v2 semantics from `sdfField.ts` (e.g. cone height = 2×radius; capsule/cylinder/plume use independent `sdf_height`; plume tapers radius 100%→15% base→top). **`sdf_height` MUST be read** by the shapes that use it (fixes the dead field).
- `sdf_box(p, radius, softness)` — box half-extent = radius (`sdf_box.glsl`).
- `sdf_cone(p, radius, softness)` — capped cone, height 2×radius (`sdf_cone.glsl`).
- `sdf_capsule(p, radius, height, softness)` — independent height (`sdf_capsule.glsl`).
- `sdf_cylinder(p, radius, height, softness)` — flat-capped, independent height (`sdf_cylinder.glsl`).
- `sdf_plume(p, radius, height, softness)` — tapered capsule (`sdf_plume.glsl`).

Dispatch: `eval_noise` `case 8u..12u`. **Refactor the three `L.noise_type == 4u` special-cases** (`eval_noise` sphere case ~601, the SDF position-centering branch ~642, the SDF single-sample branch ~707) to use **`is_sdf(L.noise_type)`** so all SDF types share the centered/single-sample path. Sphere stays `case 4u` inside the SDF dispatch.

## UI (`app.rs` properties panel + `layer.rs`)

- Noise-type combo: add Worley, Voronoi, White, and the 5 SDF shapes (label them e.g. "SDF Box"). Keep existing entries.
- **Worley mode** selector (combo: F1 / F2 / F2−F1 → `worley_mode` 0/1/2), shown only when `noise_type == Worley`.
- SDF params: today radius/softness/height show only for `SdfSphere`; generalize the condition to **`is_sdf(...)`**. Show `sdf_height` only for shapes that use it (capsule/cylinder/plume; and cone if v2 uses it) — or show for all SDF and let unused shapes ignore it (simpler; note in code). Match v2's `PropertiesPanel` gating where cheap.
- `fbm_base` combo: allow Value/Perlin/Simplex/Worley/Voronoi/White (exclude Fbm + SDFs).
- Add a Rust `NoiseType::is_sdf(self) -> bool` helper for the UI conditionals (mirror the WGSL predicate).

## Scope

**In:** Worley(+mode)/Voronoi/White noise; Box/Cone/Capsule/Cylinder/Plume SDFs; `hash13`; `is_sdf` predicate (Rust+WGSL) replacing the `==4u` checks; `worley_mode` + `sdf_height` wired (dead stubs fixed); UI combo + conditional param exposure; fbm base extended.
**Out / deferred:** distortion (Cycle B), feather/remap-curve UI (Medium tier), export (Cycle C), presets (Cycle D). No change to blend/compositing/animation/raymarch.

## Testing

- **Unit (Rust):** `NoiseType` enum values (append 5..12); `is_sdf()` (true for 4,8,9,10,11,12; false for 0,1,2,3,5,6,7); `GpuLayer` packing of `worley_mode`/`sdf_height`; std430 layout test still passes (no struct size change — fields already exist).
- **Shader:** `naga shaders/generate.wgsl` validates with all new fns + dispatch.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** each new noise renders (Worley cells, Voronoi edges, White static); Worley mode F1/F2/F2−F1 differ; each SDF shape renders correctly, radius/softness/height affect them; existing Value/Perlin/Simplex/FBM/Sphere unchanged; FBM-with-Worley-base works.

## Success criteria

- All 3 new noise types + 5 new SDF shapes selectable and generating; `worley_mode` + `sdf_height` live; existing scenes unchanged; `is_sdf` predicate replaces the scattered `==4u`; both `cargo check` + naga + clippy + tests green. No regression to compositing/animation/raymarch.

## Risks

- **GLSL→WGSL port fidelity** — loop bounds, `hash*` seed folding, `mix`/`clamp` signatures. Mitigate: port line-by-line from the cited v2 files; `naga` validates; user GPU confirms visuals.
- **SDF field convention** — every shape must use the sphere's `1 - smoothstep(0, softness, sd)` wrapper so softness behaves consistently.
- **`is_sdf` refactor** must hit all three `==4u` sites or SDF shapes 8..12 render as noise / mis-position. Reviewer checks all three.
