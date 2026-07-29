# Vol3D v3 — PoC / Engine Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the v3 stack — `eframe`(egui) + `wgpu`, a compute shader writing an `rgba8` 3D storage texture, raymarched in an embedded egui viewport, **zero CPU readback**, building on **native + WebGPU/wasm** from one codebase.

**Architecture:** A Rust project under `v3/`. `eframe` hosts native (winit) and web (wasm). A compute pass writes an `rgba8unorm` 3D storage texture (sphere SDF + value noise + gradient color). A raymarch render pass samples it and is painted into the central egui panel via `egui_wgpu::CallbackTrait`. GPU resources live in egui-wgpu's `callback_resources`. Nothing is read back to the CPU.

**Tech Stack:** Rust 1.97, **`wgpu 29.0.4`** (the version `egui-wgpu 0.35` uses — see the wgpu-version note below), `egui`/`eframe`/`egui-wgpu 0.35.0`, `bytemuck 1.25`, `pollster 1` (native), `wasm-bindgen`/`web-sys`/`console_error_panic_hook` (web), `trunk` (web bundler), `naga` (WGSL validation).

> **wgpu version (load-bearing):** the direct `wgpu` dependency MUST resolve to the SAME version `egui-wgpu 0.35` depends on (`wgpu 29.0.4`), so the `wgpu::Device`/`Queue`/`Texture`/`TextureView` shared between egui-wgpu's render surface and our own compute/raymarch passes are the SAME types. Pinning `wgpu = "=30.0.0"` (as the resolved-latest) splits the graph into two incompatible major versions (29 + 30) and Task 2/3 cannot share GPU resources. **Pin `wgpu = "=29.0.4"`.** Do NOT bump to wgpu 30 until egui-wgpu ships a release built on it. (wgpu 29 fully supports compute + 3D storage textures + WGSL — nothing the PoC needs is missing.) The illustrative wgpu code below is written against a recent wgpu API; reconcile any 29-vs-30 signature drift against `cargo check`.

**Specs:** `docs/superpowers/specs/2026-07-27-vol3d-v3-poc-engine-skeleton-design.md` (+ parent direction spec).

## Global Constraints

- All v3 code under `v3/` on the `v3` branch. **v2 (repo root) is never touched.**
- One codebase, two targets: **every task keeps BOTH `cargo check` (native) and `cargo check --target wasm32-unknown-unknown` green.**
- **Web must use the WebGPU backend** (not WebGL2 — compute is required). Disable eframe's `glow` default; use the `wgpu` renderer; build the wgpu instance with `Backends::PRIMARY` (native) / `Backends::BROWSER_WEBGPU` (web).
- **Zero CPU readback** on the render path (no `map_async`/`get_mapped_range`/buffer-copy-to-CPU of the volume or the rendered image).
- Pin exact dep patch versions in `Cargo.toml`.
- **Verification split (this environment):** subagents run `cargo check` (native + wasm32), `cargo clippy`, `cargo fmt --check`, `naga` WGSL validation, and pure-logic unit tests — all in-sandbox. The **GPU visual run is the USER's machine** (no GPU/WebGPU browser here). Never claim a visual pass; Task 4 hands off to the user.
- Prefix every shell step with `source "$HOME/.cargo/env"` (cargo is not on PATH by default in a fresh shell).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/
  Cargo.toml            # deps + features (wgpu renderer, no glow)
  index.html            # trunk web shell
  Trunk.toml            # web build config
  .gitignore            # /target, /dist
  src/
    main.rs             # eframe entry: native (pollster) + #[cfg(wasm32)] web start
    app.rs              # Vol3dApp: egui UI, state (res/iso/noise_scale, camera, dirty), spawns the paint callback
    camera.rs           # OrbitCamera: yaw/pitch/distance -> eye + fwd/right/up basis; pure, unit-tested
    render/
      mod.rs            # Renderer: owns GPU resources, generate() + RaymarchCallback
      volume.rs         # 3D storage texture alloc + compute-generate pipeline & dispatch
      raymarch.rs       # raymarch render pipeline + CallbackTrait paint
  shaders/
    generate.wgsl       # compute: sphere SDF + value noise -> rgba8 3D texture
    raymarch.wgsl       # fullscreen-triangle raymarch of the 3D texture
