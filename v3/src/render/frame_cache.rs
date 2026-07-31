// Dense GPU frame cache for cycle-4 loop playback: N `res³` rgba8unorm D3 textures, each baked
// by the EXISTING generation compute (`VolumeGen::generate_into`) at a fixed loop phase. Fully
// GPU-resident — no CPU readback, no buffer map. Task 4 (app.rs) wires play/pause + sampling;
// nothing in the non-test binary calls this yet, hence the blanket allow (mirrors `anim.rs`).
#![allow(dead_code)]

use crate::anim::{frame_for_phase, max_frames};
use crate::layer::{GenParams, GpuLayer};
use crate::render::volume::VolumeGen;

/// Dense `FrameCache` VRAM budget: baked frames use at most this many bytes. Caps N alongside
/// `anim::MAX_FRAMES_CAP` (e.g. 512 MB -> 64 frames @128³, 4 @256³, 1 @512³ — floored at 1).
const FRAME_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// N baked loop frames + their views. All textures are `res³` rgba8unorm with
/// `STORAGE_BINDING | TEXTURE_BINDING` (written by the compute, then sampled by the raymarch).
#[derive(Default)]
pub struct FrameCache {
    frames: Vec<wgpu::Texture>,
    views: Vec<wgpu::TextureView>,
    res: u32,
    n: u32,
}

impl FrameCache {
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn frame_count(&self) -> u32 {
        self.n
    }

    /// (Re)allocate N frame textures and bake each at phase `i/n` via the existing generation
    /// compute. `n_requested` is clamped to `max_frames(res, FRAME_CACHE_BUDGET_BYTES)`. All work
    /// is GPU-resident — `generate_into` writes directly into `views[i]`, no readback/map.
    #[allow(clippy::too_many_arguments)]
    pub fn bake(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        gen: &mut VolumeGen,
        res: u32,
        n_requested: u32,
        layers: &[GpuLayer],
        base_params: GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        let n = n_requested
            .min(max_frames(res, FRAME_CACHE_BUDGET_BYTES))
            .max(1);
        if n != n_requested {
            log::info!("FrameCache: clamped {n_requested} -> {n} frames (budget/cap) @ {res}³");
        }

        // Reallocate every bake: `res`/N may have changed and old textures must be dropped so
        // their VRAM is freed before the new set is bound.
        self.frames.clear();
        self.views.clear();
        for _ in 0..n {
            let (t, v) = Self::make_frame(device, res);
            self.frames.push(t);
            self.views.push(v);
        }
        self.res = res;
        self.n = n;

        let mb = (n as u64 * (res as u64).pow(3) * 4) as f64 / (1024.0 * 1024.0);
        log::info!("FrameCache: baked {n} frames @ {res}³ = {mb:.1} MB VRAM");

        for i in 0..n as usize {
            let mut p = base_params;
            p.anim_phase = i as f32 / n as f32;
            gen.generate_into(
                device,
                queue,
                &self.views[i],
                res,
                layers,
                &p,
                lut_atlas,
                lut_rows,
            );
        }
    }

    /// The baked frame nearest `phase` (wrapping), or `None` if nothing is baked.
    pub fn view_for_phase(&self, phase: f32) -> Option<&wgpu::TextureView> {
        if self.views.is_empty() {
            return None;
        }
        self.views.get(frame_for_phase(phase, self.n))
    }

    fn make_frame(device: &wgpu::Device, res: u32) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("frame-cache-frame"),
            size: wgpu::Extent3d {
                width: res,
                height: res,
                depth_or_array_layers: res,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }
}
