# Vol3D v3 — HDR Color — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** HDR color for bright fire — a float (RGBA16F) volume, a per-layer keyframable emission scale, and a global exposure + ACES tonemap in the raymarch so highlights roll off instead of clipping.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-hdr-color-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `serde`, `naga`. All under `v3/`. Zero readback.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates touched shaders.
- **`emission == 1.0` stores the same color as today** (float-precision aside); `exposure` default `1.0`. Old saved scenes (no emission/exposure) MUST still load (serde defaults 1.0). `GpuLayer` stays **304**, `CamUniform` stays **112** (reuse pads). Zero readback.
- **Byte-math:** RGBA16F = **8 bytes/voxel** — update every `×4` in the cache/readout to `×8` (a `BYTES_PER_VOXEL` const).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/render/volume.rs    # MOD: Rgba8Unorm → Rgba16Float (3 sites)
v3/src/render/frame_cache.rs # MOD: Rgba8Unorm → Rgba16Float (make_frame)
v3/shaders/generate.wgsl   # MOD: storage <rgba16float,write>; color *= emission
v3/src/anim.rs             # MOD: BYTES_PER_VOXEL=8; playback_bake_dims + max_loop_frames use it; tests
v3/src/layer.rs            # MOD: GpuLayer emission@296 (304); LayerDesc.emission + serde default; ParamField::Emission + get/set; pack_layer; layout test
v3/src/camera.rs           # MOD: CamUniform _pad1@104 → exposure; basis sets 1.0; size test (112)
v3/shaders/raymarch.wgsl   # MOD: Cam.exposure; aces(); col = pow(aces(acc*exposure),0.4545)
v3/src/persistence.rs      # MOD: SceneFile.exposure (serde default 1.0)
v3/src/app.rs              # MOD: exposure field; VRAM readout ×8; Emission row (anim_param) + Exposure slider; to_scene/apply_scene exposure
v3/RUN.md                  # MOD (Task 4)
```

---

## Task 1: RGBA16F volume + byte-math

**Files:** `v3/src/render/volume.rs`, `v3/src/render/frame_cache.rs`, `v3/shaders/generate.wgsl`, `v3/src/anim.rs`, `v3/src/app.rs` (readout).

- [ ] **Step 1: texture format** — `wgpu::TextureFormat::Rgba8Unorm` → `Rgba16Float` at `volume.rs:47,179,207` and `frame_cache.rs:171` (the volume + baked-frame textures; occupancy/LUT unchanged). `generate.wgsl:776`: `texture_storage_3d<rgba8unorm, write>` → `<rgba16float, write>`.
- [ ] **Step 2: byte-math (TDD)** — in `anim.rs` add `pub const BYTES_PER_VOXEL: u64 = 8;`. Use it in `playback_bake_dims` (`n * product * BYTES_PER_VOXEL <= budget_bytes`, was `* 4`) and `max_loop_frames` (`budget_bytes / ((64u64).pow(3) * BYTES_PER_VOXEL)`, was `* 4` → now `/2MiB`). Update the tests: `max_loop_frames(4 * 1024^3) == 2048` (was 4096); `playback_bake_dims([256,256,256], 8, 512MiB)` now needs the doubled bytes — recompute the expected (8 frames × 256³ × 8 = 1 GiB > 512 MiB → reduces to 128³: 8×128³×8 = 128 MiB ≤ 512 MiB → `[128,128,128]`; keep the aspect + floor tests, adjust expected values for ×8). Run → fail → fix → pass.
- [ ] **Step 3: app VRAM readout** — the GB/MB-per-frame readout (`product * 4`) → `* BYTES_PER_VOXEL` (or `* 8`); keep the label format.
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): RGBA16F HDR volume texture + 8-bytes/voxel cache math

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Per-layer emission (keyframable) scaling the color

**Files:** `v3/src/layer.rs`, `v3/shaders/generate.wgsl`, `v3/src/app.rs`.

- [ ] **Step 1: field + layout** — `GpuLayer`: take pad `_pad_do[0]`@296 as `emission: f32` (`_pad_do:[f32;1]`@300; size stays 304). `LayerDesc.emission: f32` with `#[serde(default = "default_emission")]` + `fn default_emission() -> f32 { 1.0 }` and `Default` sets `1.0`. `pack_layer` writes `emission: l.emission`. Update `gpu_layer_std430_layout`: assert `offset_of!(GpuLayer, emission)==296`, size 304.
- [ ] **Step 2: ParamField** — `ParamField += Emission` (→ 30 variants); `ALL`, `label`, `get_param`(`self.emission`)/`set_param`. (`param_get_set_roundtrip` auto-covers it via `ALL`.)
- [ ] **Step 3: generate color × emission** — in `generate.wgsl` where each visible layer's ramp color composites into the output color, multiply that layer's ramp color by its `emission` before compositing (so per-layer emission scales its own contribution). At `emission==1.0` the composited color is identical to today. `textureStore` writes `vec4(hdr_color, density)`.
- [ ] **Step 4: UI** — add an **Emission** row (near the Color/ramp controls) using the `anim_param` helper with `ParamField::Emission`, range `0.0..=16.0` speed `0.05` → `self.layers[i].emission` (keyframable, like the other scalar rows).
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): per-layer emission (keyframable) — scales baked color for HDR fire

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Exposure + ACES tonemap

