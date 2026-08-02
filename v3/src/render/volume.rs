use crate::layer::{GenParams, GpuLayer};
use crate::render::occupancy::{make_occupancy_texture, OccupancyBuilder};

/// Ramp LUT atlas width — fixed at 256 texels/row (one texel per 8-bit density value),
/// matching `ramp::build_ramp_lut_atlas`'s contract.
const LUT_WIDTH: u32 = 256;

/// Generates the RGBA volume texture on-GPU: a compute pass evaluates `GenParams.layer_count`
/// `GpuLayer`s (storage buffer) per voxel, sampling each layer's row of the `256xN` ramp LUT
/// atlas for color. No CPU readback — the raymarch pass samples `view` directly.
pub struct VolumeGen {
    dims: [u32; 3],
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    // Coarse max-density-per-macrocell overlay of the live volume (recreated on res change
    // alongside `texture`), refreshed after every `generate`. Task 2 samples it to skip empty
    // space; Task 3 bakes per-frame occupancy separately (via `generate_into`'s optional param).
    occupancy: wgpu::Texture,
    occupancy_view: wgpu::TextureView,
    occupancy_builder: OccupancyBuilder,
    params_buf: wgpu::Buffer,
    layers_buf: wgpu::Buffer,
    layer_capacity: u32,
    lut_texture: wgpu::Texture,
    lut_view: wgpu::TextureView,
    lut_sampler: wgpu::Sampler,
    lut_rows: u32,
    bind_group: wgpu::BindGroup,
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

impl VolumeGen {
    pub fn new(device: &wgpu::Device, dims: [u32; 3]) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("generate"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/generate.wgsl").into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gen-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D3,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gen-pl"),
            // wgpu 29 changed `bind_group_layouts` to `&[Option<&BindGroupLayout>]` and
            // renamed `push_constant_ranges: &[PushConstantRange]` to `immediate_size: u32`
            // (see wgpu-29.0.4/src/api/pipeline_layout.rs). We use no push/immediate data.
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("gen"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let params_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gen-params"),
            size: std::mem::size_of::<GenParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Placeholder capacity: `generate()`'s first call (always run with fresh data before
        // the first paint, per `Vol3dApp`'s `dirty = true` initial state) resizes these to fit
        // the real demo scene before anything ever samples them.
        let layer_capacity = 1;
        let layers_buf = Self::make_layers_buffer(device, layer_capacity);

        let lut_rows = 1;
        let (lut_texture, lut_view) = Self::make_lut_texture(device, lut_rows);
        let lut_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ramp-lut-sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let (texture, view) = Self::make_volume_texture(device, dims);
        let (occupancy, occupancy_view) = make_occupancy_texture(device, dims);
        let occupancy_builder = OccupancyBuilder::new(device);
        let bind_group = Self::make_bind_group(
            device,
            &bgl,
            &view,
            &params_buf,
            &layers_buf,
            &lut_view,
            &lut_sampler,
        );

        Self {
            dims,
            texture,
            view,
            occupancy,
            occupancy_view,
            occupancy_builder,
            params_buf,
            layers_buf,
            layer_capacity,
            lut_texture,
            lut_view,
            lut_sampler,
            lut_rows,
            bind_group,
            bgl,
            pipeline,
        }
    }