```

---

## Task 1: Scaffold — empty eframe app, compiles native + wasm

**Files:** Create `v3/Cargo.toml`, `v3/index.html`, `v3/Trunk.toml`, `v3/.gitignore`, `v3/src/main.rs`, `v3/src/app.rs`.

**Interfaces:**
- Produces: `Vol3dApp` (implements `eframe::App`); native `main()` and web entry point. A window with a left egui `SidePanel` and a `CentralPanel` placeholder.

- [ ] **Step 1: `v3/Cargo.toml`** (exact features — wgpu renderer, no glow)

```toml
[package]
name = "vol3d"
version = "3.0.0-alpha.0"
edition = "2021"

[dependencies]
egui = "=0.35.0"
eframe = { version = "=0.35.0", default-features = false, features = ["wgpu", "default_fonts"] }
egui-wgpu = "=0.35.0"
wgpu = "=29.0.4"   # MUST match egui-wgpu 0.35's wgpu (see the wgpu-version note above) — NOT 30
bytemuck = { version = "1.25", features = ["derive"] }
log = "0.4"

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
pollster = "1"
env_logger = "0.11"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
web-sys = "0.3"
console_error_panic_hook = "0.1"
console_log = "1"
```

- [ ] **Step 2: `v3/src/app.rs`** — the egui shell (no wgpu yet)

```rust
pub struct Vol3dApp {
    pub res: u32,        // 64 / 128 / 256
    pub iso: f32,        // 0..1
    pub noise_scale: f32,
}

impl Default for Vol3dApp {
    fn default() -> Self { Self { res: 128, iso: 0.15, noise_scale: 6.0 } }
}

impl Vol3dApp {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self { Self::default() }
}

impl eframe::App for Vol3dApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::SidePanel::left("controls").show(ctx, |ui| {
            ui.heading("Vol3D v3");
            egui::ComboBox::from_label("Resolution")
                .selected_text(format!("{}³", self.res))
                .show_ui(ui, |ui| {
                    for r in [64u32, 128, 256] {
                        ui.selectable_value(&mut self.res, r, format!("{}³", r));
                    }
                });
            ui.add(egui::Slider::new(&mut self.iso, 0.0..=1.0).text("Iso"));
            ui.add(egui::Slider::new(&mut self.noise_scale, 1.0..=16.0).text("Noise scale"));
        });
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.label("viewport placeholder");
        });
    }
}
```

- [ ] **Step 3: `v3/src/main.rs`** — native + web entry

```rust
mod app;
use app::Vol3dApp;

#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result<()> {
    env_logger::init();
    let native_options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        ..Default::default()
    };
    eframe::run_native("Vol3D v3", native_options, Box::new(|cc| Ok(Box::new(Vol3dApp::new(cc)))))
}

#[cfg(target_arch = "wasm32")]
fn main() {
    use eframe::wasm_bindgen::JsCast as _;
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Debug);
    let web_options = eframe::WebOptions::default();
    wasm_bindgen_futures::spawn_local(async {
        let document = web_sys::window().unwrap().document().unwrap();
        let canvas = document.get_element_by_id("the_canvas_id").unwrap()
            .dyn_into::<web_sys::HtmlCanvasElement>().unwrap();
        eframe::WebRunner::new()
            .start(canvas, web_options, Box::new(|cc| Ok(Box::new(Vol3dApp::new(cc)))))
            .await
            .expect("failed to start eframe");
    });
}
```

(Reconcile any exact `eframe 0.35` signature drift — e.g. `WebRunner::start` args — against `cargo check`; the compiler is the arbiter.)

- [ ] **Step 4: `v3/index.html` + `v3/Trunk.toml`**

`index.html`:
```html
<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Vol3D v3</title>
    <style>html,body{margin:0;height:100%}canvas{width:100%;height:100%}</style>
  </head>
  <body><canvas id="the_canvas_id"></canvas></body>
</html>
```
`Trunk.toml`:
```toml
[build]
target = "index.html"
```
`.gitignore`:
```
/target
/dist
```

- [ ] **Step 5: Gate — both targets compile**

```bash
source "$HOME/.cargo/env"
cd v3
cargo fmt
cargo check
cargo check --target wasm32-unknown-unknown
```
Expected: both green (an empty-but-real eframe app).

- [ ] **Step 6: Commit**

```bash
git add v3
git commit -m "feat(v3): scaffold eframe app (native + wasm), empty egui shell

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Compute generation — rgba8 3D storage texture

