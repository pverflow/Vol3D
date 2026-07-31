pub mod frame_cache;
pub mod raymarch;
pub mod volume;
use crate::anim::{is_stale, BakeKey};
use crate::layer::{GenParams, GpuLayer};
use frame_cache::FrameCache;
use raymarch::Raymarch;
use volume::VolumeGen;

pub struct Renderer {
    pub volume: VolumeGen,
    pub raymarch: Raymarch,
    // Cycle-4 dense playback cache. Populated by `ensure_baked`; sampled via `playback_view`.
    // Both are only reached once app.rs (Task 4) wires play/pause, hence the allows below.
    #[allow(dead_code)]
    pub frame_cache: FrameCache,
    #[allow(dead_code)]
    baked: Option<BakeKey>,
}

impl Renderer {
    pub fn new(rs: &egui_wgpu::RenderState) -> Self {
        let a = rs.adapter.get_info();
        log::info!(
            "v3 adapter: {} | backend {:?} | limits.max_texture_dimension_3d={}",
            a.name,
            a.backend,
            rs.device.limits().max_texture_dimension_3d
        );
        let volume = VolumeGen::new(&rs.device, 128);
        let raymarch = Raymarch::new(&rs.device, rs.target_format, &volume.view);
        Self {
            volume,
            raymarch,
            frame_cache: FrameCache::default(),
            baked: None,
        }
    }

    /// Called from `RaymarchCallback::prepare` each frame. Regenerates the volume (and rebuilds
    /// the raymarch bind group against its new texture view) only when `dirty`.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_generated(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        res: u32,
        layers: &[GpuLayer],
        params: &GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
        dirty: bool,
    ) {
        if dirty {
            self.volume
                .generate(device, queue, res, layers, params, lut_atlas, lut_rows);
            // Direct field access (not `self.volume_view()`): that helper borrows all of
            // `self` via its `&self` receiver, which would conflict with the `&mut
            // self.raymarch` borrow below even though the two fields are disjoint.
            self.raymarch.rebuild_bind_group(device, &self.volume.view);
        }
    }

    /// Bake the dense loop cache if the current scene (`key`) differs from what was last baked.
    /// Idempotent while the scene is unchanged; does no GPU work when already fresh. The live
    /// path (`ensure_generated`) is untouched — this only fills a separate cache. No readback.
    #[allow(dead_code)]
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_baked(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        key: BakeKey,
        res: u32,
        n: u32,
        layers: &[GpuLayer],
        params: GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        if is_stale(&self.baked, &key) {
            self.frame_cache.bake(
                device,
                queue,
                &mut self.volume,
                res,
                n,
                layers,
                params,
                lut_atlas,
                lut_rows,
            );
            self.baked = Some(key);
        }
    }

    /// The baked frame view nearest `phase`, or `None` if the cache is empty. Task 4 binds this
    /// into the raymarch pass while playing back instead of the live `self.volume.view`.
    #[allow(dead_code)]
    pub fn playback_view(&self, phase: f32) -> Option<&wgpu::TextureView> {
        self.frame_cache.view_for_phase(phase)
    }
}
