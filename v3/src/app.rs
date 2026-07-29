pub struct Vol3dApp {
    pub res: u32, // 64 / 128 / 256
    pub iso: f32, // 0..1
    pub noise_scale: f32,
}

impl Default for Vol3dApp {
    fn default() -> Self {
        Self {
            res: 128,
            iso: 0.15,
            noise_scale: 6.0,
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
        // `CentralPanel` has no `Default` impl in 0.35.0; `default_margins()` is the
        // equivalent of the old `CentralPanel::default()` (normal frame/margins).
        egui::CentralPanel::default_margins().show(ui, |ui| {
            ui.label("viewport placeholder");
        });
    }
}