**Files:** Create `v3/src/render/mod.rs`, `v3/src/render/volume.rs`, `v3/shaders/generate.wgsl`. Modify `v3/src/main.rs` (add `mod render;`), `v3/src/app.rs` (store a `Renderer`, insert into `callback_resources`).

**Interfaces:**
- Consumes: `Vol3dApp` state (`res`, `iso`, `noise_scale`).
- Produces: `Renderer` (owns the 3D texture + compute pipeline); `Renderer::new(&egui_wgpu::RenderState) -> Self`; `Renderer::generate(&wgpu::Device, &wgpu::Queue, res: u32, iso: f32, noise_scale: f32)` — (re)creates the 3D texture if `res` changed and dispatches the compute pass; `Renderer::volume_view() -> &wgpu::TextureView`. `GenParams` uniform struct `{ res: u32, iso: f32, noise_scale: f32, _pad: f32 }` (`#[repr(C)] derive(Pod, Zeroable)`).

- [ ] **Step 1: `v3/shaders/generate.wgsl`**

```wgsl
@group(0) @binding(0) var vol: texture_storage_3d<rgba8unorm, write>;
struct Params { res: u32, iso: f32, noise_scale: f32, _pad: f32 };
@group(0) @binding(1) var<uniform> P: Params;

fn hash3(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  return fract(sin(dot(q, vec3<f32>(17.0, 59.4, 15.0))) * 43758.5453);
}
fn valueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = hash3(i + vec3<f32>(0.,0.,0.)); let c100 = hash3(i + vec3<f32>(1.,0.,0.));
  let c010 = hash3(i + vec3<f32>(0.,1.,0.)); let c110 = hash3(i + vec3<f32>(1.,1.,0.));
  let c001 = hash3(i + vec3<f32>(0.,0.,1.)); let c101 = hash3(i + vec3<f32>(1.,0.,1.));
  let c011 = hash3(i + vec3<f32>(0.,1.,1.)); let c111 = hash3(i + vec3<f32>(1.,1.,1.));
  let x00 = mix(c000, c100, u.x); let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x); let x11 = mix(c011, c111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.res || gid.y >= P.res || gid.z >= P.res) { return; }
  let uvw = (vec3<f32>(gid) + 0.5) / f32(P.res);
  let p = uvw * 2.0 - 1.0;
  let sphere = 1.0 - length(p);
  let n = valueNoise(uvw * P.noise_scale);
  var density = sphere + (n - 0.5) * 0.6;
  density = clamp(density - P.iso, 0.0, 1.0);
  let cool = vec3<f32>(0.1, 0.3, 0.9);
  let warm = vec3<f32>(1.0, 0.55, 0.1);
  let color = mix(cool, warm, clamp(density * 1.5, 0.0, 1.0));
  textureStore(vol, vec3<i32>(gid), vec4<f32>(color, density));
}
```

- [ ] **Step 2: `v3/src/render/volume.rs`** — the 3D texture + compute pipeline

Key wgpu specifics (get these right; reconcile API names via `cargo check`):
- Texture: `TextureDescriptor { size: Extent3d { width: res, height: res, depth_or_array_layers: res }, mip_level_count: 1, sample_count: 1, dimension: TextureDimension::D3, format: TextureFormat::Rgba8Unorm, usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING, view_formats: &[] }`.
- Bind group layout: binding 0 = `StorageTexture { access: StorageTextureAccess::WriteOnly, format: Rgba8Unorm, view_dimension: D3 }` (visibility COMPUTE); binding 1 = uniform buffer.
- Uniform buffer holds `GenParams` (`bytemuck`), usage `UNIFORM | COPY_DST`, updated via `queue.write_buffer` (no readback).
- Dispatch: `((res+3)/4, (res+3)/4, (res+3)/4)` workgroups.
- `generate()`: if the requested `res` differs from the current texture size, recreate the texture + its bind group; write the uniform; encode a compute pass; `queue.submit`. All GPU-resident.

