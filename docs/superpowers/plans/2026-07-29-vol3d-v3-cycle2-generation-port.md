# Vol3D v3 — Cycle ② Generation Port (vertical slice) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Replace the PoC's sphere+noise compute with v2's real layer-stack generation ported to a WGSL compute shader — a vertical slice: full layer pipeline (7 blend modes, remap+feather+bezier, per-layer color ramps) with a starter noise set (Perlin, Simplex, FBM, SdfSphere, Value).

**Architecture:** One compute dispatch over the 3D grid; each invocation is one voxel and loops the layer stack read from a storage buffer, evaluating each layer's noise → remap/feather → blend into density → composite its ramp color painter's-over, then `textureStore` `rgba8 [color, density]`. The cycle-① raymarch/egui path is unchanged.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe`/`egui-wgpu =0.35.0`, `bytemuck`, `naga`(CLI, installed). All under `v3/`.

**Spec:** `docs/superpowers/specs/2026-07-29-vol3d-v3-cycle2-generation-port-design.md`.

## Global Constraints

- All code under `v3/`; v2 (repo root) untouched.
- **Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` stay green every task.** `source "$HOME/.cargo/env"` before every cargo/naga call.
- wgpu is `=29.0.4` (unified with egui-wgpu). Reconcile any API drift against installed source + `cargo check`.
- Volume stays `rgba8unorm` D3, `usage = STORAGE_BINDING | TEXTURE_BINDING`, layout `[R,G,B,A]=[colorR,colorG,colorB,density]`. Raymarch pass unchanged.
- **Zero CPU readback** on the render path.
- No GPU in the build sandbox: gates are `cargo check` (both targets) + `cargo test` + `naga` WGSL validation + `cargo clippy -D warnings`. Visual parity is the user's GPU run (final task).
- Port noise/remap/blend from the AUTHORITATIVE v2 GLSL at `src/shaders/**` (named per task) — do not invent the math.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (added/changed under `v3/`)

```
v3/src/
  layer.rs        # GpuLayer (std430) + GenParams uniform + mat3_from_euler + demo scene builder
  ramp.rs         # ColorRamp (Rust) + build_ramp_lut_atlas(layers) -> 256×N RGBA8 bytes
  render/
    volume.rs     # (modified) storage buffer + params uniform + 256×N LUT texture; layer-stack dispatch
  app.rs          # (modified) hold the demo scene + repurposed sliders; pass layer data to generate
shaders/
  generate.wgsl   # (rewritten) noise lib + per-voxel layer loop + remap/feather/blend/color composite
```

---

## Task 1: CPU data model — `GpuLayer` (std430), `GenParams`, `mat3_from_euler`, ramp-LUT atlas + tests

**Files:** Create `v3/src/layer.rs`, `v3/src/ramp.rs`. Modify `v3/src/main.rs` (`mod layer; mod ramp;`).

