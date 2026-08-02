pub mod frame_cache;
pub mod occupancy;
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
    // Cycle-4 dense playback cache. Populated by `ensure_baked`; bound for the raymarch via
    // `bind_playback`. Wired into app.rs (Task 4) play/pause + scrub.
    pub frame_cache: FrameCache,
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
        let raymarch = Raymarch::new(
            &rs.device,
            rs.target_format,
            &volume.view,
            volume.occupancy_view(),
        );
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
            // `occupancy_view()` borrows only `self.volume`, disjoint from `self.raymarch`.
            // Live/paused: bind the live volume+occupancy to BOTH interpolation slots. The
            // callback leaves `cam.frac = 0`, so `mix(a,a,0)=a` and `max(occ,occ)=occ` → the
            // raymarch is byte-identical to the single-frame path.
            self.raymarch.rebuild_bind_group(
                device,
                &self.volume.view,
                self.volume.occupancy_view(),
                &self.volume.view,
                self.volume.occupancy_view(),
            );
        }
    }

    /// Bake the dense loop cache if the current scene (`key`) differs from what was last baked.
    /// Idempotent while the scene is unchanged; does no GPU work when already fresh. The live
    /// path (`ensure_generated`) is untouched — this only fills a separate cache. No readback.
    #[allow(clippy::too_many_arguments)]
    pub fn ensure_baked(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        key: BakeKey,
        res: u32,
        frames: &[Vec<GpuLayer>],
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
                frames,
                params,
                lut_atlas,
                lut_rows,
            );
            self.baked = Some(key);
        }
    }

    /// Point the raymarch bind group at the baked frame(s) straddling `phase` plus each frame's
    /// own occupancy overlay, and return the interpolation `frac` in `[0,1)` for the callback to
    /// write into `cam.frac`. Returns `None` and leaves the bind group unchanged for an empty
    /// cache — None-safe (all views are `Some` by construction when `frame_count() > 0`). Direct
    /// field access (like `ensure_generated`) so the `&self.frame_cache` view borrows and the
    /// `&mut self.raymarch` rebuild don't collide.
    ///
    /// `interp == true`: binds the PAIR of frames (`i`, `i+1`) straddling `phase`; the raymarch
    /// lerps the two per step (smooth playback). `interp == false`: binds the single nearest
    /// frame to BOTH a/b slots and returns `frac == 0.0` — `mix(sa, sb, 0.0)` on identical
    /// textures is an exact nearest-frame sample, no blend.
    pub fn bind_playback(
        &mut self,
        device: &wgpu::Device,
        phase: f32,
        interp: bool,
    ) -> Option<f32> {
        let n = self.frame_cache.frame_count();
        if n == 0 {
            return None;
        }
        if interp {
            let (i, i1, frac) = crate::anim::interp_frame(phase, n);
            match (
                self.frame_cache.view_at(i),
                self.frame_cache.occupancy_at(i),
                self.frame_cache.view_at(i1),
                self.frame_cache.occupancy_at(i1),
            ) {
                (Some(va), Some(oa), Some(vb), Some(ob)) => {
                    self.raymarch.rebuild_bind_group(device, va, oa, vb, ob);
                    Some(frac)
                }
                _ => None,
            }
        } else {
            let i = crate::anim::frame_for_phase(phase, n);
            match (
                self.frame_cache.view_at(i),
                self.frame_cache.occupancy_at(i),
            ) {
                (Some(v), Some(o)) => {
                    self.raymarch.rebuild_bind_group(device, v, o, v, o);
                    Some(0.0)
                }
                _ => None,
            }
        }
    }
}
