// Dense GPU frame cache for cycle-4 loop playback: N `bake_dims`-sized rgba16float D3 textures
// (plus each frame's own occupancy overlay), each baked by the EXISTING generation compute
// (`VolumeGen::generate_into`) at a fixed loop phase. Fully GPU-resident — no CPU readback, no
// buffer map.
#![allow(dead_code)]

use crate::anim::{aspect_from_dims, frame_for_phase, playback_bake_dims};
use crate::layer::{GenParams, GpuLayer};
use crate::render::occupancy::make_occupancy_texture;
use crate::render::volume::VolumeGen;

/// Dense `FrameCache` VRAM budget: baked frames use at most this many bytes. `bake` picks the
/// largest `bake_dims` (`anim::playback_bake_dims`) so the full requested frame count fits this
/// budget, rather than clamping frame count at a fixed resolution (e.g. 4 GB -> 64 frames @
/// 256³, 512 @ 128³).
pub const FRAME_CACHE_BUDGET_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// N baked loop frames + their views, plus each frame's own occupancy overlay. All frame
/// textures are `bake_dims`-sized rgba16float with `STORAGE_BINDING | TEXTURE_BINDING` (written by
/// the compute, then sampled by the raymarch); occupancy textures are
/// `macro_dims(bake_dims[i], MACRO)` per axis r32float (see `render::occupancy`).
#[derive(Default)]
pub struct FrameCache {
    frames: Vec<wgpu::Texture>,
    views: Vec<wgpu::TextureView>,
    occ_textures: Vec<wgpu::Texture>,
    occ_views: Vec<wgpu::TextureView>,
    bake_dims: [u32; 3],
    n: u32,
}

impl FrameCache {
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn frame_count(&self) -> u32 {
        self.n
    }

    /// The per-axis dims the baked frames actually ARE (may be smaller than the source/live
    /// dims — `bake` reduces it via `anim::playback_bake_dims`, aspect-preserving, so the full
    /// N-frame loop fits the VRAM budget). `RaymarchCallback::prepare` derives playback's
    /// `macro_dims` from this so the skip grid matches the bound (reduced-res) occupancy texture.
    pub fn bake_dims(&self) -> [u32; 3] {
        self.bake_dims
    }

    /// (Re)allocate N frame + occupancy textures and bake each frame `i` from `frames[i]`
    /// (`evaluate_scene_at(i/n)`, already packed to `GpuLayer`s by the caller) at phase `i/n` via
    /// the existing generation compute. `source_dims` is the live/UI dims; the actual bake dims
    /// (`bake_dims`) are reduced (`anim::playback_bake_dims`, aspect-preserving) so the full
    /// `frames.len()` loop fits `FRAME_CACHE_BUDGET_BYTES` — it fits by construction, so `n` is
    /// `frames.len()` unchanged (just floored at 1). All work is GPU-resident — `generate_into`
    /// writes directly into `views[i]`/`occ_views[i]`, no readback/map.
    #[allow(clippy::too_many_arguments)]
    pub fn bake(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        gen: &mut VolumeGen,
        source_dims: [u32; 3],
        frames: &[Vec<GpuLayer>],
        base_params: GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        // `frames.len()` is `app.rs`'s `frame_count`, clamped `>= 1` at its slider (`ui_logic`) —
        // `.max(1)` here just mirrors the old `n_requested` guard rather than trusting that.
        let n = frames.len() as u32;
        let dims = playback_bake_dims(source_dims, n, FRAME_CACHE_BUDGET_BYTES);
        let n = n.max(1);

        // Reallocate every bake: `dims`/N may have changed and old textures must be dropped
        // so their VRAM is freed before the new set is bound.
        self.frames.clear();
        self.views.clear();
        self.occ_textures.clear();
        self.occ_views.clear();
        for _ in 0..n {
            let (t, v) = Self::make_frame(device, dims);
            self.frames.push(t);
            self.views.push(v);
            let (ot, ov) = make_occupancy_texture(device, dims);
            self.occ_textures.push(ot);
            self.occ_views.push(ov);
        }
        self.bake_dims = dims;
        self.n = n;

        let mb = (n as u64 * dims[0] as u64 * dims[1] as u64 * dims[2] as u64 * 4) as f64
            / (1024.0 * 1024.0);
        log::info!(
            "FrameCache: baked {n} frames @ {}x{}x{} = {mb:.1} MB VRAM",
            dims[0],
            dims[1],
            dims[2]
        );

        for (i, ((view, occ_view), frame_layers)) in self
            .views
            .iter()
            .zip(self.occ_views.iter())
            .zip(frames.iter())
            .enumerate()
        {
            let mut p = base_params;
            let aspect = aspect_from_dims(dims);
            p.dim_x = dims[0];
            p.dim_y = dims[1];
            p.dim_z = dims[2];
            p.aspect_x = aspect[0];
            p.aspect_y = aspect[1];
            p.aspect_z = aspect[2];
            p.anim_phase = i as f32 / n as f32;
            gen.generate_into(
                device,
                queue,
                view,
                Some(occ_view),
                dims,
                frame_layers,
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

    fn make_frame(device: &wgpu::Device, dims: [u32; 3]) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("frame-cache-frame"),
            size: wgpu::Extent3d {
                width: dims[0],
                height: dims[1],
                depth_or_array_layers: dims[2],
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }
}
