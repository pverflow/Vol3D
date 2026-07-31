use crate::anim::BakeKey;
use crate::camera::CamUniform;
use crate::layer::{GenParams, GpuLayer};
use crate::render::Renderer;

/// Fullscreen-triangle render pipeline that raymarches `Renderer.volume`'s 3D texture.
pub struct Raymarch {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    // NEAREST/clamp sampler for the occupancy overlay (binding 4). Separate from `sampler`
    // because occupancy is R32Float — non-filterable, so it must use a NonFiltering sampler.
    occ_sampler: wgpu::Sampler,
    cam_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl Raymarch {
    pub fn new(
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
        volume_view: &wgpu::TextureView,
        occupancy_view: &wgpu::TextureView,
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
                // 3: occupancy overlay (R32Float, non-filterable -> filterable: false).
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                // 4: NEAREST/clamp sampler for the occupancy overlay (NonFiltering).
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
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
        // NEAREST/clamp: occupancy is a coarse non-filterable R32Float overlay; no interpolation.
        let occ_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("raymarch-occ-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let cam_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("raymarch-cam"),
            size: std::mem::size_of::<CamUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = Self::make_bind_group(
            device,
            &bgl,
            volume_view,
            occupancy_view,
            &sampler,
            &occ_sampler,
            &cam_buf,
        );
        Self {
            pipeline,
            bgl,
            sampler,
            occ_sampler,
            cam_buf,
            bind_group,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn make_bind_group(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        volume_view: &wgpu::TextureView,
        occupancy_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
        occ_sampler: &wgpu::Sampler,
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
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(occupancy_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(occ_sampler),
                },
            ],
        })
    }

    /// Re-creates the bind group against the current volume + occupancy views. Required whenever
    /// the volume texture is replaced (resolution change) or the bound frame changes (playback),
    /// since the old views would otherwise dangle in a cached bind group.
    pub fn rebuild_bind_group(
        &mut self,
        device: &wgpu::Device,
        volume_view: &wgpu::TextureView,
        occupancy_view: &wgpu::TextureView,
    ) {
        self.bind_group = Self::make_bind_group(
            device,
            &self.bgl,
            volume_view,
            occupancy_view,
            &self.sampler,
            &self.occ_sampler,
            &self.cam_buf,
        );
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
        // Derive `macro_dim` from the resolution the BOUND occupancy texture actually has this
        // frame, not the UI's pending target — otherwise a res *decrease* flips `macro_dim`
        // before `generate` rebuilds the texture (~120ms debounce), and the skip grid mismatches
        // the still-wider occupancy, jumping over dense cells (holes). While playing (the only
        // time `playback_phase` is `Some`, per `app.rs`'s `use_cache`) the bound occupancy is the
        // frame cache's own (per-frame, baked at `bake_res` — Task 3), usually smaller than the
        // live volume's `res()`; live and paused (always full-res, see Task 3's pause snap) bind
        // the live volume's occupancy, so `res()` is the right resolution there.
        let mut cam = self.cam;
        let macro_res = if self.playback_phase.is_some() && !r.frame_cache.is_empty() {
            r.frame_cache.bake_res()
        } else {
            r.volume.res()
        };
        cam.macro_dim = crate::anim::macro_dims(macro_res, crate::anim::MACRO) as f32;
        queue.write_buffer(&r.raymarch.cam_buf, 0, bytemuck::bytes_of(&cam));
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
