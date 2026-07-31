use crate::anim::BakeKey;
use crate::camera::CamUniform;
use crate::layer::{GenParams, GpuLayer};
use crate::render::Renderer;

/// Fullscreen-triangle render pipeline that raymarches `Renderer.volume`'s 3D texture.
pub struct Raymarch {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    cam_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl Raymarch {
    pub fn new(
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
        volume_view: &wgpu::TextureView,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("raymarch"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/raymarch.wgsl").into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("raymarch-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("raymarch-pl"),
            // wgpu 29: `bind_group_layouts: &[Option<&BindGroupLayout>]`, `immediate_size: u32`
            // (see wgpu-29.0.4/src/api/pipeline_layout.rs; same reconciliation as volume.rs).
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("raymarch-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[], // fullscreen triangle generated from vertex_index, no vertex buffers
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(target_format.into())],
            }),
            // wgpu 29 renamed `RenderPipelineDescriptor::multiview` to `multiview_mask`
            // (see wgpu-29.0.4/src/api/render_pipeline.rs).
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("raymarch-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let cam_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("raymarch-cam"),
            size: std::mem::size_of::<CamUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = Self::make_bind_group(device, &bgl, volume_view, &sampler, &cam_buf);
        Self {
            pipeline,
            bgl,
            sampler,
            cam_buf,
            bind_group,
        }
    }

    fn make_bind_group(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        volume_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        cam_buf: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("raymarch-bg"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(volume_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: cam_buf.as_entire_binding(),
                },
            ],
        })
    }

    /// Re-creates the bind group against the current volume view. Required whenever the volume
    /// texture is replaced (resolution change), since the old view would otherwise dangle in a
    /// cached bind group.
    pub fn rebuild_bind_group(&mut self, device: &wgpu::Device, volume_view: &wgpu::TextureView) {
        self.bind_group =
            Self::make_bind_group(device, &self.bgl, volume_view, &self.sampler, &self.cam_buf);
    }
}

/// Camera + generation parameters for one frame's raymarch draw, carried through
/// `egui_wgpu::CallbackTrait` into `Renderer`'s stored pipeline/volume state.
///
/// `layers`/`gen_params`/`lut_atlas`/`lut_rows` are only meaningful when `pending_regen` —
/// `Vol3dApp` packs them (layer stack -> `GpuLayer`s + ramp LUT atlas) on the CPU side in `ui()`
/// once the debounce (`ui_logic::should_regen`) fires, and leaves them empty otherwise, since
/// `ensure_generated` skips the GPU work entirely when `!pending_regen`.
pub struct RaymarchCallback {
    pub cam: CamUniform,
    pub res: u32,
    pub layers: Vec<GpuLayer>,
    pub gen_params: GenParams,
    pub lut_atlas: Vec<u8>,
    pub lut_rows: u32,
    pub pending_regen: bool,
    /// Cycle-4 playback (Task 4). `Some` => bake the dense cache this frame via `ensure_baked`
    /// using the fields above (`layers`/`gen_params`/`lut_*` carry the bake payload, not live
    /// regen data, in that case). `None` => the live path (`ensure_generated`) runs as before.
    pub bake_key: Option<BakeKey>,
    /// Frames to bake when `bake_key` is `Some` (ignored otherwise).
    pub frame_count: u32,
    /// `Some(phase)` => bind the baked frame nearest `phase` as the raymarch volume instead of
    /// the live volume (playing, or paused-with-valid-cache scrub). `None` => live volume.
    pub playback_phase: Option<f32>,
}

impl egui_wgpu::CallbackTrait for RaymarchCallback {
    fn prepare(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _screen_descriptor: &egui_wgpu::ScreenDescriptor,
        _egui_encoder: &mut wgpu::CommandEncoder,
        callback_resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let r: &mut Renderer = callback_resources.get_mut().unwrap();
        if let Some(key) = &self.bake_key {
            // Playback bake path: fills the dense cache (only if stale — `ensure_baked` guards
            // with `is_stale`). The live volume is left untouched.
            r.ensure_baked(
                device,
                queue,
                key.clone(),
                self.res,
                self.frame_count,
                &self.layers,
                self.gen_params,
                &self.lut_atlas,
                self.lut_rows,
            );
        } else {
            // Live path — unchanged.
            r.ensure_generated(
                device,
                queue,
                self.res,
                &self.layers,
                &self.gen_params,
                &self.lut_atlas,
                self.lut_rows,
                self.pending_regen,
            );
        }
        // When playing back (or scrubbing a valid cache), point the raymarch bind group at the
        // cached frame instead of the live volume. Mirrors `ensure_generated`'s rebuild against
        // the live view.
        if let Some(phase) = self.playback_phase {
            r.bind_playback(device, phase);
        }
        queue.write_buffer(&r.raymarch.cam_buf, 0, bytemuck::bytes_of(&self.cam));
        // No readback: generation runs entirely on-GPU (VolumeGen::generate submits its own
        // command buffer), and this callback only ever writes to GPU-side buffers/textures.
        Vec::new()
    }

    fn paint(
        &self,
        _info: egui::PaintCallbackInfo,
        render_pass: &mut wgpu::RenderPass<'static>,
        callback_resources: &egui_wgpu::CallbackResources,
    ) {
        let r: &Renderer = callback_resources.get().unwrap();
        render_pass.set_pipeline(&r.raymarch.pipeline);
        render_pass.set_bind_group(0, &r.raymarch.bind_group, &[]);
        render_pass.draw(0..3, 0..1);
    }
}
