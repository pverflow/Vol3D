pub mod volume;
use volume::VolumeGen;

pub struct Renderer {
    pub volume: VolumeGen,
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
        Self {
            volume: VolumeGen::new(&rs.device, 128),
        }
    }

    #[allow(dead_code)] // read by Task 3's raymarch bind group
    pub fn volume_view(&self) -> &wgpu::TextureView {
        &self.volume.view
    }
}