**Interfaces produced:**
- `GpuLayer` (`#[repr(C)]`, `bytemuck::Pod`/`Zeroable`) — exact std430 layout of the WGSL `GpuLayer` (Task 2). `GenParams` uniform (`res: u32, layer_count: u32, global_seed: f32, anim_phase: f32` + pad to 16).
- `fn mat3_from_euler(rx, ry, rz: f32) -> [[f32;4];3]` — 3 padded columns (`.xyz`=column, `.w`=0) matching WGSL `mat3x3` reconstructed from 3 `vec4`s.
- `RampStop { t: f32, color: [u8;3], alpha: u8 }`, `ColorRamp { enabled: bool, stops: Vec<RampStop> }`, `fn build_ramp_lut_atlas(layers: &[ColorRamp], lut_w: usize) -> Vec<u8>` → `256×N` RGBA8 (row i = layer i; disabled ramp → transparent row; port v2's `buildRampLUT` sampling from `src/core/colorRamp.ts`).
- `fn demo_scene() -> Vec<LayerDesc>` and a `LayerDesc → GpuLayer` packer (LayerDesc is the ergonomic Rust-side layer; GpuLayer is the packed GPU form).

- [ ] **Step 1: `GpuLayer` layout + a size/offset test (TDD — the std430 landmine)**

Define `GpuLayer` with this field order (std430; `rot0..2` are the rotation columns as `vec4`, `.xyz` used, avoiding `mat3x3` stride ambiguity):

```rust
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuLayer {
    pub rot0: [f32; 4],  pub rot1: [f32; 4],  pub rot2: [f32; 4], // 0,16,32  (rotation columns)
    pub scale: [f32; 4],   // 48  (.xyz = scale, .w pad)
    pub offset: [f32; 4],  // 64  (.xyz = offset, .w pad)
    pub remap_curve: [f32; 4],   // 80
    pub feather_curve: [f32; 4], // 96
    pub feather: [f32; 4],       // 112 (.xyz = feather x/y/z, .w pad)
    // scalar block 128..208 (20 × 4 bytes):
    pub amplitude: f32, pub seed: f32, pub opacity: f32, pub in_min: f32,      // 128
    pub in_max: f32, pub out_min: f32, pub out_max: f32, pub sdf_radius: f32,  // 144
    pub sdf_softness: f32, pub sdf_height: f32, pub persistence: f32, pub lacunarity: f32, // 160
    pub noise_type: u32, pub blend_mode: u32, pub invert: u32, pub worley_mode: u32,       // 176
    pub feather_shape: u32, pub octaves: u32, pub fbm_base: u32, pub distortion_type: u32,  // 192
}
```

Test (RED first — write before the struct if you like, or assert immediately):

```rust
#[test]
fn gpu_layer_std430_layout() {
    use std::mem::{size_of, offset_of};
    assert_eq!(size_of::<GpuLayer>(), 208);           // multiple of 16
    assert_eq!(offset_of!(GpuLayer, rot0), 0);
    assert_eq!(offset_of!(GpuLayer, scale), 48);
    assert_eq!(offset_of!(GpuLayer, offset), 64);
    assert_eq!(offset_of!(GpuLayer, remap_curve), 80);
    assert_eq!(offset_of!(GpuLayer, feather), 112);
    assert_eq!(offset_of!(GpuLayer, amplitude), 128);
    assert_eq!(offset_of!(GpuLayer, noise_type), 176);
    assert_eq!(offset_of!(GpuLayer, distortion_type), 204);
}
```

Run: `source "$HOME/.cargo/env" && cd v3 && cargo test gpu_layer_std430_layout`. Adjust the struct until the offsets match exactly (this is the byte-for-byte contract the Task-2 WGSL struct must mirror — Task 2 references these offsets).

- [ ] **Step 2: `GenParams` + `mat3_from_euler` + test**

`GenParams` uniform (16 bytes): `#[repr(C)] { res: u32, layer_count: u32, global_seed: f32, anim_phase: f32 }`.
`mat3_from_euler(rx, ry, rz)` — port v2's `mat3FromEuler` (`src/utils/mathUtils.ts`), degrees→radians handled by the caller (v2 stores rotation in degrees; convert with `to_radians()`), returning 3 padded columns `[[f32;4];3]`. Test against a known rotation (e.g. 90° about Z maps +X→+Y within 1e-5).

- [ ] **Step 3: `ColorRamp` + `build_ramp_lut_atlas` + test**

Port v2's `buildRampLUT`/`sampleStops` (`src/core/colorRamp.ts`) to Rust: sorted stops, clamp outside range, linear interp between bracketing stops, empty/disabled → transparent. `build_ramp_lut_atlas(layers, 256)` produces `256*N*4` bytes, row `i` = layer `i`. Test: a 2-layer set (fire + a flat blue) → row 0 texel at t=1 is white-opaque, row 1 is blue; a disabled ramp row is all-zero.

- [ ] **Step 4: `demo_scene()` + `LayerDesc → GpuLayer` packer**

`LayerDesc` = ergonomic fields (noise type enum, scale/rotation-in-degrees/offset, blend, opacity, invert, remap, sdf/fbm params, ramp). `demo_scene()` returns ~3 layers: (a) FBM cloud (base Simplex, warm ramp), (b) Perlin detail, Multiply blend, (c) SdfSphere mask, Multiply/Subtract. Packer converts each `LayerDesc` to `GpuLayer` (euler→`mat3_from_euler`, enum→u32, unused params zeroed). No GPU here — just data. A small test that `demo_scene()` packs without panicking and yields the expected `layer_count`.

- [ ] **Step 5: gate + commit**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
```
```bash
git add v3 && git commit -m "feat(v3): cycle-2 CPU data model — GpuLayer std430, mat3_from_euler, ramp LUT atlas, demo scene

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Generation compute shader (`generate.wgsl`) — noise lib + layer loop

**Files:** Rewrite `v3/shaders/generate.wgsl`.

**Interfaces:** Consumes the `GpuLayer` byte layout from Task 1 (mirror the field order/offsets EXACTLY) + `GenParams`. Produces the compute entry `main` writing the volume. Bind group (group 0): `@binding(0)` write storage texture `texture_storage_3d<rgba8unorm, write>`; `@binding(1)` `var<uniform> params: GenParams`; `@binding(2)` `var<storage, read> layers: array<GpuLayer>`; `@binding(3)` ramp LUT `texture_2d<f32>` + `@binding(4)` a sampler.

- [ ] **Step 1: Port the support + noise fns from v2 GLSL to WGSL**

Port these v2 files to WGSL functions in `generate.wgsl` (read each; translate GLSL→WGSL — explicit types, `let`/`var`, `fn`, array init syntax; keep the math identical):
- `src/shaders/common/hash.glsl`, `src/shaders/common/math_utils.glsl` (support).
- `src/shaders/noise/value3d.glsl` → `noise_value(p)`, `src/shaders/noise/perlin3d.glsl` → `noise_perlin(p)`, `src/shaders/noise/simplex3d.glsl` → `noise_simplex(p)`.
- `src/shaders/noise/fbm.glsl` → `noise_fbm(p, octaves, persistence, lacunarity, base)` (base selects value/perlin/simplex).
- `src/shaders/noise/sdf_sphere.glsl` → `sdf_sphere(p, radius, softness)`.
Each v2 `noiseEval(vec3 p)` uses uniforms (u_scale, u_octaves, …); in WGSL take those as fn params from the current `GpuLayer` instead. Validate incrementally with `naga shaders/generate.wgsl`.

- [ ] **Step 2: Port remap/feather/bezier + blend**

From `src/shaders/generation/layer_gen.frag.glsl`: `cubicBezierPoint`, `evaluateBezierCurve(curve, x)`, `applyRemapCurve`, `remap(v,inMin,inMax,outMin,outMax)`, `featherMaskBox`, `featherMaskSphere`, `applyFeather(volumePos, density)`. From `src/shaders/common/blend_modes.glsl`: all 7 `blend*` + `applyBlend(mode, base, layer)`. Translate to WGSL (the feather fns take the current layer's feather params + `feather_shape`; the bezier curves come from `remap_curve`/`feather_curve` vec4s).

> **CORRECTION (fidelity to v2 `layer_gen.frag.glsl` — the skeleton below oversimplified; match v2 exactly):**
> - **Per-source-type transform** (NOT a uniform `rot*(uvw*scale)+offset`):
>   - non-SDF: `p = uvw*scale + offset; p = rotation * p;` (v2 also adds `animatedDomainOffset()` — **deferred to cycle ④/animation**, don't port it now; note it).
>   - SDF: `p = (uvw - 0.5)*scale + offset; p = rotation * p;` (centers the shape at the volume center; no anim offset).
> - **Single remap** = v2 `applyRemapCurve`: `t = saturate((v - in_min)/max(in_max-in_min, 1e-4)); t = evaluateBezierCurve(remap_curve, t); v = mix(out_min, out_max, t)`. Do NOT also call a separate linear `remap()` — there is only this one.
> - **Operation order (v2 `main`)**: sample → `applyRemapCurve` → `*= amplitude` → `if invert { v = 1-v }` → `applyFeather(uvw, v)` → `clamp(0,1)`. THEN blend into density + composite color.
> - **Tileability (port `sampleNoiseTileable`)**: for non-SDF, sample the layer's noise at the 8 corners (`uvw`, `uvw - unit offsets`) and trilinear-blend by `clamp(uvw,0,1)` — makes noise seamless (core to Vol3D). SDF samples once (bypass). Wrap the transform+noiseEval in `sample_noise_at(L, uvw)`; add `sample_noise_tileable(L, uvw)` = the 8-corner blend; the loop calls tileable for non-SDF, single for SDF.

- [ ] **Step 3: The `GpuLayer` WGSL struct + per-voxel layer loop**

Declare `struct GpuLayer { … }` mirroring Task 1's field order EXACTLY (rot0/1/2: vec4, scale/offset/feather: vec4 with .xyz used, remap_curve/feather_curve: vec4, then the 20 scalars as f32/u32 in the same order — std430 will match the Rust `#[repr(C)]` because the field order + types match). Then:

```wgsl
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.res || gid.y >= params.res || gid.z >= params.res) { return; }
  let uvw = (vec3<f32>(gid) + 0.5) / f32(params.res);
  var density = 0.0;
  var color = vec3<f32>(0.0);
  let n = params.layer_count;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let L = layers[i];
    let rot = mat3x3<f32>(L.rot0.xyz, L.rot1.xyz, L.rot2.xyz);
    let p = rot * (uvw * L.scale.xyz) + L.offset.xyz;
    var v = eval_noise(L, p);                 // switch on L.noise_type; fallback = value
    v = v * L.amplitude;
    v = remap(v, L.in_min, L.in_max, L.out_min, L.out_max);
    v = apply_remap_curve(v, L.remap_curve);
    if (L.invert != 0u) { v = 1.0 - v; }
    v = apply_feather(uvw, v, L);             // box/sphere per feather_shape + feather_curve
    v = clamp(v, 0.0, 1.0);
    let blended = apply_blend(i32(L.blend_mode), density, v);
    density = mix(density, blended, L.opacity);
    let c = textureSampleLevel(ramp_lut, ramp_samp, vec2<f32>(v, (f32(i) + 0.5) / f32(n)), 0.0);
    let a = c.a * L.opacity;
    color = c.rgb * a + color * (1.0 - a);
  }
  textureStore(vol, vec3<i32>(gid), vec4<f32>(color, density));
}
```

`eval_noise(L, p)` is a `switch (L.noise_type)` dispatching to the ported fns (fbm reads L.octaves/persistence/lacunarity/fbm_base; sdf reads L.sdf_*); `default` → `noise_value(p)`. (Match the `noise_type` u32 values to Task 1's enum ordering — agree on the mapping: 0=Value,1=Perlin,2=Simplex,3=FBM,4=SdfSphere; document it in a comment in BOTH files.)

- [ ] **Step 4: gate**

```bash
source "$HOME/.cargo/env" && cd v3
naga shaders/generate.wgsl          # must validate
```
`naga` clean. (No cargo change yet — Task 3 wires it; but run `cargo check` both targets to confirm nothing broke.)

- [ ] **Step 5: commit**

```bash
git add v3 && git commit -m "feat(v3): generation compute WGSL — starter noise lib + per-voxel layer loop + remap/feather/blend/color

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Renderer integration — storage buffer + ramp-LUT texture + layer-stack dispatch

**Files:** Modify `v3/src/render/volume.rs`, `v3/src/render/mod.rs`, `v3/src/app.rs`.

**Interfaces:** Consumes `GpuLayer`/`GenParams`/`build_ramp_lut_atlas`/`demo_scene` (Task 1) + the `generate.wgsl` bind-group shape (Task 2). Produces `VolumeGen::generate(device, queue, res, &[GpuLayer], &GenParams, lut_atlas_bytes, lut_layers)` (replaces the PoC's `(res, iso, noise_scale)` signature); rebuilds the storage buffer + `256×N` LUT texture when the layer set/res changes.

- [ ] **Step 1: Storage buffer + params uniform + LUT texture**

In `volume.rs`, add: a `wgpu::Buffer` (`STORAGE | COPY_DST`) sized `N * size_of::<GpuLayer>()` holding the packed layers; the `GenParams` uniform buffer; a `256×N` `Rgba8Unorm` `texture_2d` + view + a filtering sampler (LINEAR, clamp) for the ramp atlas. Compute bind-group layout gains bindings 1 (uniform), 2 (`Buffer{ ty: Storage{read_only:true} }`), 3 (`Texture{Float filterable}`), 4 (`Sampler(Filtering)`), keeping binding 0 = the write storage texture. Reconcile exact wgpu-29 names via `cargo check`.

- [ ] **Step 2: `generate()` new signature + dispatch**

`generate` now: (re)create the storage buffer + LUT texture if `layer_count` or `res` changed; `queue.write_buffer` the packed `GpuLayer` slice + `GenParams`; `queue.write_texture` the LUT atlas bytes; recreate the compute bind group against the (possibly new) volume view + buffers; encode the compute pass; `dispatch_workgroups(res.div_ceil(4) × 3)`; submit. No readback. Remove the PoC's `GenParams{iso,noise_scale}` remnants.

- [ ] **Step 3: `app.rs` — hold the demo scene, repurpose sliders, drive generate**

Store `demo_scene()` layers in `Vol3dApp`. Repurpose the 3 PoC sliders to prove reactivity: e.g. a global scale multiplier, the SdfSphere mask radius (layer 2's `sdf_radius`), and `global_seed`. On change → `dirty = true`. In the callback's `prepare`, when dirty: pack the (slider-adjusted) demo layers → `Vec<GpuLayer>`, build the LUT atlas, call `renderer.volume.generate(...)` then rebuild the raymarch bind group (as cycle ① did). Update the left panel labels to the repurposed controls (Resolution combo stays).

- [ ] **Step 4: gate**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown
naga shaders/generate.wgsl && naga shaders/raymarch.wgsl
cargo clippy --all-targets -- -D warnings
```
All green.

- [ ] **Step 5: commit**

```bash
git add v3 && git commit -m "feat(v3): wire layer-stack generation — storage buffer + 256xN ramp LUT + demo scene

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1: Update `RUN.md`** — the app now shows the hardcoded multi-layer colored demo scene (not a plain sphere). Document: what the demo scene is, what the 3 repurposed sliders do, and what to report — does the multi-layer colored volume render; do the sliders react; compare the look to v2's equivalent scene; paste any wgpu validation error (esp. binding the storage buffer / `256×N` LUT / the `GpuLayer` layout — the std430 landmine). Note native (`cargo run`) + web (`trunk serve` → WebGPU browser).

- [ ] **Step 2: commit + STOP for the user's GPU run**

```bash
git add v3/RUN.md && git commit -m "docs(v3): cycle-2 run/verify instructions (multi-layer demo scene)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Then hand off: ask the user to run it and report render + parity + any validation error. Record findings for cycle ②'s completion + the follow-on noise/SDF/distortion adds.

---

## Self-Review

**Spec coverage:** compute layer-loop architecture (T2 S3) ✓; storage-buffer layer model + `GenParams` (T1 S1-2, T3 S1-2) ✓; `256×N` ramp LUT (T1 S3, T3 S1) ✓; all 7 blend modes + remap+feather+bezier (T2 S2) ✓; starter noise Perlin/Simplex/FBM/SdfSphere/Value (T2 S1) ✓; per-layer color composite (T2 S3) ✓; throwaway demo scene + repurposed sliders (T1 S4, T3 S3) ✓; deferred types reserved + safe fallback (T2 S3 `default`) ✓; std430 layout test mandated (T1 S1) ✓; naga + both-target + clippy gates every task ✓; user GPU run (T4) ✓; raymarch unchanged (untouched) ✓.

**Placeholder scan:** the layer-loop WGSL + `GpuLayer` Rust + gates are concrete; the noise/remap/blend math is "port from named authoritative v2 GLSL file X" with `naga` as the gate — appropriate (transcribing all noise WGSL from memory would be less reliable than porting the known-correct source), not a placeholder.

**Type consistency:** `GpuLayer` field order/offsets are the single contract shared by T1's Rust struct + test and T2's WGSL struct; `noise_type` mapping (0=Value,1=Perlin,2=Simplex,3=FBM,4=SdfSphere) is fixed in T2 S3 and used by T1's enum packer; `VolumeGen::generate` signature defined in T3 Interfaces and used in T3 S2-3; `build_ramp_lut_atlas`/`demo_scene`/`mat3_from_euler` names consistent T1↔T3.
