use crate::camera::OrbitCamera;
use crate::render::raymarch::RaymarchCallback;

pub struct Vol3dApp {
    pub res: u32, // 64 / 128 / 256
    pub iso: f32, // 0..1
    pub noise_scale: f32,
    pub cam: OrbitCamera,
    /// Set whenever res/iso/noise_scale change; tells `RaymarchCallback::prepare` to
    /// regenerate the volume next frame. Starts `true` so the first frame generates.
    pub dirty: bool,
}

impl Default for Vol3dApp {
    fn default() -> Self {
        Self {
            res: 128,
            iso: 0.15,
            noise_scale: 6.0,
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
        let (prev_res, prev_iso, prev_noise) = (self.res, self.iso, self.noise_scale);

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
            ui.add(egui::Slider::new(&mut self.iso, 0.0..=1.0).text("Iso"));
            ui.add(egui::Slider::new(&mut self.noise_scale, 1.0..=16.0).text("Noise scale"));
        });

        if self.res != prev_res || self.iso != prev_iso || self.noise_scale != prev_noise {
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
            let cb = RaymarchCallback {
                cam,
                res: self.res,
                iso: self.iso,
                noise_scale: self.noise_scale,
                dirty: self.dirty,
            };
            self.dirty = false;
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, cb));
        });
    }
}