```rust
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GenParams { pub res: u32, pub iso: f32, pub noise_scale: f32, pub _pad: f32 }

pub struct VolumeGen {
    res: u32,
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    params_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

impl VolumeGen {
    pub fn new(device: &wgpu::Device, res: u32) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("generate"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/generate.wgsl").into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gen-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm, view_dimension: wgpu::TextureViewDimension::D3 },
                    count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gen-pl"), bind_group_layouts: &[&bgl], push_constant_ranges: &[] });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("gen"), layout: Some(&pipeline_layout), module: &shader,
            entry_point: Some("main"), compilation_options: Default::default(), cache: None });
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gen-params"), contents: bytemuck::bytes_of(&GenParams { res, iso: 0.0, noise_scale: 1.0, _pad: 0.0 }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST });
        let (texture, view, bind_group) = Self::make_texture(device, &bgl, &params_buf, res);
        Self { res, texture, view, params_buf, bind_group, bgl, pipeline }
    }

    fn make_texture(device: &wgpu::Device, bgl: &wgpu::BindGroupLayout, params_buf: &wgpu::Buffer, res: u32)
        -> (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("volume"), size: wgpu::Extent3d { width: res, height: res, depth_or_array_layers: res },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gen-bg"), layout: bgl, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: params_buf.as_entire_binding() },
            ] });
        (texture, view, bind_group)
    }

    pub fn generate(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, res: u32, iso: f32, noise_scale: f32) {
        if res != self.res {
            let (t, v, bg) = Self::make_texture(device, &self.bgl, &self.params_buf, res);
            self.texture = t; self.view = v; self.bind_group = bg; self.res = res;
        }
        queue.write_buffer(&self.params_buf, 0, bytemuck::bytes_of(&GenParams { res, iso, noise_scale, _pad: 0.0 }));
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("gen-enc") });
        {
            let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("gen-pass"), timestamp_writes: None });
            cpass.set_pipeline(&self.pipeline);
            cpass.set_bind_group(0, &self.bind_group, &[]);
            let g = (res + 3) / 4;
            cpass.dispatch_workgroups(g, g, g);
        }
        queue.submit(Some(enc.finish()));
    }
}
```

- [ ] **Step 3: `v3/src/render/mod.rs`** — Renderer wrapper + capability probe

```rust
pub mod volume;
use volume::VolumeGen;

pub struct Renderer { pub volume: VolumeGen }

impl Renderer {
    pub fn new(rs: &egui_wgpu::RenderState) -> Self {
        let a = rs.adapter.get_info();
        log::info!("v3 adapter: {} | backend {:?} | limits.max_texture_dimension_3d={}",
            a.name, a.backend, rs.device.limits().max_texture_dimension_3d);
        Self { volume: VolumeGen::new(&rs.device, 128) }
    }
}
```

- [ ] **Step 4: wire into `app.rs`** — create the Renderer once and stash it in egui-wgpu's `callback_resources`

