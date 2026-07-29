use crate::camera::OrbitCamera;
use crate::layer::{self, BlendMode, GenParams, LayerDesc, NoiseType};
use crate::ramp::{self, ColorRamp};
use crate::render::raymarch::RaymarchCallback;
use crate::ui_logic::{add_layer, delete_layer, duplicate_layer, move_down, move_up, should_regen};

/// Fixed LUT width `ramp::build_ramp_lut_atlas` bakes rows at (one texel per 8-bit density
/// value) — matches `render::volume::VolumeGen`'s LUT texture width.
const LUT_WIDTH: usize = 256;

/// Noise-type choices offered by the Properties panel's combo box, in display order.
const NOISE_TYPES: [NoiseType; 5] = [
    NoiseType::Value,
    NoiseType::Perlin,
    NoiseType::Simplex,
    NoiseType::Fbm,
    NoiseType::SdfSphere,
];

/// Blend-mode choices offered by the Layers/Properties panels' combo boxes, in display order
/// (matches v2's `BLEND_MODE_INDEX`).
const BLEND_MODES: [BlendMode; 7] = [
    BlendMode::Normal,
    BlendMode::Add,
    BlendMode::Multiply,
    BlendMode::Screen,
    BlendMode::Overlay,
    BlendMode::Subtract,
    BlendMode::SmoothMin,
];

fn noise_type_label(t: NoiseType) -> &'static str {
    match t {
        NoiseType::Value => "Value",
        NoiseType::Perlin => "Perlin",
        NoiseType::Simplex => "Simplex",
        NoiseType::Fbm => "FBM",
        NoiseType::SdfSphere => "SDF Sphere",
    }
}

fn blend_label(b: BlendMode) -> &'static str {
    match b {
        BlendMode::Normal => "Normal",
        BlendMode::Add => "Add",
        BlendMode::Multiply => "Multiply",
        BlendMode::Screen => "Screen",
        BlendMode::Overlay => "Overlay",
        BlendMode::Subtract => "Subtract",
        BlendMode::SmoothMin => "Smooth Min",
    }
}

pub struct Vol3dApp {
    /// The authored layer stack (starts from `layer::demo_scene()` so the app opens non-empty).
    pub layers: Vec<LayerDesc>,
    /// Index into `layers` the Properties panel edits. `ui_logic`'s ops keep this in
    /// `[0, layers.len())` (layers is never emptied — `delete_layer` refuses at `len == 1`).
    pub selected: usize,
    /// Volume resolution (64 / 128 / 256), picked in the Layers panel.
    pub resolution: u32,
    /// Folded into every layer's `seed` at pack time (matches v2's `u_seed = layer.seed +
    /// globalSeed`); also carried in `GenParams.global_seed` for parity with the WGSL struct.
    pub global_seed: f32,
    /// True whenever an edit is waiting to be regenerated (set by `mark_dirty`, cleared once the
    /// debounce in `ui_logic::should_regen` fires). Starts `true` so the demo scene generates on
    /// first open.
    pub dirty: bool,
    /// `ctx.input(|i| i.time)` at the most recent edit; `should_regen` compares against this.
    pub last_edit_time: f64,
    /// Set for exactly one frame once the debounce fires; tells `RaymarchCallback::prepare` to
    /// actually regenerate the volume this frame (see `ui()`'s tail and `pack_for_gpu`).
    pub pending_regen: bool,
    pub cam: OrbitCamera,
}

