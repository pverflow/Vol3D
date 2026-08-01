// Dense GPU frame cache for cycle-4 loop playback: N `bake_res³` rgba8unorm D3 textures (plus
// each frame's own occupancy overlay), each baked by the EXISTING generation compute
// (`VolumeGen::generate_into`) at a fixed loop phase. Fully GPU-resident — no CPU readback, no
// buffer map.
#![allow(dead_code)]

use crate::anim::{frame_for_phase, playback_bake_res};
use crate::layer::{GenParams, GpuLayer};
use crate::render::occupancy::make_occupancy_texture;
use crate::render::volume::VolumeGen;

/// Dense `FrameCache` VRAM budget: baked frames use at most this many bytes. `bake` picks the
/// largest `bake_res` (`anim::playback_bake_res`) so the full requested frame count fits this
/// budget, rather than clamping frame count at a fixed resolution (e.g. 512 MB -> 32 frames @
/// 128³, fewer at higher `bake_res`).
const FRAME_CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;

/// N baked loop frames + their views, plus each frame's own occupancy overlay. All frame
/// textures are `bake_res³` rgba8unorm with `STORAGE_BINDING | TEXTURE_BINDING` (written by the
/// compute, then sampled by the raymarch); occupancy textures are
/// `macro_dims(bake_res, MACRO)³` r32float (see `render::occupancy`).
#[derive(Default)]
pub struct FrameCache {
    frames: Vec<wgpu::Texture>,
    views: Vec<wgpu::TextureView>,
    occ_textures: Vec<wgpu::Texture>,
    occ_views: Vec<wgpu::TextureView>,
    bake_res: u32,
    n: u32,
}

impl FrameCache {
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn frame_count(&self) -> u32 {
        self.n
    }

    /// The resolution the baked frames actually ARE (may be smaller than the source/live
    /// resolution — `bake` reduces it via `anim::playback_bake_res` so the full N-frame loop
    /// fits the VRAM budget). `RaymarchCallback::prepare` derives playback's `macro_dim` from
    /// this so the skip grid matches the bound (reduced-res) occupancy texture.
    pub fn bake_res(&self) -> u32 {
        self.bake_res
    }

    /// (Re)allocate N frame + occupancy textures and bake each at phase `i/n` via the existing
    /// generation compute. `source_res` is the live/UI resolution; the actual bake resolution
    /// (`bake_res`) is reduced (`anim::playback_bake_res`) so the full `n_requested`-frame loop
    /// fits `FRAME_CACHE_BUDGET_BYTES` — it fits by construction, so `n` is `n_requested`
    /// unchanged (just floored at 1). All work is GPU-resident — `generate_into` writes directly
    /// into `views[i]`/`occ_views[i]`, no readback/map.
    #[allow(clippy::too_many_arguments)]
    pub fn bake(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        gen: &mut VolumeGen,
        source_res: u32,
        n_requested: u32,
        layers: &[GpuLayer],
        base_params: GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        let bake_res = playback_bake_res(source_res, n_requested, FRAME_CACHE_BUDGET_BYTES);
        let n = n_requested.max(1);

        // Reallocate every bake: `bake_res`/N may have changed and old textures must be dropped
        // so their VRAM is freed before the new set is bound.
        self.frames.clear();
        self.views.clear();
        self.occ_textures.clear();
        self.occ_views.clear();
        for _ in 0..n {
            let (t, v) = Self::make_frame(device, bake_res);
            self.frames.push(t);
            self.views.push(v);
            let (ot, ov) = make_occupancy_texture(device, bake_res);
            self.occ_textures.push(ot);
            self.occ_views.push(ov);
        }
        self.bake_res = bake_res;
        self.n = n;

        let mb = (n as u64 * (bake_res as u64).pow(3) * 4) as f64 / (1024.0 * 1024.0);
        log::info!("FrameCache: baked {n} frames @ {bake_res}³ = {mb:.1} MB VRAM");

        for i in 0..n as usize {
            let mut p = base_params;
            p.res = bake_res;
            p.anim_phase = i as f32 / n as f32;
            gen.generate_into(
                device,
                queue,
                &self.views[i],
                Some(&self.occ_views[i]),
                bake_res,
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

    /// The occupancy overlay for the baked frame nearest `phase` (wrapping), or `None` if
    /// nothing is baked. Parallels `view_for_phase` — always the same frame index, since both
    /// vecs are allocated/cleared together in `bake`.
    pub fn occupancy_for_phase(&self, phase: f32) -> Option<&wgpu::TextureView> {
        if self.occ_views.is_empty() {
            return None;
        }
        self.occ_views.get(frame_for_phase(phase, self.n))
    }

    /// The baked frame at index `i`, or `None` if out of bounds (including an empty cache). For
    /// `interp_frame`-driven playback — the caller fetches both straddling indices and blends.
    pub fn view_at(&self, i: usize) -> Option<&wgpu::TextureView> {
        self.views.get(i)
    }

    /// The occupancy overlay for the baked frame at index `i`, or `None` if out of bounds
    /// (including an empty cache). Parallels `view_at`.
    pub fn occupancy_at(&self, i: usize) -> Option<&wgpu::TextureView> {
        self.occ_views.get(i)
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