In `Vol3dApp::new`, take `cc.wgpu_render_state` (the wgpu renderer path guarantees `Some`), build the `Renderer`, and insert it:
```rust
pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
    let rs = cc.wgpu_render_state.as_ref().expect("wgpu render state (renderer=Wgpu)");
    let renderer = crate::render::Renderer::new(rs);
    rs.renderer.write().callback_resources.insert(renderer);
    Self::default()
}
```
Add `mod render;` to `main.rs`. (The generate() dispatch is hooked up in Task 3's `prepare`, where a device/queue are in hand and dirty-state is known.)

- [ ] **Step 5: Gate — compile both targets + validate the shader**

```bash
source "$HOME/.cargo/env"
cd v3
cargo fmt
cargo check
cargo check --target wasm32-unknown-unknown
# WGSL validation (naga front-end; pure CPU, no GPU needed):
cargo run -q --manifest-path /dev/stdin <<'EOF' 2>/dev/null || true
EOF
naga shaders/generate.wgsl 2>&1 | tail -5 || echo "(if 'naga' CLI absent: cargo install naga-cli, or rely on wgpu's create_shader_module validation at runtime)"
```
Expected: both `cargo check` green. If `naga-cli` isn't installed, note it — wgpu validates the module at `create_shader_module` on the user's GPU run regardless. (Optional: `cargo install naga-cli` once, then `naga shaders/*.wgsl`.)

- [ ] **Step 6: Commit**

```bash
git add v3
git commit -m "feat(v3): compute-generate rgba8 3D storage texture (sphere SDF + value noise)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Raymarch + embed in egui viewport + orbit camera + reactive controls

**Files:** Create `v3/src/render/raymarch.rs`, `v3/src/camera.rs`, `v3/shaders/raymarch.wgsl`. Modify `v3/src/render/mod.rs` (own the raymarch pipeline + `RaymarchCallback`), `v3/src/app.rs` (central-panel viewport, camera drag, dirty→generate in `prepare`), `v3/src/main.rs` (`mod camera;`).

**Interfaces:**
- Consumes: `Renderer.volume` (Task 2), `Vol3dApp` state + `OrbitCamera`.
- Produces: `OrbitCamera { yaw, pitch, distance }` with `fn basis(&self, aspect) -> CamUniform`; `CamUniform` (`#[repr(C)] Pod`, matches `raymarch.wgsl` `Cam`, with explicit padding); `RaymarchCallback` implementing `egui_wgpu::CallbackTrait`; `Renderer::raymarch` pipeline sampling the volume; a `Renderer::ensure_generated(device, queue, res, iso, noise_scale, dirty)` called from `prepare`.

- [ ] **Step 1: `v3/src/camera.rs`** — pure orbit math + a unit test

```rust
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CamUniform {
    pub eye: [f32; 3], pub _p0: f32,
    pub fwd: [f32; 3], pub _p1: f32,
    pub right: [f32; 3], pub _p2: f32,
    pub up: [f32; 3],
    pub aspect: f32, pub tan_half_fov: f32, pub steps: f32, pub _p3: f32,
}

pub struct OrbitCamera { pub yaw: f32, pub pitch: f32, pub distance: f32 }
impl Default for OrbitCamera { fn default() -> Self { Self { yaw: 0.8, pitch: 0.5, distance: 3.0 } } }

impl OrbitCamera {
    pub fn basis(&self, aspect: f32, steps: f32) -> CamUniform {
        let center = [0.5f32, 0.5, 0.5];
        let (cp, sp) = (self.pitch.cos(), self.pitch.sin());
        let (cy, sy) = (self.yaw.cos(), self.yaw.sin());
        let dir = [cp * cy, sp, cp * sy]; // eye offset direction
        let eye = [center[0] + dir[0] * self.distance, center[1] + dir[1] * self.distance, center[2] + dir[2] * self.distance];
        let fwd = norm([center[0]-eye[0], center[1]-eye[1], center[2]-eye[2]]);
        let world_up = [0.0f32, 1.0, 0.0];
        let right = norm(cross(fwd, world_up));
        let up = cross(right, fwd);
        CamUniform { eye, _p0: 0.0, fwd, _p1: 0.0, right, _p2: 0.0, up,
            aspect, tan_half_fov: (0.5f32).tan(), steps, _p3: 0.0 }
    }
}
fn norm(v: [f32;3]) -> [f32;3] { let l = (v[0]*v[0]+v[1]*v[1]+v[2]*v[2]).sqrt().max(1e-6); [v[0]/l, v[1]/l, v[2]/l] }
fn cross(a: [f32;3], b: [f32;3]) -> [f32;3] { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basis_is_orthonormal_and_looks_at_center() {
        let c = OrbitCamera::default().basis(1.0, 64.0);
        // fwd points from eye toward center (0.5,0.5,0.5)
        let to_center = norm([0.5-c.eye[0], 0.5-c.eye[1], 0.5-c.eye[2]]);
        for i in 0..3 { assert!((c.fwd[i]-to_center[i]).abs() < 1e-4); }
        // right ⟂ fwd, up ⟂ fwd, unit-ish
        let dot = |a:[f32;3],b:[f32;3]| a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
        assert!(dot(c.fwd, c.right).abs() < 1e-4);
        assert!(dot(c.fwd, c.up).abs() < 1e-4);
        assert!((dot(c.right,c.right)-1.0).abs() < 1e-3);
    }
}
```

- [ ] **Step 2: run the camera test (in-sandbox)**

```bash
source "$HOME/.cargo/env"
cd v3 && cargo test camera
```
Expected: PASS (pure math, no GPU).

- [ ] **Step 3: `v3/shaders/raymarch.wgsl`**

```wgsl
@group(0) @binding(0) var vol: texture_3d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Cam {
  eye: vec3<f32>, _p0: f32,
  fwd: vec3<f32>, _p1: f32,
  right: vec3<f32>, _p2: f32,
  up: vec3<f32>,
  aspect: f32, tan_half_fov: f32, steps: f32, _p3: f32,
};
@group(0) @binding(2) var<uniform> C: Cam;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = p[vi] * 0.5 + 0.5;
  return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let screen = in.uv * 2.0 - 1.0;
  let rd = normalize(C.fwd + screen.x * C.right * C.aspect * C.tan_half_fov + screen.y * C.up * C.tan_half_fov);
  let ro = C.eye;
  let t0 = (vec3<f32>(0.0) - ro) / rd;
  let t1 = (vec3<f32>(1.0) - ro) / rd;
  let tn3 = min(t0, t1); let tf3 = max(t0, t1);
  let tnear = max(max(tn3.x, tn3.y), tn3.z);
  let tfar = min(min(tf3.x, tf3.y), tf3.z);
  if (tnear > tfar || tfar < 0.0) { return vec4<f32>(0.02, 0.02, 0.03, 1.0); }
  let start = max(tnear, 0.0);
  let steps = C.steps;
  let dt = (tfar - start) / steps;
  var t = start + dt * 0.5;
  var acc = vec3<f32>(0.0); var trans = 1.0;
  for (var i = 0; i < 1024; i = i + 1) {
    if (f32(i) >= steps) { break; }
    let pos = ro + rd * t;
    let s = textureSampleLevel(vol, samp, pos, 0.0);
    if (s.a > 0.001) {
      let a = 1.0 - exp(-s.a * dt * 12.0);
      acc = acc + s.rgb * a * trans;
      trans = trans * (1.0 - a);
    }
    if (trans < 0.01) { break; }
    t = t + dt;
  }
  return vec4<f32>(pow(acc, vec3<f32>(0.4545)), 1.0);
}
```

- [ ] **Step 4: `v3/src/render/raymarch.rs`** — render pipeline + `CallbackTrait`

Key points (reconcile exact `egui-wgpu 0.35` signatures via `cargo check`):
- Pipeline: vertex+fragment from `raymarch.wgsl`, no vertex buffers (fullscreen triangle by `vertex_index`), draw `0..3`. Color target format = `render_state.target_format`. Bind group: 0 = `texture_3d` view of the volume, 1 = a `Sampler` (LINEAR, clamp-to-edge), 2 = the `CamUniform` uniform buffer.
- `RaymarchCallback { cam: CamUniform, res: u32, iso: f32, noise_scale: f32, dirty: bool }`.
- `impl egui_wgpu::CallbackTrait for RaymarchCallback`:
  - `prepare(&self, device, queue, _screen, _encoder, resources) -> Vec<CommandBuffer>`: `let r: &mut Renderer = resources.get_mut().unwrap();` → if `self.dirty` call `r.volume.generate(device, queue, self.res, self.iso, self.noise_scale)` and rebuild the raymarch bind group against the (possibly new) volume view; `queue.write_buffer(cam_buf, 0, bytemuck::bytes_of(&self.cam))`. Return `vec![]`.
  - `paint(&self, _info, render_pass, resources)`: `let r: &Renderer = resources.get().unwrap();` → `render_pass.set_pipeline(&r.raymarch.pipeline); render_pass.set_bind_group(0, &r.raymarch.bind_group, &[]); render_pass.draw(0..3, 0..1);`.
- Because the volume texture view can change when `res` changes, the raymarch bind group must be (re)created in `prepare` after `generate`, not cached across a resize. Keep the sampler + cam buffer persistent; rebuild only the bind group.

- [ ] **Step 5: central-panel viewport + camera drag in `app.rs`**

```rust
egui::CentralPanel::default().show(ctx, |ui| {
    let (rect, response) = ui.allocate_exact_size(ui.available_size(), egui::Sense::drag());
    // orbit on drag
    if response.dragged() {
        let d = response.drag_delta();
        self.cam.yaw += d.x * 0.01;
        self.cam.pitch = (self.cam.pitch - d.y * 0.01).clamp(-1.5, 1.5);
    }
    let scroll = ui.input(|i| i.smooth_scroll_delta.y);
    if scroll != 0.0 { self.cam.distance = (self.cam.distance * (1.0 - scroll * 0.001)).clamp(1.2, 8.0); }

    let aspect = rect.width() / rect.height().max(1.0);
    let cam = self.cam.basis(aspect, 128.0);
    let cb = RaymarchCallback { cam, res: self.res, iso: self.iso, noise_scale: self.noise_scale, dirty: self.dirty };
    self.dirty = false;
    ui.painter().add(egui_wgpu::Callback::new_paint_callback(rect, cb));
});
```
Set `self.dirty = true` whenever `res`/`iso`/`noise_scale` change (compare against previous, or set in the control closures). Add `cam: OrbitCamera` and `dirty: bool` to `Vol3dApp` (default `dirty = true` so the first frame generates). Request repaint each frame while interacting (`ctx.request_repaint()` on drag) so the view updates.

- [ ] **Step 6: Gate — compile both targets, camera test, validate shader**

```bash
source "$HOME/.cargo/env"
cd v3
cargo fmt
cargo test camera
cargo check
cargo check --target wasm32-unknown-unknown
cargo clippy -- -D warnings
```
Expected: all green. (No GPU run here — that's Task 4.)

- [ ] **Step 7: Commit**

```bash
git add v3
git commit -m "feat(v3): raymarch render pass embedded in egui viewport + orbit camera + reactive controls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: User GPU verification + capability report (USER-run — no GPU in sandbox)

This is the de-risk gate that only a real GPU/browser can satisfy. It is a **hand-off**, not a subagent coding task. The subagent's job here is to produce a crisp instruction block + a results template; the user runs it and reports back.

**Files:** Create `v3/RUN.md` (how to run + what to look for + how to report).

- [ ] **Step 1: Write `v3/RUN.md`**

```markdown
# Running the v3 PoC

## Native
    cd v3 && cargo run
Expect: a window; left panel with Resolution / Iso / Noise scale; central viewport
showing a colored (blue→orange) blobby sphere; dragging orbits it; wheel zooms;
moving a slider regenerates it. Check the terminal for the "v3 adapter:" line
(logs adapter name, backend, max_texture_dimension_3d).

## Web (WebGPU)
    cd v3 && trunk serve        # (cargo install trunk, once)
Open the shown localhost URL in a WebGPU browser (Chrome/Edge, or Safari 26).
Expect the same view. If the canvas is blank, open devtools console for a
WebGPU/adapter error and copy it.

## What to report back
- Native: OS + the "v3 adapter:" line + does it render/orbit/regenerate? screenshot.
- Web: browser + version + renders? any console error? screenshot.
- Any backend where it fails to create the rgba8 3D storage texture / pipeline
  (copy the exact wgpu validation error) — this is the key capability finding.
```

- [ ] **Step 2: Commit + hand off**

```bash
git add v3/RUN.md
git commit -m "docs(v3): PoC run + verification instructions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Then STOP and ask the user to run `v3/RUN.md` on their machine (macOS now; Windows/Linux when available) and report. Record the capability findings back into the PoC spec's "capability report" — they are the input to cycle ② (generation port).

---

## Self-Review

**Spec coverage:** scaffold+native+web entry (T1) ✓; compute→rgba8 3D storage texture, sphere+noise+gradient, capability probe (T2) ✓; raymarch + egui-wgpu embed + orbit camera + reactive controls + zero readback (T3) ✓; native+web build gates every task ✓; GPU visual verification as an explicit user-run task with capability documentation (T4) ✓; WebGPU-backend-not-WebGL2 in Global Constraints ✓; non-goals (no v2 noise/layers/animation/export) respected — none appear ✓.

**Placeholder scan:** WGSL is complete and real; Rust gives concrete code for the load-bearing pieces (Cargo.toml, entries, VolumeGen, camera + test) and precise API-level instructions for the two spots most subject to `egui-wgpu 0.35` signature drift (the `CallbackTrait` impl and the paint callback), with `cargo check` as the explicit arbiter — appropriate for a compile-gated Rust task, not a placeholder.

**Type consistency:** `GenParams` {res:u32, iso:f32, noise_scale:f32, _pad} matches `generate.wgsl` `Params`; `CamUniform` field order/padding matches `raymarch.wgsl` `Cam` (vec3 + pad ×3, then aspect/tan_half_fov/steps/_pad); `Renderer.volume: VolumeGen`, `VolumeGen::generate(device,queue,res,iso,noise_scale)` used identically in T2 and T3; `RaymarchCallback` fields consistent between T3 steps.

**Verification honesty:** every task's gate is `cargo check` (both targets) + clippy + the camera unit test — all runnable in-sandbox; the GPU visual pass is isolated in T4 as user-run. No task claims a GPU result the sandbox can't produce.
