// Occupancy overlay builder (v3 cycle 5, Task 1).
//
// Runs `shaders/occupancy.wgsl`: one compute invocation per macrocell scans its 8³ voxels of a
// generated volume and stores the max density (alpha) into a coarse r32float 3D texture. The
// raymarch (Task 2) samples this to skip empty space. Fully GPU-resident — no CPU readback.

use crate::anim::{macro_dims, MACRO};

/// Builds occupancy textures from generated volumes. Owns the pipeline + a reused 32-byte
/// `OccParams` uniform (`dim_x, dim_y, dim_z, macro_x, macro_y, macro_z, pad, pad`); the bind
/// group is rebuilt per `build` since it binds a caller-supplied (volume, occupancy) view pair.
pub struct OccupancyBuilder {
    pipeline: wgpu::ComputePipeline,
    bgl: wgpu::BindGroupLayout,
    params_buf: wgpu::Buffer,
}

impl OccupancyBuilder {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("occupancy"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/occupancy.wgsl").into()),
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("occ-bgl"),
            entries: &[
                // 0: volume, read via textureLoad (sampled Float texture, D3).
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                // 1: occupancy, write-only r32float storage (D3). R32Float, not R8Unorm:
                // R8Unorm is not a WebGPU storage-texture format. Non-filterable — Task 2
                // samples it with a NEAREST sampler + Texture{ Float{ filterable: false } }.
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::R32Float,
                        view_dimension: wgpu::TextureViewDimension::D3,
                    },
                    count: None,
                },
                // 2: OccParams uniform.
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
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
            label: Some("occ-pl"),
            // wgpu 29: `bind_group_layouts: &[Option<&_>]`, `immediate_size` replaced
            // `push_constant_ranges` (see volume.rs for the same reconciliation).
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("occ"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        // OccParams: 8 x u32 = 32 bytes.
        let params_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("occ-params"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self {
            pipeline,
            bgl,
            params_buf,
        }
    }

    /// Fill `occupancy_view` with the max-density-per-macrocell of `volume_view` (a `dims`-sized
    /// volume). Dispatches one invocation per macrocell (`macro_dims(dims[i], MACRO)` per axis,
    /// workgroup 4³). Submits its own encoder; no readback.
    pub fn build(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        volume_view: &wgpu::TextureView,
        occupancy_view: &wgpu::TextureView,
        dims: [u32; 3],
    ) {
        let macro_x = macro_dims(dims[0], MACRO);
        let macro_y = macro_dims(dims[1], MACRO);
        let macro_z = macro_dims(dims[2], MACRO);
        // OccParams { dim_x, dim_y, dim_z, macro_x, macro_y, macro_z, _p0, _p1 } — a plain [u32; 8].
        queue.write_buffer(
            &self.params_buf,
            0,
            bytemuck::cast_slice(&[
                dims[0], dims[1], dims[2], macro_x, macro_y, macro_z, 0u32, 0u32,
            ]),
        );

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("occ-bg"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(volume_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(occupancy_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.params_buf.as_entire_binding(),
                },
            ],
        });

        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("occ-enc"),
        });
        {
            let mut cpass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("occ-pass"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.pipeline);
            cpass.set_bind_group(0, &bind_group, &[]);
            cpass.dispatch_workgroups(
                macro_x.div_ceil(4),
                macro_y.div_ceil(4),
                macro_z.div_ceil(4),
            );
        }
        queue.submit(Some(enc.finish()));
    }
}

/// A `[macro_dims(dims[0]), macro_dims(dims[1]), macro_dims(dims[2])]` r32float D3 occupancy
/// texture (`STORAGE_BINDING | TEXTURE_BINDING`): written by `OccupancyBuilder::build`, sampled
/// by the raymarch. R32Float (not R8Unorm) because R8Unorm is not a WebGPU storage-texture
/// format; it is non-filterable (Task 2 samples NEAREST).
pub fn make_occupancy_texture(
    device: &wgpu::Device,
    dims: [u32; 3],
) -> (wgpu::Texture, wgpu::TextureView) {
    let macro_x = macro_dims(dims[0], MACRO);
    let macro_y = macro_dims(dims[1], MACRO);
    let macro_z = macro_dims(dims[2], MACRO);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("occupancy"),
        size: wgpu::Extent3d {
            width: macro_x,
            height: macro_y,
            depth_or_array_layers: macro_z,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}
