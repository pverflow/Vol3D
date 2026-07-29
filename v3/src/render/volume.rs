use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GenParams {
    pub res: u32,
    pub iso: f32,
    pub noise_scale: f32,
    pub _pad: f32,
}

pub struct VolumeGen {
    res: u32,
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    params_buf: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

impl VolumeGen {
    pub fn new(device: &wgpu::Device, res: u32) -> Self {
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
                        format: wgpu::TextureFormat::Rgba8Unorm,
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
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gen-params"),
            contents: bytemuck::bytes_of(&GenParams {
                res,
                iso: 0.0,
                noise_scale: 1.0,
                _pad: 0.0,
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let (texture, view, bind_group) = Self::make_texture(device, &bgl, &params_buf, res);
        Self {
            res,
            texture,
            view,
            params_buf,
            bind_group,
            bgl,
            pipeline,
        }
    }

    fn make_texture(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        params_buf: &wgpu::Buffer,
        res: u32,
    ) -> (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("volume"),
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
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gen-bg"),
            layout: bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: params_buf.as_entire_binding(),
                },
            ],
        });
        (texture, view, bind_group)
    }

    #[allow(dead_code)] // wired up by Task 3's egui_wgpu CallbackTrait::prepare
    pub fn generate(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        res: u32,
        iso: f32,
        noise_scale: f32,
    ) {
        if res != self.res {
            let (t, v, bg) = Self::make_texture(device, &self.bgl, &self.params_buf, res);
            self.texture = t;
            self.view = v;
            self.bind_group = bg;
            self.res = res;
        }
        queue.write_buffer(
            &self.params_buf,
            0,
            bytemuck::bytes_of(&GenParams {
                res,
                iso,
                noise_scale,
                _pad: 0.0,
            }),
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
            let g = (res + 3) / 4;
            cpass.dispatch_workgroups(g, g, g);
        }
        queue.submit(Some(enc.finish()));
    }
}