**Files:** `v3/src/camera.rs`, `v3/shaders/raymarch.wgsl`, `v3/src/persistence.rs`, `v3/src/app.rs`.

- [ ] **Step 1: `CamUniform.exposure`** — take `_pad1`@104 (after `wire_alpha`@100) as `pub exposure: f32`; `basis()` sets `exposure: 1.0` (NOT 0). Size stays 112 (size test unchanged). WGSL `Cam` gains `exposure: f32` at the matching slot.
- [ ] **Step 2: raymarch tonemap** — add to `raymarch.wgsl`:
```wgsl
fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + vec3<f32>(0.03))) / (x * (2.43 * x + vec3<f32>(0.59)) + vec3<f32>(0.14)),
               vec3<f32>(0.0), vec3<f32>(1.0));
}
```
Change `var col = pow(acc, vec3<f32>(0.4545));` (line ~122) → `var col = pow(aces(acc * C.exposure), vec3<f32>(0.4545));`. The wireframe block + `return vec4(col,1.0)` are unchanged.
- [ ] **Step 3: app state + serde** — `Vol3dApp.exposure: f32` (default 1.0). `persistence::SceneFile += exposure: f32` (`#[serde(default)]` on the struct already; set `exposure: 1.0` in `SceneFile::default`). `to_scene` writes `self.exposure`; `apply_scene` sets `self.exposure = s.exposure`. Where the `cam: CamUniform` is built (after `basis()`), set `cam.exposure = self.exposure` (like `wire_alpha`).
- [ ] **Step 4: UI** — an **Exposure** `Slider` (0.1..=4.0) in the top bar (near theme/seed) → `self.exposure`; on change → repaint (it's a render param, not a bake input — no `cache_stale`; the raymarch reads it live each frame, so just editing the field suffices; add `mark_dirty` only if the render needs a nudge — continuous repaint already covers it).
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/raymarch.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): exposure + ACES filmic tonemap in the raymarch (HDR rolloff)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document HDR: the volume is now float (RGBA16F); per-layer **Emission** (keyframable) makes a layer bright/emissive; global **Exposure** + a filmic (ACES) tonemap so bright fire **rolls off instead of clipping to flat white**. Note: the cache now fits ~half as many full-res frames (float is 2× the bytes — readout shows it); existing scenes look slightly more filmic (HDR tonemap — tune with Exposure); pre-HDR saved scenes still load (Emission/Exposure default to 1). Ask the user to report: a fire layer with high Emission looks bright + rolls off (no flat-white clip); Exposure brightens/darkens the render; a plain scene looks ~like before (slightly filmic); playback still works; a pre-HDR saved scene still loads.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): HDR color run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** RGBA16F volume (T1 S1) ✓; byte-math ×8 (T1 S2,S3) ✓; per-layer emission + ParamField + generate scale + UI keyframable (T2) ✓; exposure + ACES tonemap + serde + UI (T3) ✓; emission==1/exposure==1 ≈ today ✓; old saves load (serde defaults) (T2 S1, T3 S3) ✓; naga/tests ✓; GPU run (T4) ✓.
**Placeholder scan:** concrete (formats, aces formula, byte const); the only judgment is where in the composite to apply per-layer emission (T2 S3 — the implementer matches the existing per-layer color-composite spot).
**Type consistency:** `emission`@296 GpuLayer/LayerDesc + `ParamField::Emission` (T2) read in generate + UI; `CamUniform.exposure`@104 (T3) set from `self.exposure` + read in raymarch; `BYTES_PER_VOXEL` (T1) in cache math + readout; `SceneFile.exposure` (T3) in to/apply_scene.
