use crate::anim;
use crate::anim_timeline::Timeline;
use crate::camera::OrbitCamera;
use crate::gradient::gradient_editor;
use crate::layer::{self, BlendMode, DistortionType, GenParams, LayerDesc, NoiseType};
use crate::ramp::{self, ColorRamp};
use crate::render::raymarch::RaymarchCallback;
use crate::theme::Theme;
use crate::ui_logic::{add_layer, delete_layer, duplicate_layer, move_down, move_up, should_regen};

/// Fixed LUT width `ramp::build_ramp_lut_atlas` bakes rows at (one texel per 8-bit density
/// value) — matches `render::volume::VolumeGen`'s LUT texture width.
const LUT_WIDTH: usize = 256;

/// Noise-type choices offered by the Properties panel's combo box, in display order.
const NOISE_TYPES: [NoiseType; 13] = [
    NoiseType::Value,
    NoiseType::Perlin,
    NoiseType::Simplex,
    NoiseType::Fbm,
    NoiseType::SdfSphere,
    NoiseType::Worley,
    NoiseType::Voronoi,
    NoiseType::White,
    NoiseType::SdfBox,
    NoiseType::SdfCone,
    NoiseType::SdfCapsule,
    NoiseType::SdfCylinder,
    NoiseType::SdfPlume,
];

/// Worley-mode choices (F1/F2/F2-F1 -> `worley_mode` 0/1/2, matches v2's
/// `WorleyMode` enum order, `src/types/noise.ts`), offered by the Properties
/// panel's Worley Mode combo when `noise_type == Worley`.
const WORLEY_MODES: [u32; 3] = [0, 1, 2];

/// Distortion-type choices offered by the Properties panel's combo box, in display order
/// (matches v2's `DistortionType`, `src/types/layer.ts`).
const DISTORTION_TYPES: [DistortionType; 6] = [
    DistortionType::None,
    DistortionType::DomainWarp,
    DistortionType::Curl,
    DistortionType::Swirl,
    DistortionType::Polar,
    DistortionType::Turbulence,
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
        NoiseType::Worley => "Worley",
        NoiseType::Voronoi => "Voronoi",
        NoiseType::White => "White",
        NoiseType::SdfBox => "SDF Box",
        NoiseType::SdfCone => "SDF Cone",
        NoiseType::SdfCapsule => "SDF Capsule",
        NoiseType::SdfCylinder => "SDF Cylinder",
        NoiseType::SdfPlume => "SDF Plume",
    }
}

/// Label for a `worley_mode` u32 (0/1/2), matching `WORLEY_MODES` order.
fn worley_mode_label(mode: u32) -> &'static str {
    match mode {
        0 => "F1",
        1 => "F2",
        _ => "F2 - F1",
    }
}

