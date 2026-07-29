pub mod raymarch;
pub mod volume;
use crate::layer::{GenParams, GpuLayer};
use raymarch::Raymarch;
use volume::VolumeGen;

pub struct Renderer {
    pub volume: VolumeGen,
    pub raymarch: Raymarch,
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
        Self { volume, raymarch }
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
}