impl Default for Vol3dApp {
    fn default() -> Self {
        Self {
            layers: layer::demo_scene(),
            selected: 0,
            resolution: 128,
            global_seed: 0.0,
            dirty: true,
            last_edit_time: 0.0,
            pending_regen: false,
            cam: OrbitCamera::default(),
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

    /// Any edit routes through here: marks the scene dirty and stamps the edit time the
    /// debounce (`ui_logic::should_regen`) measures against.
    fn mark_dirty(&mut self, ctx: &egui::Context) {
        self.dirty = true;
        self.last_edit_time = ctx.input(|i| i.time);
    }

    /// Pack the *visible* layers into GPU form: `Vec<GpuLayer>` + the `256xN` ramp LUT atlas +
    /// `GenParams`. Invisible layers are dropped from both the layer list and the ramp atlas
    /// (same filter, same order) before packing — they contribute neither shape nor color, and
    /// `shaders/generate.wgsl` indexes the ramp atlas row-by-row against the layer's position in
    /// the (filtered) list, so the two must stay in lockstep.
    fn pack_for_gpu(&self) -> (Vec<layer::GpuLayer>, Vec<u8>, u32, GenParams) {
        let mut packed: Vec<layer::GpuLayer> = self
            .layers
            .iter()
            .filter(|l| l.visible)
            .map(layer::pack_layer)
            .collect();
        for g in packed.iter_mut() {
            g.seed += self.global_seed; // v2: u_seed = layer.seed + globalSeed
        }

        let ramps: Vec<ColorRamp> = self
            .layers
            .iter()
            .filter(|l| l.visible)
            .map(|l| l.ramp.clone())
            .collect();
        let lut_atlas = ramp::build_ramp_lut_atlas(&ramps, LUT_WIDTH);
        let lut_rows = ramps.len() as u32;

        let gen_params = GenParams {
            res: self.resolution,
            layer_count: packed.len() as u32,
            global_seed: self.global_seed,
            anim_phase: 0.0,
        };

        (packed, lut_atlas, lut_rows, gen_params)
    }

    fn layers_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Vol3D v3");

        let prev_res = self.resolution;
        egui::ComboBox::from_label("Resolution")
            .selected_text(format!("{}³", self.resolution))
            .show_ui(ui, |ui| {
                for r in [64u32, 128, 256] {
                    ui.selectable_value(&mut self.resolution, r, format!("{}³", r));
                }
            });
        if self.resolution != prev_res {
            self.mark_dirty(ui.ctx());
        }

        if ui
            .add(
                egui::DragValue::new(&mut self.global_seed)
                    .prefix("Seed: ")
                    .speed(0.1),
            )
            .changed()
        {
            self.mark_dirty(ui.ctx());
        }

        ui.separator();
        ui.label("Layers");

        for i in 0..self.layers.len() {
            ui.horizontal(|ui| {
                if ui.checkbox(&mut self.layers[i].visible, "").changed() {
                    self.mark_dirty(ui.ctx());
                }

                let label = format!("{}: {}", i + 1, noise_type_label(self.layers[i].noise_type));
                if ui.selectable_label(self.selected == i, label).clicked() {
                    self.selected = i;
                }

                let prev_blend = self.layers[i].blend_mode;
                egui::ComboBox::from_id_salt(("layer-blend", i))
                    .selected_text(blend_label(self.layers[i].blend_mode))
                    .show_ui(ui, |ui| {
                        for b in BLEND_MODES {
                            ui.selectable_value(&mut self.layers[i].blend_mode, b, blend_label(b));
                        }
                    });
                if self.layers[i].blend_mode != prev_blend {
                    self.mark_dirty(ui.ctx());
                }
            });
        }

        ui.horizontal(|ui| {
            if ui.button("Add").clicked() {
                self.selected = add_layer(&mut self.layers, self.selected);
                self.mark_dirty(ui.ctx());
            }
            if ui.button("Duplicate").clicked() {
                self.selected = duplicate_layer(&mut self.layers, self.selected);
                self.mark_dirty(ui.ctx());
            }
            if ui.button("Delete").clicked() {
                self.selected = delete_layer(&mut self.layers, self.selected);
                self.mark_dirty(ui.ctx());
            }
            if ui.button("Up").clicked() {
                self.selected = move_up(&mut self.layers, self.selected);
                self.mark_dirty(ui.ctx());
            }
            if ui.button("Down").clicked() {
                self.selected = move_down(&mut self.layers, self.selected);
                self.mark_dirty(ui.ctx());
            }
        });
    }

    /// Properties panel for `layers[selected]`. `ui_logic`'s ops always leave `layers` non-empty
    /// and `selected` in range, but a defensive clamp/return costs nothing and avoids a panic if
    /// that invariant is ever broken.
    fn properties_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Properties");
        if self.layers.is_empty() {
            return;
        }
        let i = self.selected.min(self.layers.len() - 1);

        ui.separator();
        let prev_nt = self.layers[i].noise_type;
        egui::ComboBox::from_label("Noise type")
            .selected_text(noise_type_label(self.layers[i].noise_type))
            .show_ui(ui, |ui| {
                for t in NOISE_TYPES {
                    ui.selectable_value(&mut self.layers[i].noise_type, t, noise_type_label(t));
                }
            });
        if self.layers[i].noise_type != prev_nt {
            self.mark_dirty(ui.ctx());
        }

        ui.label("Scale");
        ui.horizontal(|ui| {
            for axis in 0..3 {
                if ui
                    .add(egui::DragValue::new(&mut self.layers[i].scale[axis]).speed(0.01))
                    .changed()
                {
                    self.mark_dirty(ui.ctx());
                }
            }
        });

        ui.label("Rotation (deg)");
        ui.horizontal(|ui| {
            for axis in 0..3 {
                if ui
                    .add(egui::DragValue::new(&mut self.layers[i].rotation_deg[axis]).speed(1.0))
                    .changed()
                {
                    self.mark_dirty(ui.ctx());
                }
            }
        });

        ui.label("Offset");
        ui.horizontal(|ui| {
            for axis in 0..3 {
                if ui
                    .add(egui::DragValue::new(&mut self.layers[i].offset[axis]).speed(0.01))
                    .changed()
                {
                    self.mark_dirty(ui.ctx());
                }
            }
        });

        if ui
            .add(
                egui::DragValue::new(&mut self.layers[i].amplitude)
                    .prefix("Amplitude: ")
                    .speed(0.01),
            )
            .changed()
        {
            self.mark_dirty(ui.ctx());
        }
        if ui
            .add(
                egui::DragValue::new(&mut self.layers[i].opacity)
                    .prefix("Opacity: ")
                    .speed(0.01)
                    .range(0.0..=1.0),
            )
            .changed()
        {
            self.mark_dirty(ui.ctx());
        }
        if ui.checkbox(&mut self.layers[i].invert, "Invert").changed() {
            self.mark_dirty(ui.ctx());
        }

        ui.label("Remap");
        ui.horizontal(|ui| {
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].in_min)
                        .prefix("in_min: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].in_max)
                        .prefix("in_max: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
        });
        ui.horizontal(|ui| {
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].out_min)
                        .prefix("out_min: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].out_max)
                        .prefix("out_max: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
        });

        let prev_blend = self.layers[i].blend_mode;
        egui::ComboBox::from_label("Blend")
            .selected_text(blend_label(self.layers[i].blend_mode))
            .show_ui(ui, |ui| {
                for b in BLEND_MODES {
                    ui.selectable_value(&mut self.layers[i].blend_mode, b, blend_label(b));
                }
            });
        if self.layers[i].blend_mode != prev_blend {
            self.mark_dirty(ui.ctx());
        }

        if self.layers[i].noise_type == NoiseType::Fbm {
            ui.separator();
            ui.label("FBM");
            if ui
                .add(egui::DragValue::new(&mut self.layers[i].octaves).range(1..=8))
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(egui::DragValue::new(&mut self.layers[i].persistence).speed(0.01))
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(egui::DragValue::new(&mut self.layers[i].lacunarity).speed(0.01))
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            let prev_base = self.layers[i].fbm_base;
            egui::ComboBox::from_label("FBM base")
                .selected_text(noise_type_label(self.layers[i].fbm_base))
                .show_ui(ui, |ui| {
                    for t in NOISE_TYPES {
                        if t != NoiseType::Fbm {
                            ui.selectable_value(
                                &mut self.layers[i].fbm_base,
                                t,
                                noise_type_label(t),
                            );
                        }
                    }
                });
            if self.layers[i].fbm_base != prev_base {
                self.mark_dirty(ui.ctx());
            }
        }

        if self.layers[i].noise_type == NoiseType::SdfSphere {
            ui.separator();
            ui.label("SDF Sphere");
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].sdf_radius)
                        .prefix("Radius: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].sdf_softness)
                        .prefix("Softness: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
            if ui
                .add(
                    egui::DragValue::new(&mut self.layers[i].sdf_height)
                        .prefix("Height: ")
                        .speed(0.01),
                )
                .changed()
            {
                self.mark_dirty(ui.ctx());
            }
        }

        ui.separator();
        ui.label("Color ramp — Task 3");
    }
}