fn distortion_type_label(t: DistortionType) -> &'static str {
    match t {
        DistortionType::None => "None",
        DistortionType::DomainWarp => "Domain Warp",
        DistortionType::Curl => "Curl",
        DistortionType::Swirl => "Swirl",
        DistortionType::Polar => "Polar",
        DistortionType::Turbulence => "Turbulence",
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
    /// globalSeed`). Not part of `GenParams` (cycle 4 dropped that field — it was dead there).
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
    /// Which stop of `layers[selected].ramp` the gradient editor has selected, if any. Reset to
    /// `None` in `properties_panel` whenever `selected` (the layer) changes — a stop index from
    /// one layer's ramp is meaningless against another's.
    pub selected_stop: Option<usize>,
    /// `selected` as of the last `properties_panel` call; lets that fn detect a layer switch
    /// (from any of the Layers panel's Add/Duplicate/Delete/Up/Down/select actions) and clear
    /// `selected_stop` without every one of those call sites needing to do it itself.
    last_props_layer: usize,
    /// `layers.len()` as of the last `properties_panel` call. Needed alongside
    /// `last_props_layer`: `delete_layer` can remove a non-last layer and return the *same*
    /// index (now pointing at the layer that shifted down into it), which the index-only check
    /// would miss — comparing the length too catches that case.
    last_layers_len: usize,
    /// Smoothed frame time in ms, shown as the fps/ms readout in the top bar.
    /// ponytail: simple EMA (0.9 old / 0.1 new) — cheap, no history buffer, good enough for a
    /// glance-at readout. `0.0` means "no sample yet"; `ui()` seeds it from the first frame.
    frame_ms_ema: f32,
    /// Active UI theme (`theme::apply` runs this against `egui::Visuals` at startup, and again
    /// from the top bar's toggle button on click). Defaults to `Dark`.
    pub theme: Theme,

    // --- cycle-4 animation state (Task 4) ---
    /// Playback toggle. While `true` the phase clock advances each frame and the raymarch
    /// samples the baked `FrameCache` (at `phase`) instead of the live volume.
    pub playing: bool,
    /// Loop position in `[0, 1)`. Advanced by `anim::advance_phase` while playing; also driven
    /// directly by the phase-scrub slider while paused.
    pub phase: f32,
    /// Wall-clock seconds for one full loop. Also a bake input (`fps * loop_seconds` derives
    /// `frame_count`, see `recompute_frame_count`) — editing it sets `cache_stale`.
    pub loop_seconds: f32,
    /// Noise-cycle count folded into the bake (`GenParams.anim_evolutions`). A bake input →
    /// editing sets `cache_stale`.
    pub evolutions: f32,
    /// Playback frame rate. A bake input (drives `frame_count` via `recompute_frame_count`) —
    /// editing it sets `cache_stale`.
    pub fps: u32,
    /// How many dense frames to bake (`FrameCache` clamps to its VRAM budget/cap). Derived from
    /// `fps * loop_seconds`, clamped to `anim::max_loop_frames`'s cap — see
    /// `recompute_frame_count`. Not edited directly by the UI anymore.
    pub frame_count: u32,
    /// Whether cached-frame playback interpolates between the two nearest baked frames (`true`)
    /// or snaps to the nearest one (`false`, default). Playback-only — never invalidates the
    /// bake, so toggling it does NOT set `cache_stale`.
    pub interp: bool,
    /// True whenever the baked cache no longer matches the current bake inputs (layers /
    /// resolution / seed / evolutions / fps / loop_seconds). Set by `mark_dirty` (covers layers,
    /// res, seed) and by the evolutions/fps/loop_seconds controls; cleared once a bake is issued
    /// while playing. Starts `true` (nothing baked yet).
    pub cache_stale: bool,
    /// `self.playing` as of the previous frame. Compared each frame to edge-detect a play→pause
    /// transition (pause snap: force one full-res live regen at `self.phase`, see `ui()`'s tail).
    was_playing: bool,

    // --- timeline (keyframe animation, Task 2 wiring) ---
    /// Keyframe tracks keyed by `LayerDesc::id`. Empty until Task 4 adds keyframe-editing UI;
    /// `evaluate_scene_at`/`sync_playhead` are no-ops against an empty timeline.
    pub timeline: Timeline,
    /// Next id to stamp onto a newly added/duplicated layer (`ui_logic::add_layer`/
    /// `duplicate_layer`). Only ever increases — ids are never reused, so a deleted layer's
    /// timeline tracks can't collide with a later layer.
    next_layer_id: u64,
}