    fn make_volume_texture(
        device: &wgpu::Device,
        dims: [u32; 3],
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("volume"),
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

    fn make_layers_buffer(device: &wgpu::Device, capacity: u32) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gen-layers"),
            size: (capacity as u64) * std::mem::size_of::<GpuLayer>() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    fn make_lut_texture(device: &wgpu::Device, rows: u32) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("ramp-lut"),
            size: wgpu::Extent3d {
                width: LUT_WIDTH,
                height: rows,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }

    #[allow(clippy::too_many_arguments)]
    fn make_bind_group(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        volume_view: &wgpu::TextureView,
        params_buf: &wgpu::Buffer,
        layers_buf: &wgpu::Buffer,
        lut_view: &wgpu::TextureView,
        lut_sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gen-bg"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(volume_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: layers_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(lut_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(lut_sampler),
                },
            ],
        })
    }

    /// Regenerate the internal volume: resizes the internal volume texture when `dims` changed,
    /// then bakes into it via `generate_into`. The live raymarch path samples `self.view`, so
    /// this is unchanged behavior from before the `generate_into` refactor. No CPU readback.
    #[allow(clippy::too_many_arguments)]
    pub fn generate(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        dims: [u32; 3],
        layers: &[GpuLayer],
        params: &GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        if dims != self.dims {
            let (t, v) = Self::make_volume_texture(device, dims);
            self.texture = t;
            self.view = v;
            let (ot, ov) = make_occupancy_texture(device, dims);
            self.occupancy = ot;
            self.occupancy_view = ov;
            self.dims = dims;
        }
        // Clone (an Arc bump) so the internal views aren't borrowed while `&mut self` is passed to
        // `generate_into` — same underlying textures, so the live path is byte-for-byte unchanged.
        let view = self.view.clone();
        let occ = self.occupancy_view.clone();
        self.generate_into(
            device,
            queue,
            &view,
            Some(&occ),
            dims,
            layers,
            params,
            lut_atlas,
            lut_rows,
        );
    }

    /// The live volume's occupancy overlay view (refreshed by `generate`). The raymarch binds
    /// this for empty-space skipping.
    pub fn occupancy_view(&self) -> &wgpu::TextureView {
        &self.occupancy_view
    }

    /// Per-axis dims the volume/occupancy textures currently ARE (not the UI's pending target).
    /// The raymarch derives `macro_dims`/`box_aspect` from this so the skip grid and aspect box
    /// always match the bound occupancy texture, even during the res-change debounce before
    /// `generate` rebuilds.
    pub fn dims(&self) -> [u32; 3] {
        self.dims
    }

    /// Bake one volume into an arbitrary storage-texture `target_view` (binding 0): uploads
    /// `layers`/`params`/`lut_atlas` (a `256 x lut_rows` RGBA8 atlas, one row per layer's color
    /// ramp — see `ramp::build_ramp_lut_atlas`), resizing the layers storage buffer / LUT texture
    /// only when `layers.len()` / `lut_rows` actually changed, rebuilds the compute bind group
    /// against `target_view`, then dispatches. `target_view` must be a `dims`-sized rgba16float D3
    /// `STORAGE_BINDING` view. No CPU readback — used for both the live volume and the FrameCache.
    #[allow(clippy::too_many_arguments)]
    pub fn generate_into(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target_view: &wgpu::TextureView,
        occupancy_view: Option<&wgpu::TextureView>,
        dims: [u32; 3],
        layers: &[GpuLayer],
        params: &GenParams,
        lut_atlas: &[u8],
        lut_rows: u32,
    ) {
        let needed_layers = (layers.len() as u32).max(1);
        if needed_layers != self.layer_capacity {
            self.layers_buf = Self::make_layers_buffer(device, needed_layers);
            self.layer_capacity = needed_layers;
        }

        let needed_rows = lut_rows.max(1);
        if needed_rows != self.lut_rows {
            let (t, v) = Self::make_lut_texture(device, needed_rows);
            self.lut_texture = t;
            self.lut_view = v;
            self.lut_rows = needed_rows;
        }

        if !layers.is_empty() {
            queue.write_buffer(&self.layers_buf, 0, bytemuck::cast_slice(layers));
        }
        queue.write_buffer(&self.params_buf, 0, bytemuck::bytes_of(params));
        if !lut_atlas.is_empty() {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.lut_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                lut_atlas,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(LUT_WIDTH * 4),
                    rows_per_image: Some(needed_rows),
                },
                wgpu::Extent3d {
                    width: LUT_WIDTH,
                    height: needed_rows,
                    depth_or_array_layers: 1,
                },
            );
        }

        // Rebuilt every call (not just on resize) since `layers_buf`/`lut_texture` are only
        // *conditionally* replaced above — cheap relative to the compute dispatch itself, and
        // this is only ever reached when the caller is already regenerating (`dirty`) or baking.
        self.bind_group = Self::make_bind_group(
            device,
            &self.bgl,
            target_view,
            &self.params_buf,
            &self.layers_buf,
            &self.lut_view,
            &self.lut_sampler,
        );

        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gen-enc"),
        });
        {
            let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gen-pass"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.pipeline);
            cpass.set_bind_group(0, &self.bind_group, &[]);
            cpass.dispatch_workgroups(
                dims[0].div_ceil(4),
                dims[1].div_ceil(4),
                dims[2].div_ceil(4),
            );
        }
        queue.submit(Some(enc.finish()));

        // Refresh the target's occupancy overlay from the volume we just wrote (skipped when the
        // caller passes `None`, e.g. FrameCache bakes until Task 3 wires per-frame occupancy).
        if let Some(occ) = occupancy_view {
            self.occupancy_builder
                .build(device, queue, target_view, occ, dims);
        }
    }
}
