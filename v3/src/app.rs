use crate::camera::OrbitCamera;
use crate::layer::{self, GenParams, LayerDesc};
use crate::ramp::{self, ColorRamp};
use crate::render::raymarch::RaymarchCallback;

/// Fixed LUT width `ramp::build_ramp_lut_atlas` bakes rows at (one texel per 8-bit density
/// value) — matches `render::volume::VolumeGen`'s LUT texture width.
const LUT_WIDTH: usize = 256;

/// Index of the demo scene's SdfSphere layer (see `layer::demo_scene`) — the "SDF radius"
/// slider writes directly into this layer's `sdf_radius`.
const SDF_LAYER: usize = 2;

pub struct Vol3dApp {
    pub res: u32, // 64 / 128 / 256
    /// Global scale multiplier applied to every layer's noise-space `scale` at pack time —
    /// repurposes the PoC's "Iso" slider slot to prove per-frame reactivity end to end.
    pub scale_mult: f32,
    /// SdfSphere layer's mask radius (repurposes the PoC's "Noise scale" slider slot).
    pub sdf_radius: f32,
    /// Folded into every layer's `seed` at pack time (matches v2's `u_seed = layer.seed +
    /// globalSeed`); also carried in `GenParams.global_seed` for parity with the WGSL struct.
    pub global_seed: f32,
    /// The hardcoded demo layer stack (`layer::demo_scene()`), before slider overrides.
    pub layers: Vec<LayerDesc>,
    pub cam: OrbitCamera,
    /// Set whenever res/scale_mult/sdf_radius/global_seed change; tells `RaymarchCallback::prepare`
    /// to regenerate the volume next frame. Starts `true` so the first frame generates.
    pub dirty: bool,
}

impl Default for Vol3dApp {
    fn default() -> Self {
        let layers = layer::demo_scene();
        let sdf_radius = layers[SDF_LAYER].sdf_radius;
        Self {
            res: 128,
            scale_mult: 1.0,
            sdf_radius,
            global_seed: 0.0,
            layers,
            cam: OrbitCamera::default(),
            dirty: true,
        }
    }
}

impl Vol3dApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let rs = cc
            .wgpu_render_state
            .as_ref()
            .expect("wgpu render state (renderer=Wgpu)");
        let renderer = crate::render::Renderer::new(rs);
        rs.renderer.write().callback_resources.insert(renderer);
        Self::default()
    }

    /// Apply the slider overrides to a clone of the base demo scene, then pack it into GPU
    /// form: `Vec<GpuLayer>` + the `256xN` ramp LUT atlas + `GenParams`. Only called when
    /// `dirty` (see `ui()`) — cheap either way (3 layers), but skipping it when nothing changed
    /// keeps the no-op-frame path allocation-free.
    fn pack_for_gpu(&self) -> (Vec<layer::GpuLayer>, Vec<u8>, u32, GenParams) {
        let mut layers = self.layers.clone();
        for l in layers.iter_mut() {
            l.scale = [
                l.scale[0] * self.scale_mult,
                l.scale[1] * self.scale_mult,
                l.scale[2] * self.scale_mult,
            ];
        }
        layers[SDF_LAYER].sdf_radius = self.sdf_radius;

        let mut packed = layer::pack_layers(&layers);
        for g in packed.iter_mut() {
            g.seed += self.global_seed; // v2: u_seed = layer.seed + globalSeed
        }

        let ramps: Vec<ColorRamp> = layers.iter().map(|l| l.ramp.clone()).collect();
        let lut_atlas = ramp::build_ramp_lut_atlas(&ramps, LUT_WIDTH);
        let lut_rows = layers.len() as u32;

        let gen_params = GenParams {
            res: self.res,
            layer_count: packed.len() as u32,
            global_seed: self.global_seed,
            anim_phase: 0.0,
        };

        (packed, lut_atlas, lut_rows, gen_params)
    }
}

impl eframe::App for Vol3dApp {
    // eframe 0.35.0 (installed): `App::ui` replaces the older `update(&Context, ...)`
    // shape and hands us the root `&mut Ui` directly; panels are shown via
    // `.show(ui, ...)` rather than `.show(ctx, ...)`.
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Snapshot control state so we can detect a change below and mark the volume dirty
        // (simpler and more robust than relying on each widget's own `Response::changed()`,
        // since `ComboBox::show_ui`'s outer response doesn't mark itself changed when a
        // `selectable_value` inside its closure is clicked).
        let (prev_res, prev_scale, prev_sdf, prev_seed) =
            (self.res, self.scale_mult, self.sdf_radius, self.global_seed);

        // `egui::SidePanel` was unified into `egui::Panel` (+ `PanelSide`) in 0.35.0.
        egui::Panel::left("controls").show(ui, |ui| {
            ui.heading("Vol3D v3");
            egui::ComboBox::from_label("Resolution")
                .selected_text(format!("{}³", self.res))
                .show_ui(ui, |ui| {
                    for r in [64u32, 128, 256] {
                        ui.selectable_value(&mut self.res, r, format!("{}³", r));
                    }
                });
            ui.add(egui::Slider::new(&mut self.scale_mult, 0.1..=4.0).text("Scale mult"));
            ui.add(egui::Slider::new(&mut self.sdf_radius, 0.05..=0.6).text("SDF radius"));
            ui.add(egui::Slider::new(&mut self.global_seed, 0.0..=100.0).text("Global seed"));
        });

        if self.res != prev_res
            || self.scale_mult != prev_scale
            || self.sdf_radius != prev_sdf
            || self.global_seed != prev_seed
        {
            self.dirty = true;
        }

        // `CentralPanel` has no `Default` impl in 0.35.0; `default_margins()` is the
        // equivalent of the old `CentralPanel::default()` (normal frame/margins).
        egui::CentralPanel::default_margins().show(ui, |ui| {
            let (rect, response) = ui.allocate_exact_size(ui.available_size(), egui::Sense::drag());

            // Orbit on drag; zoom on scroll while hovering the viewport.
            if response.dragged() {
                let d = response.drag_delta();
                self.cam.yaw += d.x * 0.01;
                self.cam.pitch = (self.cam.pitch - d.y * 0.01).clamp(-1.5, 1.5);
            }
            let scroll = if response.hovered() {
                ui.input(|i| i.smooth_scroll_delta.y)
            } else {
                0.0
            };
            if scroll != 0.0 {
                self.cam.distance = (self.cam.distance * (1.0 - scroll * 0.001)).clamp(1.2, 8.0);
            }
            if response.dragged() || scroll != 0.0 {
                ui.ctx().request_repaint();
            }

            let aspect = rect.width() / rect.height().max(1.0);
            let cam = self.cam.basis(aspect, 128.0);

            let (layers, lut_atlas, lut_rows, gen_params) = if self.dirty {
                self.pack_for_gpu()
            } else {
                (
                    Vec::new(),
                    Vec::new(),
                    0,
                    GenParams {
                        res: self.res,
                        layer_count: 0,
                        global_seed: self.global_seed,
                        anim_phase: 0.0,
                    },
                )
            };

            let cb = RaymarchCallback {
                cam,
                res: self.res,
                layers,
                gen_params,
                lut_atlas,
                lut_rows,
                dirty: self.dirty,
            };
            self.dirty = false;
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, cb));
        });
    }
}