impl Default for Vol3dApp {
    fn default() -> Self {
        let mut layers = layer::demo_scene();
        for (i, l) in layers.iter_mut().enumerate() {
            l.id = i as u64;
        }
        let next_layer_id = layers.len() as u64;
        let last_layers_len = layers.len();
        Self {
            layers,
            selected: 0,
            resolution: 128,
            global_seed: 0.0,
            dirty: true,
            last_edit_time: 0.0,
            pending_regen: false,
            cam: OrbitCamera::default(),
            selected_stop: None,
            last_props_layer: 0,
            last_layers_len,
            frame_ms_ema: 0.0,
            theme: Theme::default(),
            playing: false,
            phase: 0.0,
            loop_seconds: 4.0,
            evolutions: 0.0,
            fps: 30,
            frame_count: 24,
            interp: false,
            cache_stale: true,
            was_playing: false,
            timeline: Timeline::default(),
            next_layer_id,
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
        let mut app = Self::default();
        app.recompute_frame_count();
        crate::theme::apply(&cc.egui_ctx, app.theme);
        app
    }

    /// Derives `frame_count` from `fps * loop_seconds`, clamped to `anim::max_loop_frames`'s
    /// VRAM-budget cap (so the UI's requested N never exceeds what `FrameCache` could actually
    /// bake). Called whenever `fps` or `loop_seconds` changes.
    fn recompute_frame_count(&mut self) {
        let cap =
            anim::max_loop_frames(crate::render::frame_cache::FRAME_CACHE_BUDGET_BYTES) as f32;
        let n = (self.fps as f32 * self.loop_seconds).round();
        self.frame_count = n.clamp(1.0, cap) as u32;
    }

    /// Any edit routes through here: marks the scene dirty and stamps the edit time the
    /// debounce (`ui_logic::should_regen`) measures against.
    fn mark_dirty(&mut self, ctx: &egui::Context) {
        self.dirty = true;
        self.last_edit_time = ctx.input(|i| i.time);
        // Every layer/resolution/seed edit routes through here, so this one line invalidates the
        // dense playback cache for all of them (evolutions/frame_count set it at their controls).
        self.cache_stale = true;
    }

    /// Pack the *visible* layers of `layers` into GPU form: `Vec<GpuLayer>` + the `256xN` ramp
    /// LUT atlas. Invisible layers are dropped from both the layer list and the ramp atlas (same
    /// filter, same order) before packing — they contribute neither shape nor color, and
    /// `shaders/generate.wgsl` indexes the ramp atlas row-by-row against the layer's position in
    /// the (filtered) list, so the two must stay in lockstep. Takes an explicit `layers` slice
    /// (rather than always reading `self.layers`) so the per-frame bake path (Task 3) can pack an
    /// `evaluate_scene_at` snapshot without mutating `self`.
    fn pack_scene(&self, layers: &[LayerDesc]) -> (Vec<layer::GpuLayer>, Vec<u8>, u32) {
        let mut packed: Vec<layer::GpuLayer> = layers
            .iter()
            .filter(|l| l.visible)
            .map(layer::pack_layer)
            .collect();
        for g in packed.iter_mut() {
            g.seed += self.global_seed; // v2: u_seed = layer.seed + globalSeed
        }

        let ramps: Vec<ColorRamp> = layers
            .iter()
            .filter(|l| l.visible)
            .map(|l| l.ramp.clone())
            .collect();
        let lut_atlas = ramp::build_ramp_lut_atlas(&ramps, LUT_WIDTH);
        let lut_rows = ramps.len() as u32;

        (packed, lut_atlas, lut_rows)
    }

    /// Pack the live `self.layers` into GPU form (see `pack_scene`) plus `GenParams`.
    fn pack_for_gpu(&self) -> (Vec<layer::GpuLayer>, Vec<u8>, u32, GenParams) {
        let (packed, lut_atlas, lut_rows) = self.pack_scene(&self.layers);

        let gen_params = GenParams {
            res: self.resolution,
            layer_count: packed.len() as u32,
            // The live volume's phase. Only matters when playback has just stopped (pause snap,
            // see `ui()`'s tail): the paused full-res frame should match where playback stopped,
            // not always frame 0. Harmless elsewhere — a live regen from ordinary edits shows
            // whatever `self.phase` currently is (0.0 until the user has ever played/scrubbed).
            anim_phase: self.phase,
            anim_evolutions: self.evolutions,
        };

        (packed, lut_atlas, lut_rows, gen_params)
    }

    /// Clone `self.layers` and apply every timeline track at `phase`, without mutating the app's
    /// actual layer state. Used where a caller wants "what would the scene look like at this
    /// phase" without committing to it — the per-frame bake path (`ui()`'s `need_bake` branch)
    /// calls this once per baked frame; `sync_playhead` is the mutating counterpart that also
    /// updates `self.phase` and the live sliders.
    fn evaluate_scene_at(&self, phase: f32) -> Vec<LayerDesc> {
        let mut ls = self.layers.clone();
        self.timeline.evaluate_into(&mut ls, phase);
        ls
    }

    /// Move the playhead to `phase` and re-evaluate every timeline track onto `self.layers` in
    /// place, so the Properties panel's sliders reflect the animated values at the new phase
    /// (not just whatever was last authored). A no-op write against an empty timeline.
    fn sync_playhead(&mut self, phase: f32) {
        self.phase = phase;
        self.timeline.evaluate_into(&mut self.layers, phase);
    }

    fn layers_panel(&mut self, ui: &mut egui::Ui) {
        ui.label("Layers");

        egui::ScrollArea::vertical().show(ui, |ui| {
            for i in 0..self.layers.len() {
                ui.horizontal(|ui| {
                    let visible = self.layers[i].visible;
                    let eye_glyph = if visible { "👁" } else { "🚫" };
                    if ui.selectable_label(visible, eye_glyph).clicked() {
                        self.layers[i].visible = !visible;
                        self.mark_dirty(ui.ctx());
                    }

                    let label =
                        format!("{}: {}", i + 1, noise_type_label(self.layers[i].noise_type));
                    if ui.selectable_label(self.selected == i, label).clicked() {
                        self.selected = i;
                    }

                    let prev_blend = self.layers[i].blend_mode;
                    egui::ComboBox::from_id_salt(("layer-blend", i))
                        .selected_text(blend_label(self.layers[i].blend_mode))
                        .show_ui(ui, |ui| {
                            for b in BLEND_MODES {
                                ui.selectable_value(
                                    &mut self.layers[i].blend_mode,
                                    b,
                                    blend_label(b),
                                );
                            }
                        });
                    if self.layers[i].blend_mode != prev_blend {
                        self.mark_dirty(ui.ctx());
                    }
                });
            }
        });

        ui.horizontal(|ui| {
            if ui.button("Add").clicked() {
                self.selected = add_layer(&mut self.layers, self.selected, &mut self.next_layer_id);
                self.mark_dirty(ui.ctx());
            }
            if ui.button("Duplicate").clicked() {
                self.selected =
                    duplicate_layer(&mut self.layers, self.selected, &mut self.next_layer_id);
                self.mark_dirty(ui.ctx());
            }
            let danger = self.theme.palette().danger;
            if ui
                .button(egui::RichText::new("Delete").color(danger))
                .clicked()
            {
                let removed_id = self.layers[self.selected].id;
                self.selected = delete_layer(&mut self.layers, self.selected);
                self.timeline.remove_layer(removed_id);
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
        if i != self.last_props_layer || self.layers.len() != self.last_layers_len {
            self.selected_stop = None;
            self.last_props_layer = i;
            self.last_layers_len = self.layers.len();
        }
        ui.separator();

        // Blend mode + opacity are per-layer composite controls that don't belong to any one
        // group below, so they get a small header row instead of their own CollapsingHeader.
        ui.horizontal(|ui| {
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
        });

        egui::CollapsingHeader::new("Noise")
            .default_open(true)
            .show(ui, |ui| {
                egui::Grid::new("grid-noise").num_columns(2).show(ui, |ui| {
                    let prev_nt = self.layers[i].noise_type;
                    ui.label("Type");
                    egui::ComboBox::from_id_salt("noise-type-combo")
                        .selected_text(noise_type_label(self.layers[i].noise_type))
                        .show_ui(ui, |ui| {
                            for t in NOISE_TYPES {
                                ui.selectable_value(
                                    &mut self.layers[i].noise_type,
                                    t,
                                    noise_type_label(t),
                                );
                            }
                        });
                    if self.layers[i].noise_type != prev_nt {
                        self.mark_dirty(ui.ctx());
                    }
                    ui.end_row();

                    ui.label("Amplitude");
                    if ui
                        .add(egui::DragValue::new(&mut self.layers[i].amplitude).speed(0.01))
                        .changed()
                    {
                        self.mark_dirty(ui.ctx());
                    }
                    ui.end_row();

                    ui.label("Invert");
                    if ui.checkbox(&mut self.layers[i].invert, "").changed() {
                        self.mark_dirty(ui.ctx());
                    }
                    ui.end_row();

                    if self.layers[i].noise_type == NoiseType::Worley {
                        ui.label("Worley Mode");
                        let prev_mode = self.layers[i].worley_mode;
                        egui::ComboBox::from_id_salt("worley-mode-combo")
                            .selected_text(worley_mode_label(self.layers[i].worley_mode))
                            .show_ui(ui, |ui| {
                                for m in WORLEY_MODES {
                                    ui.selectable_value(
                                        &mut self.layers[i].worley_mode,
                                        m,
                                        worley_mode_label(m),
                                    );
                                }
                            });
                        if self.layers[i].worley_mode != prev_mode {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();
                    }

                    if self.layers[i].noise_type == NoiseType::Fbm {
                        ui.label("Octaves");
                        if ui
                            .add(egui::DragValue::new(&mut self.layers[i].octaves).range(1..=8))
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        ui.label("Persistence");
                        if ui
                            .add(egui::DragValue::new(&mut self.layers[i].persistence).speed(0.01))
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        ui.label("Lacunarity");
                        if ui
                            .add(egui::DragValue::new(&mut self.layers[i].lacunarity).speed(0.01))
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        ui.label("FBM base");
                        let prev_base = self.layers[i].fbm_base;
                        egui::ComboBox::from_id_salt("fbm-base-combo")
                            .selected_text(noise_type_label(self.layers[i].fbm_base))
                            .show_ui(ui, |ui| {
                                for t in NOISE_TYPES {
                                    // fbm never recurses into itself or an sdf shape
                                    // (see eval_base_noise in generate.wgsl).
                                    if t != NoiseType::Fbm && !t.is_sdf() {
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
                        ui.end_row();
                    }

                    if self.layers[i].noise_type.is_sdf() {
                        ui.label("Radius");
                        if ui
                            .add(egui::DragValue::new(&mut self.layers[i].sdf_radius).speed(0.01))
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        ui.label("Softness");
                        if ui
                            .add(egui::DragValue::new(&mut self.layers[i].sdf_softness).speed(0.01))
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        // Height only affects capsule/cylinder/plume (generate.wgsl
                        // sdf_capsule/sdf_cylinder/sdf_plume); sphere/box/cone derive
                        // their extent from radius alone (v2 sdfField.ts parity).
                        if matches!(
                            self.layers[i].noise_type,
                            NoiseType::SdfCapsule | NoiseType::SdfCylinder | NoiseType::SdfPlume
                        ) {
                            ui.label("Height");
                            if ui
                                .add(
                                    egui::DragValue::new(&mut self.layers[i].sdf_height)
                                        .speed(0.01),
                                )
                                .changed()
                            {
                                self.mark_dirty(ui.ctx());
                            }
                            ui.end_row();
                        }
                    }
                });
            });

        egui::CollapsingHeader::new("Transform")
            .default_open(true)
            .show(ui, |ui| {
                egui::Grid::new("grid-transform")
                    .num_columns(2)
                    .show(ui, |ui| {
                        ui.label("Scale");
                        ui.horizontal(|ui| {
                            for axis in 0..3 {
                                if ui
                                    .add(
                                        egui::DragValue::new(&mut self.layers[i].scale[axis])
                                            .speed(0.01),
                                    )
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                        });
                        ui.end_row();

                        ui.label("Rotation (deg)");
                        ui.horizontal(|ui| {
                            for axis in 0..3 {
                                if ui
                                    .add(
                                        egui::DragValue::new(
                                            &mut self.layers[i].rotation_deg[axis],
                                        )
                                        .speed(1.0),
                                    )
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                        });
                        ui.end_row();

                        ui.label("Offset");
                        ui.horizontal(|ui| {
                            for axis in 0..3 {
                                if ui
                                    .add(
                                        egui::DragValue::new(&mut self.layers[i].offset[axis])
                                            .speed(0.01),
                                    )
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                        });
                        ui.end_row();
                    });
            });

        egui::CollapsingHeader::new("Distortion")
            .default_open(false)
            .show(ui, |ui| {
                egui::Grid::new("grid-distortion")
                    .num_columns(2)
                    .show(ui, |ui| {
                        let prev_dt = self.layers[i].distortion_type;
                        ui.label("Type");
                        egui::ComboBox::from_id_salt("distortion-type-combo")
                            .selected_text(distortion_type_label(self.layers[i].distortion_type))
                            .show_ui(ui, |ui| {
                                for t in DISTORTION_TYPES {
                                    ui.selectable_value(
                                        &mut self.layers[i].distortion_type,
                                        t,
                                        distortion_type_label(t),
                                    );
                                }
                            });
                        if self.layers[i].distortion_type != prev_dt {
                            self.mark_dirty(ui.ctx());
                        }
                        ui.end_row();

                        if self.layers[i].distortion_type != DistortionType::None {
                            ui.label("Strength");
                            if ui
                                .add(egui::Slider::new(
                                    &mut self.layers[i].distortion_strength,
                                    0.0..=2.0,
                                ))
                                .changed()
                            {
                                self.mark_dirty(ui.ctx());
                            }
                            ui.end_row();

                            if matches!(
                                self.layers[i].distortion_type,
                                DistortionType::DomainWarp | DistortionType::Turbulence
                            ) {
                                ui.label("Warp Freq");
                                if ui
                                    .add(egui::Slider::new(
                                        &mut self.layers[i].distortion_frequency,
                                        0.5..=10.0,
                                    ))
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                                ui.end_row();
                            }

                            if self.layers[i].distortion_type == DistortionType::Swirl {
                                ui.label("Swirl Amt");
                                if ui
                                    .add(egui::Slider::new(
                                        &mut self.layers[i].distortion_swirl,
                                        -5.0..=5.0,
                                    ))
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                                ui.end_row();
                            }

                            if matches!(
                                self.layers[i].distortion_type,
                                DistortionType::DomainWarp
                                    | DistortionType::Curl
                                    | DistortionType::Turbulence
                            ) {
                                ui.label("Warp Noise");
                                let prev_warp_noise = self.layers[i].warp_noise;
                                egui::ComboBox::from_id_salt("warp-noise-combo")
                                    .selected_text(noise_type_label(self.layers[i].warp_noise))
                                    .show_ui(ui, |ui| {
                                        for t in NOISE_TYPES {
                                            if !t.is_sdf() && t != NoiseType::Fbm {
                                                ui.selectable_value(
                                                    &mut self.layers[i].warp_noise,
                                                    t,
                                                    noise_type_label(t),
                                                );
                                            }
                                        }
                                    });
                                if self.layers[i].warp_noise != prev_warp_noise {
                                    self.mark_dirty(ui.ctx());
                                }
                                ui.end_row();
                            }

                            if self.layers[i].distortion_type == DistortionType::Turbulence {
                                ui.label("Octaves");
                                if ui
                                    .add(
                                        egui::DragValue::new(
                                            &mut self.layers[i].distortion_octaves,
                                        )
                                        .range(1..=8),
                                    )
                                    .changed()
                                {
                                    self.mark_dirty(ui.ctx());
                                }
                                ui.end_row();
                            }

                            ui.label("Distortion Rot (deg)");
                            ui.horizontal(|ui| {
                                for axis in 0..3 {
                                    if ui
                                        .add(
                                            egui::DragValue::new(
                                                &mut self.layers[i].distortion_rotation[axis],
                                            )
                                            .speed(1.0)
                                            .range(-180.0..=180.0),
                                        )
                                        .changed()
                                    {
                                        self.mark_dirty(ui.ctx());
                                    }
                                }
                            });
                            ui.end_row();
                        }
                    });
            });

        egui::CollapsingHeader::new("Remap")
            .default_open(true)
            .show(ui, |ui| {
                egui::Grid::new("grid-remap").num_columns(2).show(ui, |ui| {
                    ui.label("In range");
                    ui.horizontal(|ui| {
                        if ui
                            .add(
                                egui::DragValue::new(&mut self.layers[i].in_min)
                                    .prefix("min: ")
                                    .speed(0.01),
                            )
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        if ui
                            .add(
                                egui::DragValue::new(&mut self.layers[i].in_max)
                                    .prefix("max: ")
                                    .speed(0.01),
                            )
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                    });
                    ui.end_row();

                    ui.label("Out range");
                    ui.horizontal(|ui| {
                        if ui
                            .add(
                                egui::DragValue::new(&mut self.layers[i].out_min)
                                    .prefix("min: ")
                                    .speed(0.01),
                            )
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                        if ui
                            .add(
                                egui::DragValue::new(&mut self.layers[i].out_max)
                                    .prefix("max: ")
                                    .speed(0.01),
                            )
                            .changed()
                        {
                            self.mark_dirty(ui.ctx());
                        }
                    });
                    ui.end_row();
                });
            });

        egui::CollapsingHeader::new("Color")
            .default_open(true)
            .show(ui, |ui| {
                if gradient_editor(ui, &mut self.layers[i].ramp, &mut self.selected_stop).changed()
                {
                    self.mark_dirty(ui.ctx());
                }
            });
    }

    /// Bottom strip: playback controls (Task 4). Plain/unstyled — styling is parked pending
    /// designer mockups. `fps`, `loop_seconds`, and `evolutions` are bake inputs (editing them
    /// sets `cache_stale` and, for `fps`/`loop_seconds`, recomputes the derived `frame_count`);
    /// `interp` is playback-only and never invalidates the bake.
    fn animation_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let play_label = if self.playing {
                "⏸ Pause"
            } else {
                "▶ Play"
            };
            if ui.selectable_label(self.playing, play_label).clicked() {
                self.playing = !self.playing;
            }
            ui.separator();

            ui.label("Loop (s)");
            if ui
                .add(
                    egui::DragValue::new(&mut self.loop_seconds)
                        .speed(0.1)
                        .range(0.1..=60.0),
                )
                .changed()
            {
                self.recompute_frame_count();
                self.cache_stale = true;
            }

            ui.label("Evolutions");
            if ui
                .add(
                    egui::DragValue::new(&mut self.evolutions)
                        .speed(0.1)
                        .range(0.0..=64.0),
                )
                .changed()
            {
                self.cache_stale = true;
            }

            ui.label("FPS");
            if ui
                .add(egui::DragValue::new(&mut self.fps).range(1..=120))
                .changed()
            {
                self.recompute_frame_count();
                self.cache_stale = true;
            }

            ui.checkbox(&mut self.interp, "Interpolate");
            ui.separator();

            ui.label("Phase");
            if ui
                .add(egui::Slider::new(&mut self.phase, 0.0..=1.0))
                .changed()
            {
                // Scrubbing moves the playhead: re-evaluate every timeline track onto `self.layers`
                // at the new phase (so the Properties sliders track it) and regen the live volume.
                self.sync_playhead(self.phase);
                self.mark_dirty(ui.ctx());
            }
            ui.separator();

            // Glance readout: `frame_count` is the *derived* (fps*loop, clamped) bake input, so
            // no live renderer access is needed here — `playback_bake_res` is the same pure
            // reduction `FrameCache::bake` applies, so this predicts its resolution exactly.
            let status = if self.cache_stale {
                "cache: stale".to_string()
            } else {
                let bake_res = anim::playback_bake_res(
                    self.resolution,
                    self.frame_count,
                    crate::render::frame_cache::FRAME_CACHE_BUDGET_BYTES,
                );
                let gb =
                    self.frame_count as f64 * (bake_res as f64).powi(3) * 4.0 / (1u64 << 30) as f64;
                let eff_fps = self.frame_count as f32 / self.loop_seconds.max(1e-3);
                format!(
                    "baked {} @ {}³  ({:.1} GB)  {:.0} fps  {}",
                    self.frame_count,
                    bake_res,
                    gb,
                    eff_fps,
                    if self.interp { "smooth" } else { "steps" }
                )
            };
            ui.label(status);
        });
    }
}

impl eframe::App for Vol3dApp {
    // eframe 0.35.0 (installed): `App::ui` replaces the older `update(&Context, ...)`
    // shape and hands us the root `&mut Ui` directly; panels are shown via
    // `.show(ui, ...)` rather than `.show(ctx, ...)`.
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Smoothed frame time for the fps/ms readout (the top bar's right-aligned label). Requesting a
        // repaint every frame (unconditionally, independent of the debounced regen below) keeps
        // the raymarch/present loop running continuously so the reading reflects steady-state
        // render cost — it does NOT trigger generation, which still only fires on `pending_regen`.
        let dt = ui.ctx().input(|i| i.stable_dt).max(1e-4);
        self.frame_ms_ema = if self.frame_ms_ema <= 0.0 {
            dt * 1000.0
        } else {
            self.frame_ms_ema * 0.9 + dt * 1000.0 * 0.1
        };
        ui.ctx().request_repaint();

        // Top bar: title, resolution + seed (moved out of `layers_panel`), theme toggle, and the
        // fps/ms readout (label only — the EMA above is what actually computes it). Sits inside
        // the root `Ui` like the side/central panels below. `TopBottomPanel` doesn't exist in
        // installed egui 0.35 — like `SidePanel`, it was unified into `egui::Panel` (+
        // `PanelSide`); `Panel::top`/`.exact_size` (not `.exact_height`, which doesn't exist
        // either — `Panel`'s one size knob is width-or-height depending on `PanelSide`) plus the
        // same `.show(ui, ..)` the left/right panels below already use.
        egui::Panel::top("topbar").exact_size(48.0).show(ui, |ui| {
            ui.horizontal_centered(|ui| {
                ui.heading("Vol3D");
                ui.separator();

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

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let toggle_label = match self.theme {
                        Theme::Dark => "☀",
                        Theme::Light => "🌙",
                    };
                    if ui.button(toggle_label).clicked() {
                        self.theme = match self.theme {
                            Theme::Dark => Theme::Light,
                            Theme::Light => Theme::Dark,
                        };
                        crate::theme::apply(ui.ctx(), self.theme);
                    }
                    ui.label(format!(
                        "{:.1} ms  ({:.0} fps)",
                        self.frame_ms_ema,
                        1000.0 / self.frame_ms_ema.max(1e-3)
                    ));
                });
            });
        });

        // Bottom playback strip. Shown after the top bar (both span full width) and before the
        // side panels, which then fill the strip between them (standard egui panel ordering).
        egui::Panel::bottom("animation").show(ui, |ui| self.animation_panel(ui));

        // Phase clock: advance the loop position while playing. Continuous repaint is already on
        // (the fps counter above requests one unconditionally), so no extra repaint needed here.
        if self.playing {
            let dt = ui.ctx().input(|i| i.stable_dt);
            self.phase = anim::advance_phase(self.phase, dt, self.loop_seconds);
            // Keep the visible sliders tracking playback: re-evaluate every timeline track onto
            // `self.layers` at the new phase. Skipped when there are no tracks at all, so an
            // untimelined scene (the common case today) doesn't pay a needless per-frame pass.
            if !self.timeline.is_empty() {
                self.timeline.evaluate_into(&mut self.layers, self.phase);
            }
        }

        // Pause snap: the instant playback stops (edge-triggered on `was_playing`, so this fires
        // exactly once per pause), force one full-res live regen at the phase we stopped on —
        // bypassing the edit debounce, since this isn't an edit, it's a resolution snap from the
        // (possibly reduced) bake_res cache back to full res. `pack_for_gpu`'s `anim_phase` is
        // `self.phase` (above), so the regen lands on the right frame. Deliberately does NOT call
        // `mark_dirty`/touch `cache_stale`: the bake is still valid, only the live volume (what's
        // shown once paused) needs refreshing, and invalidating the cache here would force a
        // needless rebake next Play (breaking the cycle-4 single-fire bake guard's intent).
        if self.was_playing && !self.playing {
            self.pending_regen = true;
        }
        self.was_playing = self.playing;

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
            // `cam.macro_dim` is left 0.0 here; `RaymarchCallback::prepare` sets it from the
            // BOUND volume's actual res (not `self.resolution`, which may be mid-debounce).
            let cam = self.cam.basis(aspect, 128.0);

            // Bake the dense cache when playing with a stale cache (Play press, or re-bake after
            // an edit while playing). `ensure_baked`'s `is_stale` is the real single-fire guard;
            // this CPU-side `cache_stale` flag just avoids re-packing/re-hashing every frame once
            // the cache is fresh.
            let need_bake = self.playing && self.cache_stale && self.frame_count > 0;
            // Sample the cached (reduced-res, `FrameCache::bake_res`) frame only while actually
            // playing. The moment playback stops, this drops to `false` — the pause-snap regen
            // above (`was_playing`/`pending_regen`) re-renders the live volume at full res and
            // this leaves the raymarch bound to it (no `bind_playback` override), so a paused
            // frame is always full-res, never the bake's reduced resolution (cycle-5 contract).
            let use_cache = self.playing && self.frame_count > 0;

            let empty_params = GenParams {
                res: self.resolution,
                layer_count: 0,
                anim_phase: 0.0,
                anim_evolutions: self.evolutions,
            };
            let (layers, bake_frames, lut_atlas, lut_rows, gen_params, bake_key, pending_regen) =
                if need_bake {
                    // Bake each cached frame from the timeline-evaluated scene at that frame's
                    // phase, not just the live (unanimated) layer stack — this is what actually
                    // makes playback show the keyframed animation. The LUT/ramp atlas stays a
                    // single static pack of `self.layers`: SP1 doesn't animate colors, only
                    // `ParamField` numerics, so every frame's ramp is identical.
                    let n = self.frame_count;
                    let (_, lut, rows) = self.pack_scene(&self.layers);
                    let frames: Vec<Vec<layer::GpuLayer>> = (0..n)
                        .map(|i| {
                            self.pack_scene(&self.evaluate_scene_at(i as f32 / n as f32))
                                .0
                        })
                        .collect();
                    let gp = GenParams {
                        res: self.resolution,
                        layer_count: frames[0].len() as u32,
                        anim_phase: 0.0, // bake sets per-frame phase in FrameCache::bake
                        anim_evolutions: self.evolutions,
                    };
                    // Frame 0's packed layers stand in for the whole bake in the key (matching
                    // `pack_for_gpu`'s single-snapshot fingerprint elsewhere); `timeline_hash`
                    // covers edits to keyframes elsewhere in the loop that frame 0 alone can't see.
                    let key = anim::BakeKey::new(
                        &frames[0],
                        self.resolution,
                        self.evolutions,
                        n,
                        self.timeline.hash(),
                    );
                    self.cache_stale = false;
                    (Vec::new(), frames, lut, rows, gp, Some(key), false)
                } else if !self.playing && self.pending_regen {
                    // Live regen path — fires from the debounced edit path (unchanged) AND from the
                    // pause snap above (`pending_regen` armed directly, no debounce, at `self.phase`).
                    // While playing we skip it (the cache is what's shown); a debounce that fires
                    // mid-playback is dropped and re-armed on the next edit-while-paused, which never
                    // displays a stale live volume in practice.
                    let (packed, lut, rows, gp) = self.pack_for_gpu();
                    (packed, Vec::new(), lut, rows, gp, None, true)
                } else {
                    (
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        0,
                        empty_params,
                        None,
                        false,
                    )
                };
            self.pending_regen = false;

            let cb = RaymarchCallback {
                cam,
                res: self.resolution,
                layers,
                gen_params,
                lut_atlas,
                lut_rows,
                pending_regen,
                bake_key,
                bake_frames,
                playback_phase: if use_cache { Some(self.phase) } else { None },
                interp: self.interp,
            };
            ui.painter()
                .add(egui_wgpu::Callback::new_paint_callback(rect, cb));
        });
    }
}