impl eframe::App for Vol3dApp {
    // eframe 0.35.0 (installed): `App::ui` replaces the older `update(&Context, ...)`
    // shape and hands us the root `&mut Ui` directly; panels are shown via
    // `.show(ui, ...)` rather than `.show(ctx, ...)`.
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // `egui::SidePanel` was unified into `egui::Panel` (+ `PanelSide`) in 0.35.0.
        egui::Panel::left("layers").show(ui, |ui| self.layers_panel(ui));
        egui::Panel::right("properties").show(ui, |ui| self.properties_panel(ui));

        // Debounced regen: an edit sets `dirty` + stamps `last_edit_time` (`mark_dirty`, called
        // from the panels above); once `REGEN_DEBOUNCE` has elapsed with no further edits,
        // `should_regen` fires once, clearing `dirty` and arming `pending_regen` for exactly the
        // next `CentralPanel` frame below. While `dirty` is still waiting out the debounce we
        // keep requesting repaints so the window doesn't go idle mid-drag.
        let now = ui.ctx().input(|i| i.time);
        if should_regen(now, self.last_edit_time, self.dirty) {
            self.dirty = false;
            self.pending_regen = true;
        }
        if self.dirty {
            ui.ctx().request_repaint();
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

            let (layers, lut_atlas, lut_rows, gen_params) = if self.pending_regen {
                self.pack_for_gpu()
            } else {
                (
                    Vec::new(),
                    Vec::new(),
                    0,
                    GenParams {
                        res: self.resolution,
                        layer_count: 0,
                        global_seed: self.global_seed,
                        anim_phase: 0.0,
                    },
                )
            };

            let cb = RaymarchCallback {
                cam,
                res: self.resolution,
                layers,
                gen_params,
                lut_atlas,
                lut_rows,
                pending_regen: self.pending_regen,
            };
            self.pending_regen = false;
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, cb));
        });
    }
}
