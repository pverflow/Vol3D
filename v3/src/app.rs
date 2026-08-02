use crate::anim;
use crate::anim_timeline::Timeline;
use crate::camera::OrbitCamera;
use crate::gradient::gradient_editor;
use crate::layer::{self, BlendMode, DistortionType, GenParams, LayerDesc, NoiseType, ParamField};
use crate::persistence;
use crate::ramp::{self, ColorRamp};
use crate::render::raymarch::RaymarchCallback;
use crate::theme::Theme;
use crate::ui_logic::{
    add_layer, delete_layer, duplicate_layer, move_down, move_up, regen_dispatches, should_regen,
};

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

/// Per-axis box dimension choices offered by the top bar's X/Y/Z selectors (power-of-2, 32-512).
const DIM_CHOICES: [u32; 5] = [32, 64, 128, 256, 512];

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

/// Draws a stopwatch ◆/◇ toggle before a scalar widget, wiring it to `tl`'s keyframe track for
/// `(id, field)`. A free fn (not a method) so callers can hold `&mut self.timeline` and
/// `&mut self.layers[i].<field>` (via a local copy) at once without aliasing `self` — see the
/// call sites in `properties_panel`. Returns `true` if a regen is needed (toggle or value edit),
/// so callers route the result through `self.mark_dirty(ui.ctx())`.
fn anim_param(
    ui: &mut egui::Ui,
    tl: &mut Timeline,
    playhead: f32,
    id: u64,
    field: ParamField,
    value: &mut f32,
    widget: impl FnOnce(&mut egui::Ui, &mut f32) -> egui::Response,
) -> bool {
    let mut need = false;
    let animated = tl.is_animated(id, field);
    if ui
        .small_button(if animated { "◆" } else { "◇" })
        .on_hover_text("keyframe")
        .clicked()
    {
        if animated {
            tl.remove(id, field);
        } else {
            tl.upsert(id, field, playhead, *value);
        }
        need = true;
    }
    if animated {
        ui.weak(format!("{}", tl.track_len(id, field)));
    }
    if widget(ui, value).changed() {
        if tl.is_animated(id, field) {
            tl.upsert(id, field, playhead, *value);
        }
        need = true;
    }
    need
}

pub struct Vol3dApp {
    /// The authored layer stack (starts from `layer::demo_scene()` so the app opens non-empty).
    pub layers: Vec<LayerDesc>,
    /// Index into `layers` the Properties panel edits. `ui_logic`'s ops keep this in
    /// `[0, layers.len())` (layers is never emptied — `delete_layer` refuses at `len == 1`).
    pub selected: usize,
    /// Per-axis volume dims (32 / 64 / 128 / 256 / 512 each), picked via the top bar's X/Y/Z
    /// selectors. Defaults to `[128,128,128]` — today's cubic 128, unchanged until the user picks
    /// non-cubic values.
    pub dims: [u32; 3],
    /// Snapshot of `dims` taken the instant a regen (bake or live) actually dispatches
    /// (`ui_logic::regen_dispatches`) — i.e. the shape the bound volume is becoming, not `dims`
    /// itself, which a UI edit can update immediately, ~120ms ahead of the debounced regen that
    /// actually rebuilds the box. The camera's `box_aspect` derives from this, not `dims`, so a
    /// dims change reframes the camera in the same frame the box itself changes shape — no pop.
    pub committed_dims: [u32; 3],
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
    /// Global HDR exposure multiplier (Task 3 of the hdr-color cycle): scales the raymarch's
    /// accumulated linear color before the ACES tonemap. `1.0` = unity gain — a render param the
    /// shader reads live every frame (continuous repaint already covers it), not a bake input, so
    /// editing it doesn't touch `cache_stale`/`mark_dirty`.
    pub exposure: f32,

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
    /// dims / seed / evolutions / fps / loop_seconds). Set by `mark_dirty` (covers layers,
    /// dims, seed) and by the evolutions/fps/loop_seconds controls; cleared once a bake is issued
    /// while playing. Starts `true` (nothing baked yet).
    pub cache_stale: bool,
    /// `self.playing` as of the previous frame. Compared each frame to edge-detect a play→pause
    /// transition (pause snap: force one full-res live regen at `self.phase`, see `ui()`'s tail).
    was_playing: bool,

    /// Smoothed (EMA, 0.18 per frame) 0..1 "is the viewport hovered" signal driving the
    /// bounding-box wireframe's steady-state opacity (see `ui()`'s central-panel cam build).
    wire_hover: f32,
    /// `ctx.input(|i| i.time)` at the most recent box-dims change; feeds `anim::flash_envelope`
    /// to flash-and-fade the wireframe on resize. Init `-1e9` so `flash_envelope` reads a huge
    /// negative elapsed on the very first frame (before any dims edit) and returns `0.0`, not a
    /// bogus flash.
    wire_flash_start: f64,

    // --- timeline (keyframe animation, Task 2 wiring) ---
    /// Keyframe tracks keyed by `LayerDesc::id`. Empty until Task 4 adds keyframe-editing UI;
    /// `evaluate_scene_at`/`sync_playhead` are no-ops against an empty timeline.
    pub timeline: Timeline,
    /// Next id to stamp onto a newly added/duplicated layer (`ui_logic::add_layer`/
    /// `duplicate_layer`). Only ever increases — ids are never reused, so a deleted layer's
    /// timeline tracks can't collide with a later layer.
    next_layer_id: u64,
    /// The keyframe dot the timeline panel highlights, keyed the same way a `Track` is
    /// (`layer_id`, field, phase) — a phase rather than an index since `Track::keys` has no
    /// stable index across inserts/removes. `None` = nothing selected. Painted only this task
    /// (Task 2); Task 3 wires click-to-select / drag-retime / delete against it.
    pub selected_key: Option<(u64, layer::ParamField, f32)>,
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
            dims: [128, 128, 128],
            committed_dims: [128, 128, 128],
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
            exposure: 1.0,
            playing: false,
            phase: 0.0,
            loop_seconds: 4.0,
            evolutions: 0.0,
            fps: 30,
            frame_count: 24,
            interp: false,
            cache_stale: true,
            was_playing: false,
            wire_hover: 0.0,
            wire_flash_start: -1e9,
            timeline: Timeline::default(),
            next_layer_id,
            selected_key: None,
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
        // Auto-load whatever scene was last saved as default; a missing/corrupt save (`None`)
        // just leaves the demo scene from `Self::default()` in place — no panic, no blank scene.
        if let Some(s) = Self::load_default_scene() {
            app.apply_scene(s);
        }
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
        // Every layer/dims/seed edit routes through here, so this one line invalidates the
        // dense playback cache for all of them (evolutions/frame_count set it at their controls).
        self.cache_stale = true;
    }

    /// Snapshot everything `SceneFile` persists out of the live `self` — the inverse of
    /// `apply_scene`. `self.timeline.to_entries()` borrows `&self.timeline` and returns owned
    /// data before the struct literal below touches any other `self` field, so there's no
    /// borrow conflict despite reading most of `self` in one expression.
    fn to_scene(&self) -> persistence::SceneFile {
        persistence::SceneFile {
            version: 1,
            layers: self.layers.clone(),
            next_layer_id: self.next_layer_id,
            dims: self.dims,
            global_seed: self.global_seed,
            loop_seconds: self.loop_seconds,
            evolutions: self.evolutions,
            fps: self.fps,
            interp: self.interp,
            tracks: self.timeline.to_entries(),
            camera: persistence::CamState {
                yaw: self.cam.yaw,
                pitch: self.cam.pitch,
                distance: self.cam.distance,
            },
            exposure: self.exposure,
        }
    }

    /// Overwrite the live scene with `s` — the inverse of `to_scene`. Refuses an empty-layers
    /// scene (guards against a corrupt/hand-edited save nuking the demo down to nothing); forces
    /// a regen + rebake afterward since every bake input just changed under the renderer.
    fn apply_scene(&mut self, s: persistence::SceneFile) {
        if s.layers.is_empty() {
            return;
        }
        let max_existing_id = s.layers.iter().map(|l| l.id + 1).max().unwrap_or(0);
        self.layers = s.layers;
        // Every other layers-mutating path (add/duplicate/delete) clamps `selected` into range;
        // a swapped-in scene can be shorter than whatever was selected before, so this must too
        // (else the next `self.layers[self.selected]` — e.g. Delete — panics out of bounds).
        self.selected = self.selected.min(self.layers.len().saturating_sub(1));
        self.dims = s.dims;
        self.global_seed = s.global_seed;
        self.loop_seconds = s.loop_seconds;
        self.evolutions = s.evolutions;
        self.fps = s.fps;
        self.interp = s.interp;
        self.timeline = Timeline::from_entries(s.tracks);
        self.cam.yaw = s.camera.yaw;
        self.cam.pitch = s.camera.pitch;
        self.cam.distance = s.camera.distance;
        self.exposure = s.exposure;
        // Never reuse an id: floor next_layer_id at one past the highest id actually in the
        // loaded layers, in case a hand-edited/older save's `next_layer_id` undershoots it.
        self.next_layer_id = s.next_layer_id.max(max_existing_id);
        self.recompute_frame_count();
        self.cache_stale = true;
        self.dirty = true;
    }

    /// Serialize the current scene and hand it to `persistence::save_scene` (localStorage on
    /// web, `~/.vol3d/scene.json` natively). Silently no-ops on a serialize/write failure — this
    /// is a "save as default" convenience, not a critical path worth surfacing an error for.
    fn save_current_scene(&self) {
        if let Ok(js) = serde_json::to_string(&self.to_scene()) {
            persistence::save_scene(&js);
        }
    }

    /// Load + deserialize whatever scene was last saved as default, if any. `None` covers both
    /// "nothing saved yet" and "saved data is corrupt" — `new` (the only caller) treats both the
    /// same: keep whatever scene `Self::default()` already built.
    fn load_default_scene() -> Option<persistence::SceneFile> {
        let js = persistence::load_scene()?;
        serde_json::from_str(&js).ok()
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

        // `self.dims` is a real per-axis field; `aspect_from_dims` derives the true aspect ratio
        // from it, and `RaymarchCallback::dims` threads it straight through to the live volume
        // texture (no cubic widening) — a non-cubic pick renders as a non-cubic box.
        let dims = self.dims;
        let aspect = anim::aspect_from_dims(dims);
        let gen_params = GenParams {
            dim_x: dims[0],
            dim_y: dims[1],
            dim_z: dims[2],
            layer_count: packed.len() as u32,
            aspect_x: aspect[0],
            aspect_y: aspect[1],
            aspect_z: aspect[2],
            // The live volume's phase. Only matters when playback has just stopped (pause snap,
            // see `ui()`'s tail): the paused full-res frame should match where playback stopped,
            // not always frame 0. Harmless elsewhere — a live regen from ordinary edits shows
            // whatever `self.phase` currently is (0.0 until the user has ever played/scrubbed).
            anim_phase: self.phase,
            anim_evolutions: self.evolutions,
            _pad0: 0.0,
            _pad1: 0.0,
            _pad2: 0.0,
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
                let before = self.layers.len();
                self.selected = delete_layer(&mut self.layers, self.selected);
                if self.layers.len() < before {
                    self.timeline.remove_layer(removed_id);
                }
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

        // `id`/`ph` (both `Copy`) are captured once here so every `anim_param` call site below
        // can pass them alongside `&mut self.timeline` without re-borrowing `self`.
        let id = self.layers[i].id;
        let ph = self.phase;

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
            let mut v = self.layers[i].opacity;
            let need = anim_param(
                ui,
                &mut self.timeline,
                ph,
                id,
                ParamField::Opacity,
                &mut v,
                |ui, v| {
                    ui.add(
                        egui::DragValue::new(v)
                            .prefix("Opacity: ")
                            .speed(0.01)
                            .range(0.0..=1.0),
                    )
                },
            );
            self.layers[i].opacity = v;
            if need {
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
                    {
                        let mut v = self.layers[i].amplitude;
                        let need = anim_param(
                            ui,
                            &mut self.timeline,
                            ph,
                            id,
                            ParamField::Amplitude,
                            &mut v,
                            |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                        );
                        self.layers[i].amplitude = v;
                        if need {
                            self.mark_dirty(ui.ctx());
                        }
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
                        {
                            let mut v = self.layers[i].persistence;
                            let need = anim_param(
                                ui,
                                &mut self.timeline,
                                ph,
                                id,
                                ParamField::Persistence,
                                &mut v,
                                |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                            );
                            self.layers[i].persistence = v;
                            if need {
                                self.mark_dirty(ui.ctx());
                            }
                        }
                        ui.end_row();

                        ui.label("Lacunarity");
                        {
                            let mut v = self.layers[i].lacunarity;
                            let need = anim_param(
                                ui,
                                &mut self.timeline,
                                ph,
                                id,
                                ParamField::Lacunarity,
                                &mut v,
                                |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                            );
                            self.layers[i].lacunarity = v;
                            if need {
                                self.mark_dirty(ui.ctx());
                            }
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
                        {
                            let mut v = self.layers[i].sdf_radius;
                            let need = anim_param(
                                ui,
                                &mut self.timeline,
                                ph,
                                id,
                                ParamField::SdfRadius,
                                &mut v,
                                |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                            );
                            self.layers[i].sdf_radius = v;
                            if need {
                                self.mark_dirty(ui.ctx());
                            }
                        }
                        ui.end_row();

                        ui.label("Softness");
                        {
                            let mut v = self.layers[i].sdf_softness;
                            let need = anim_param(
                                ui,
                                &mut self.timeline,
                                ph,
                                id,
                                ParamField::SdfSoftness,
                                &mut v,
                                |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                            );
                            self.layers[i].sdf_softness = v;
                            if need {
                                self.mark_dirty(ui.ctx());
                            }
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
                            let mut v = self.layers[i].sdf_height;
                            let need = anim_param(
                                ui,
                                &mut self.timeline,
                                ph,
                                id,
                                ParamField::SdfHeight,
                                &mut v,
                                |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                            );
                            self.layers[i].sdf_height = v;
                            if need {
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
                            let fields =
                                [ParamField::ScaleX, ParamField::ScaleY, ParamField::ScaleZ];
                            for (axis, field) in fields.into_iter().enumerate() {
                                let mut v = self.layers[i].scale[axis];
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    field,
                                    &mut v,
                                    |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                                );
                                self.layers[i].scale[axis] = v;
                                if need {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                        });
                        ui.end_row();

                        ui.label("Rotation (deg)");
                        ui.horizontal(|ui| {
                            let fields = [
                                ParamField::RotationX,
                                ParamField::RotationY,
                                ParamField::RotationZ,
                            ];
                            for (axis, field) in fields.into_iter().enumerate() {
                                let mut v = self.layers[i].rotation_deg[axis];
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    field,
                                    &mut v,
                                    |ui, v| ui.add(egui::DragValue::new(v).speed(1.0)),
                                );
                                self.layers[i].rotation_deg[axis] = v;
                                if need {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                        });
                        ui.end_row();

                        ui.label("Offset");
                        ui.horizontal(|ui| {
                            let fields = [
                                ParamField::OffsetX,
                                ParamField::OffsetY,
                                ParamField::OffsetZ,
                            ];
                            for (axis, field) in fields.into_iter().enumerate() {
                                let mut v = self.layers[i].offset[axis];
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    field,
                                    &mut v,
                                    |ui, v| ui.add(egui::DragValue::new(v).speed(0.01)),
                                );
                                self.layers[i].offset[axis] = v;
                                if need {
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
                            {
                                let mut v = self.layers[i].distortion_strength;
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    ParamField::DistortionStrength,
                                    &mut v,
                                    |ui, v| ui.add(egui::Slider::new(v, 0.0..=2.0)),
                                );
                                self.layers[i].distortion_strength = v;
                                if need {
                                    self.mark_dirty(ui.ctx());
                                }
                            }
                            ui.end_row();

                            if matches!(
                                self.layers[i].distortion_type,
                                DistortionType::DomainWarp | DistortionType::Turbulence
                            ) {
                                ui.label("Warp Freq");
                                let mut v = self.layers[i].distortion_frequency;
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    ParamField::DistortionFrequency,
                                    &mut v,
                                    |ui, v| ui.add(egui::Slider::new(v, 0.5..=10.0)),
                                );
                                self.layers[i].distortion_frequency = v;
                                if need {
                                    self.mark_dirty(ui.ctx());
                                }
                                ui.end_row();
                            }

                            if self.layers[i].distortion_type == DistortionType::Swirl {
                                ui.label("Swirl Amt");
                                let mut v = self.layers[i].distortion_swirl;
                                let need = anim_param(
                                    ui,
                                    &mut self.timeline,
                                    ph,
                                    id,
                                    ParamField::DistortionSwirl,
                                    &mut v,
                                    |ui, v| ui.add(egui::Slider::new(v, -5.0..=5.0)),
                                );
                                self.layers[i].distortion_swirl = v;
                                if need {
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
                                let fields = [
                                    ParamField::DistortionRotX,
                                    ParamField::DistortionRotY,
                                    ParamField::DistortionRotZ,
                                ];
                                for (axis, field) in fields.into_iter().enumerate() {
                                    let mut v = self.layers[i].distortion_rotation[axis];
                                    let need = anim_param(
                                        ui,
                                        &mut self.timeline,
                                        ph,
                                        id,
                                        field,
                                        &mut v,
                                        |ui, v| {
                                            ui.add(
                                                egui::DragValue::new(v)
                                                    .speed(1.0)
                                                    .range(-180.0..=180.0),
                                            )
                                        },
                                    );
                                    self.layers[i].distortion_rotation[axis] = v;
                                    if need {
                                        self.mark_dirty(ui.ctx());
                                    }
                                }
                            });
                            ui.end_row();

                            if matches!(
                                self.layers[i].distortion_type,
                                DistortionType::DomainWarp
                                    | DistortionType::Curl
                                    | DistortionType::Turbulence
                            ) {
                                ui.label("Warp Offset");
                                ui.horizontal(|ui| {
                                    let fields = [
                                        ParamField::DistortionOffsetX,
                                        ParamField::DistortionOffsetY,
                                        ParamField::DistortionOffsetZ,
                                    ];
                                    for (axis, field) in fields.into_iter().enumerate() {
                                        let mut v = self.layers[i].distortion_offset[axis];
                                        let need = anim_param(
                                            ui,
                                            &mut self.timeline,
                                            ph,
                                            id,
                                            field,
                                            &mut v,
                                            |ui, v| {
                                                ui.add(
                                                    egui::DragValue::new(v)
                                                        .speed(0.05)
                                                        .range(-10.0..=10.0),
                                                )
                                            },
                                        );
                                        self.layers[i].distortion_offset[axis] = v;
                                        if need {
                                            self.mark_dirty(ui.ctx());
                                        }
                                    }
                                });
                                ui.end_row();

                                ui.label("Loop offset");
                                if ui
                                    .checkbox(&mut self.layers[i].warp_loop, "")
                                    .on_hover_text(
                                        "Offset 0→1 = one seamless loop (tileable field)",
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

        egui::CollapsingHeader::new("Remap")
            .default_open(true)
            .show(ui, |ui| {
                egui::Grid::new("grid-remap").num_columns(2).show(ui, |ui| {
                    ui.label("In range");
                    ui.horizontal(|ui| {
                        let mut v = self.layers[i].in_min;
                        let need = anim_param(
                            ui,
                            &mut self.timeline,
                            ph,
                            id,
                            ParamField::InMin,
                            &mut v,
                            |ui, v| ui.add(egui::DragValue::new(v).prefix("min: ").speed(0.01)),
                        );
                        self.layers[i].in_min = v;
                        if need {
                            self.mark_dirty(ui.ctx());
                        }

                        let mut v = self.layers[i].in_max;
                        let need = anim_param(
                            ui,
                            &mut self.timeline,
                            ph,
                            id,
                            ParamField::InMax,
                            &mut v,
                            |ui, v| ui.add(egui::DragValue::new(v).prefix("max: ").speed(0.01)),
                        );
                        self.layers[i].in_max = v;
                        if need {
                            self.mark_dirty(ui.ctx());
                        }
                    });
                    ui.end_row();

                    ui.label("Out range");
                    ui.horizontal(|ui| {
                        let mut v = self.layers[i].out_min;
                        let need = anim_param(
                            ui,
                            &mut self.timeline,
                            ph,
                            id,
                            ParamField::OutMin,
                            &mut v,
                            |ui, v| ui.add(egui::DragValue::new(v).prefix("min: ").speed(0.01)),
                        );
                        self.layers[i].out_min = v;
                        if need {
                            self.mark_dirty(ui.ctx());
                        }

                        let mut v = self.layers[i].out_max;
                        let need = anim_param(
                            ui,
                            &mut self.timeline,
                            ph,
                            id,
                            ParamField::OutMax,
                            &mut v,
                            |ui, v| ui.add(egui::DragValue::new(v).prefix("max: ").speed(0.01)),
                        );
                        self.layers[i].out_max = v;
                        if need {
                            self.mark_dirty(ui.ctx());
                        }
                    });
                    ui.end_row();
                });
            });

        egui::CollapsingHeader::new("Color")
            .default_open(true)
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label("Emission");
                    let mut v = self.layers[i].emission;
                    let need = anim_param(
                        ui,
                        &mut self.timeline,
                        ph,
                        id,
                        ParamField::Emission,
                        &mut v,
                        |ui, v| ui.add(egui::DragValue::new(v).speed(0.05).range(0.0..=16.0)),
                    );
                    self.layers[i].emission = v;
                    if need {
                        self.mark_dirty(ui.ctx());
                    }
                });

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
            // no live renderer access is needed here — `playback_bake_dims` is the same pure
            // reduction `FrameCache::bake` applies, so this predicts its dims exactly.
            let status = if self.cache_stale {
                "cache: stale".to_string()
            } else {
                let bake_dims = anim::playback_bake_dims(
                    self.dims,
                    self.frame_count,
                    crate::render::frame_cache::FRAME_CACHE_BUDGET_BYTES,
                );
                let product = bake_dims[0] as f64 * bake_dims[1] as f64 * bake_dims[2] as f64;
                let gb = self.frame_count as f64 * product * anim::BYTES_PER_VOXEL as f64
                    / (1u64 << 30) as f64;
                let eff_fps = self.frame_count as f32 / self.loop_seconds.max(1e-3);
                format!(
                    "baked {} @ {}×{}×{}  ({:.1} GB)  {:.0} fps  {}",
                    self.frame_count,
                    bake_dims[0],
                    bake_dims[1],
                    bake_dims[2],
                    gb,
                    eff_fps,
                    if self.interp { "smooth" } else { "steps" }
                )
            };
            ui.label(status);
        });

        self.timeline_panel(ui);
    }

    /// Visual timeline: a seconds ruler, one lane per animated `(layer_id, field)` track with a
    /// keyframe dot per key, and a playhead line — display only (Task 2 of the timeline-SP2
    /// cycle; click/drag/delete land in Task 3). Called at the tail of `animation_panel`, below
    /// the Phase slider.
    fn timeline_panel(&mut self, ui: &mut egui::Ui) {
        // Owned snapshot (`to_entries` clones out of `&self.timeline`) — painting below reads
        // `self.layers`/`self.phase`/`self.selected_key` too, so nothing here aliases `&mut self`.
        let entries = self.timeline.to_entries();
        if entries.is_empty() {
            ui.weak("no keyframes — click ◆ next to a value to animate it");
            return;
        }

        // Left gutter width (track-label column), shared by the ruler and every lane so a key's
        // dot lines up under its ruler tick. `phase_to_x` takes the row's own rect (rather than
        // closing over one shared rect) so the ruler (outside the `ScrollArea`) and each lane
        // (inside it, whose width shrinks slightly once a vertical scrollbar appears) each map
        // through their own width — Task 3's inverse (`x_to_phase`) should mirror this shape.
        const LABEL_W: f32 = 90.0;
        const RULER_H: f32 = 16.0;
        const LANE_H: f32 = 18.0;
        let phase_to_x = |p: f32, r: egui::Rect| r.left() + LABEL_W + p * (r.width() - LABEL_W);

        let weak = ui.visuals().weak_text_color();
        let text_color = ui.visuals().text_color();
        let accent = ui.visuals().selection.bg_fill;
        let font = egui::TextStyle::Small.resolve(ui.style());

        // Ruler: baseline + 0s / mid / end labels.
        let (ruler_rect, _) = ui.allocate_exact_size(
            egui::vec2(ui.available_width(), RULER_H),
            egui::Sense::hover(),
        );
        let painter = ui.painter();
        painter.hline(
            (ruler_rect.left() + LABEL_W)..=ruler_rect.right(),
            ruler_rect.center().y,
            egui::Stroke::new(1.0, weak),
        );
        painter.text(
            egui::pos2(phase_to_x(0.0, ruler_rect), ruler_rect.top()),
            egui::Align2::LEFT_TOP,
            "0s",
            font.clone(),
            weak,
        );
        painter.text(
            egui::pos2(phase_to_x(0.5, ruler_rect), ruler_rect.top()),
            egui::Align2::CENTER_TOP,
            format!("{:.1}s", self.loop_seconds * 0.5),
            font.clone(),
            weak,
        );
        painter.text(
            egui::pos2(phase_to_x(1.0, ruler_rect), ruler_rect.top()),
            egui::Align2::RIGHT_TOP,
            format!("{:.1}s", self.loop_seconds),
            font.clone(),
            weak,
        );
        let ruler_playhead_x = phase_to_x(self.phase, ruler_rect);
        painter.line_segment(
            [
                egui::pos2(ruler_playhead_x, ruler_rect.top()),
                egui::pos2(ruler_playhead_x, ruler_rect.bottom()),
            ],
            egui::Stroke::new(1.5, accent),
        );

        egui::ScrollArea::vertical()
            .max_height(160.0)
            .show(ui, |ui| {
                for entry in &entries {
                    let (row, _) = ui.allocate_exact_size(
                        egui::vec2(ui.available_width(), LANE_H),
                        egui::Sense::hover(),
                    );
                    let lane_y = row.center().y;
                    let painter = ui.painter();

                    let layer_idx = self
                        .layers
                        .iter()
                        .position(|l| l.id == entry.layer_id)
                        .map(|i| i.to_string())
                        .unwrap_or_else(|| "?".to_string());
                    painter.text(
                        egui::pos2(row.left(), lane_y),
                        egui::Align2::LEFT_CENTER,
                        format!("L{}·{}", layer_idx, entry.field.label()),
                        font.clone(),
                        text_color,
                    );
                    painter.hline(
                        (row.left() + LABEL_W)..=row.right(),
                        lane_y,
                        egui::Stroke::new(1.0, weak),
                    );

                    for key in &entry.keys {
                        let x = phase_to_x(key.phase, row);
                        let selected =
                            self.selected_key == Some((entry.layer_id, entry.field, key.phase));
                        let dot_color = if selected { accent } else { text_color };
                        let radius = if selected { 5.0 } else { 3.0 };
                        painter.circle_filled(egui::pos2(x, lane_y), radius, dot_color);
                        if selected {
                            painter.circle_stroke(
                                egui::pos2(x, lane_y),
                                radius + 2.5,
                                egui::Stroke::new(1.5, accent),
                            );
                        }
                    }

                    let playhead_x = phase_to_x(self.phase, row);
                    painter.line_segment(
                        [
                            egui::pos2(playhead_x, row.top()),
                            egui::pos2(playhead_x, row.bottom()),
                        ],
                        egui::Stroke::new(1.5, accent),
                    );
                }
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

        // Top bar: title, dims + seed (moved out of `layers_panel`), theme toggle, and the
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

                ui.label("Box (X/Y/Z)");
                let prev_dims = self.dims;
                egui::ComboBox::from_label("X")
                    .selected_text(format!("{}", self.dims[0]))
                    .show_ui(ui, |ui| {
                        for d in DIM_CHOICES {
                            ui.selectable_value(&mut self.dims[0], d, format!("{d}"));
                        }
                    });
                egui::ComboBox::from_label("Y")
                    .selected_text(format!("{}", self.dims[1]))
                    .show_ui(ui, |ui| {
                        for d in DIM_CHOICES {
                            ui.selectable_value(&mut self.dims[1], d, format!("{d}"));
                        }
                    });
                egui::ComboBox::from_label("Z")
                    .selected_text(format!("{}", self.dims[2]))
                    .show_ui(ui, |ui| {
                        for d in DIM_CHOICES {
                            ui.selectable_value(&mut self.dims[2], d, format!("{d}"));
                        }
                    });
                if self.dims != prev_dims {
                    self.cache_stale = true;
                    self.mark_dirty(ui.ctx());
                    self.wire_flash_start = ui.ctx().input(|i| i.time);
                }

                let mb = self.dims.iter().map(|&d| d as u64).product::<u64>()
                    * anim::BYTES_PER_VOXEL
                    / (1024 * 1024);
                ui.label(format!(
                    "box {}×{}×{} — {} MB/frame",
                    self.dims[0], self.dims[1], self.dims[2], mb
                ));
                ui.separator();

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
                // HDR exposure (Task 3): a render param the raymarch reads live each frame, not a
                // bake input — no `mark_dirty`/`cache_stale` needed, continuous repaint covers it.
                ui.add(egui::Slider::new(&mut self.exposure, 0.1..=4.0).text("Exposure"));

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

                    // Reset: same demo scene `Default::default()` builds (fresh sequential ids,
                    // the constructor's default globals, no tracks) — applied via `apply_scene`
                    // so it also forces the regen + rebake a scene swap needs.
                    if ui.button("↺ Reset").clicked() {
                        let mut layers = layer::demo_scene();
                        for (i, l) in layers.iter_mut().enumerate() {
                            l.id = i as u64;
                        }
                        let next_layer_id = layers.len() as u64;
                        self.apply_scene(persistence::SceneFile {
                            version: 1,
                            layers,
                            next_layer_id,
                            dims: [128, 128, 128],
                            global_seed: 0.0,
                            loop_seconds: 4.0,
                            evolutions: 0.0,
                            fps: 30,
                            interp: false,
                            tracks: Vec::new(),
                            camera: persistence::CamState::default(),
                            exposure: 1.0,
                        });
                    }
                    if ui.button("💾 Save as default").clicked() {
                        self.save_current_scene();
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
        // (possibly reduced) bake_dims cache back to full res. `pack_for_gpu`'s `anim_phase` is
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

            // Snapshot `dims` into `committed_dims` the instant a regen (bake or live) actually
            // dispatches — see field doc. `self.playing`/`cache_stale`/`frame_count`/
            // `pending_regen` are all already settled above (pause-snap/debounce), so this can
            // run before `need_bake`/the live-regen branch recompute the same predicate below.
            if regen_dispatches(
                self.playing,
                self.cache_stale,
                self.frame_count,
                self.pending_regen,
            ) {
                self.committed_dims = self.dims;
            }

            let aspect = rect.width() / rect.height().max(1.0);
            // `cam.macro_dims`/the shader-facing `box_aspect_*` scalar fields are left
            // 0.0/1.0 by `basis` — `RaymarchCallback::prepare` overwrites those from the BOUND
            // volume's actual dims. The box-shape fed into `basis` here for camera framing
            // (center/fit) is `committed_dims`-derived instead: `dims` updates immediately on a
            // UI edit, ~120ms ahead of the debounced regen that actually rebuilds the box, which
            // would otherwise pop the camera to the new aspect a frame before the box itself
            // catches up.
            let box_aspect = anim::aspect_from_dims(self.committed_dims);
            let mut cam = self.cam.basis(aspect, 128.0, box_aspect);
            // Bounding-box wireframe opacity: an EMA-smoothed hover glow (settles at 0.55) maxed
            // against a flash-and-fade spike (1.0 -> 0.0 over 2s hold + 1s fade) that
            // `wire_flash_start` re-triggers on every box-dims change — so resizing the box
            // always flashes the wireframe even if the pointer isn't over the viewport, while
            // hovering alone still shows it. `.max` (not additive) keeps it clamped without a
            // second clamp op before the final one below.
            let target_hover = if response.hovered() { 1.0 } else { 0.0 };
            self.wire_hover += (target_hover - self.wire_hover) * 0.18;
            let now = ui.ctx().input(|i| i.time);
            let flash = anim::flash_envelope(now - self.wire_flash_start, 2.0, 1.0);
            cam.wire_alpha = (self.wire_hover * 0.55).max(flash).clamp(0.0, 1.0);
            cam.exposure = self.exposure;

            // Bake the dense cache when playing with a stale cache (Play press, or re-bake after
            // an edit while playing). `ensure_baked`'s `is_stale` is the real single-fire guard;
            // this CPU-side `cache_stale` flag just avoids re-packing/re-hashing every frame once
            // the cache is fresh.
            let need_bake = self.playing && self.cache_stale && self.frame_count > 0;
            // Sample the cached (reduced-res, `FrameCache::bake_dims`) frame only while actually
            // playing. The moment playback stops, this drops to `false` — the pause-snap regen
            // above (`was_playing`/`pending_regen`) re-renders the live volume at full res and
            // this leaves the raymarch bound to it (no `bind_playback` override), so a paused
            // frame is always full-res, never the bake's reduced resolution (cycle-5 contract).
            let use_cache = self.playing && self.frame_count > 0;

            // Empty/idle `GenParams` (used when neither baking nor live-regenerating this frame):
            // dims/aspect derive from `self.dims` directly (per-axis, Task 4).
            let empty_dims = self.dims;
            let empty_aspect = anim::aspect_from_dims(empty_dims);
            let empty_params = GenParams {
                dim_x: empty_dims[0],
                dim_y: empty_dims[1],
                dim_z: empty_dims[2],
                layer_count: 0,
                aspect_x: empty_aspect[0],
                aspect_y: empty_aspect[1],
                aspect_z: empty_aspect[2],
                anim_phase: 0.0,
                anim_evolutions: self.evolutions,
                _pad0: 0.0,
                _pad1: 0.0,
                _pad2: 0.0,
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
                    // Source dims for the bake — `FrameCache::bake` reduces these further via
                    // `anim::playback_bake_dims` and overrides dim_*/aspect_* per its own
                    // (possibly smaller) `bake_dims`.
                    let source_dims = self.dims;
                    let source_aspect = anim::aspect_from_dims(source_dims);
                    let gp = GenParams {
                        dim_x: source_dims[0],
                        dim_y: source_dims[1],
                        dim_z: source_dims[2],
                        layer_count: frames[0].len() as u32,
                        aspect_x: source_aspect[0],
                        aspect_y: source_aspect[1],
                        aspect_z: source_aspect[2],
                        anim_phase: 0.0, // bake sets per-frame phase in FrameCache::bake
                        anim_evolutions: self.evolutions,
                        _pad0: 0.0,
                        _pad1: 0.0,
                        _pad2: 0.0,
                    };
                    // Frame 0's packed layers stand in for the whole bake in the key (matching
                    // `pack_for_gpu`'s single-snapshot fingerprint elsewhere); `timeline_hash`
                    // covers edits to keyframes elsewhere in the loop that frame 0 alone can't see.
                    let key = anim::BakeKey::new(
                        &frames[0],
                        source_dims,
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
                dims: self.dims,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Closes the coverage gap `persistence.rs`'s task-1 round-trip test left open (it only
    /// checked `dims`/`layers.len()` with empty `tracks`): a `SceneFile` with non-empty tracks,
    /// asserting every scalar field AND the timeline's `hash()` (not just track count) survive a
    /// JSON round-trip.
    #[test]
    fn scenefile_full_roundtrip_with_tracks() {
        let mut tl = Timeline::default();
        tl.upsert(2, ParamField::Opacity, 0.0, 0.1);
        tl.upsert(2, ParamField::Opacity, 1.0, 0.9);
        tl.upsert(5, ParamField::ScaleX, 0.3, 2.0);
        let tracks_hash = tl.hash();

        let s = persistence::SceneFile {
            version: 1,
            layers: layer::demo_scene(),
            next_layer_id: 6,
            dims: [64, 32, 256],
            global_seed: 1.25,
            loop_seconds: 7.5,
            evolutions: 3.0,
            fps: 24,
            interp: true,
            tracks: tl.to_entries(),
            camera: persistence::CamState {
                yaw: 0.42,
                pitch: -0.17,
                distance: 5.5,
            },
            exposure: 1.75,
        };

        let js = serde_json::to_string(&s).unwrap();
        let back: persistence::SceneFile = serde_json::from_str(&js).unwrap();

        assert_eq!(back.version, s.version);
        assert_eq!(back.layers.len(), s.layers.len());
        assert_eq!(back.next_layer_id, s.next_layer_id);
        assert_eq!(back.dims, s.dims);
        assert_eq!(back.global_seed, s.global_seed);
        assert_eq!(back.loop_seconds, s.loop_seconds);
        assert_eq!(back.evolutions, s.evolutions);
        assert_eq!(back.fps, s.fps);
        assert_eq!(back.interp, s.interp);
        assert_eq!(back.camera.yaw, s.camera.yaw);
        assert_eq!(back.camera.pitch, s.camera.pitch);
        assert_eq!(back.camera.distance, s.camera.distance);
        assert_eq!(back.exposure, s.exposure);
        assert!(!back.tracks.is_empty());
        assert_eq!(Timeline::from_entries(back.tracks).hash(), tracks_hash);
    }

    /// The two behaviors `apply_scene` adds beyond a plain field-copy: refusing an empty-layers
    /// scene (leaves whatever was already live untouched) and flooring `next_layer_id` at one
    /// past the highest id actually present in the loaded layers — never trusting a possibly
    /// understated/stale `next_layer_id` from the save file, so a later `add_layer` can't mint an
    /// id that collides with one already on screen.
    #[test]
    fn apply_scene_guards_empty_and_floors_next_id() {
        let mut app = Vol3dApp::default();
        let before = app.layers.clone();

        app.apply_scene(persistence::SceneFile {
            layers: Vec::new(),
            ..Default::default()
        });
        assert_eq!(app.layers.len(), before.len()); // empty scene ignored, demo kept

        let mut layers = layer::demo_scene();
        layers.truncate(1);
        layers[0].id = 41;
        app.apply_scene(persistence::SceneFile {
            layers,
            next_layer_id: 0, // deliberately understated vs. the id actually in `layers`
            ..Default::default()
        });
        assert_eq!(app.layers.len(), 1);
        assert_eq!(app.next_layer_id, 42); // floored at max(existing id) + 1, not the saved 0
    }

    /// Regression for the reachable panic a review caught: `apply_scene` swapping in a shorter
    /// `layers` (e.g. Reset after selecting a late layer) left `selected` pointing past the end,
    /// so the very next `self.layers[self.selected]` (Delete, Duplicate, ...) would panic.
    /// Every other layers-mutating path clamps `selected`; `apply_scene` must too.
    #[test]
    fn apply_scene_clamps_selected_into_range() {
        let mut app = Vol3dApp::default();
        app.selected = app.layers.len() - 1 + 5; // simulate having selected a since-removed layer

        let mut layers = layer::demo_scene();
        layers.truncate(1); // scene being applied is shorter than `selected` pointed into
        app.apply_scene(persistence::SceneFile {
            layers,
            ..Default::default()
        });

        assert!(app.selected < app.layers.len());
        let _ = app.layers[app.selected]; // would panic pre-fix
    }

    /// `to_scene()` / `apply_scene()` symmetry across every persisted field: build an app with
    /// distinctive, non-default values everywhere `SceneFile` reaches, snapshot it, apply that
    /// snapshot to a *different* fresh app, and assert every field matches. Catches a
    /// wrong-field/transposed-value bug in either direction that the `SceneFile`-only JSON
    /// round-trip tests above can't see (they never touch `Vol3dApp` at all).
    #[test]
    // `Vol3dApp` has ~25 fields; a struct-literal-with-update would need to name every one
    // clippy's `field_reassign_with_default` wants set at construction, for no clarity gain over
    // reassigning just the ones this test cares about.
    #[allow(clippy::field_reassign_with_default)]
    fn to_scene_apply_scene_field_symmetry() {
        let mut app = Vol3dApp::default();
        app.dims = [64, 64, 256];
        app.global_seed = 1.5;
        app.loop_seconds = 7.0;
        app.evolutions = 2.0;
        app.fps = 48;
        app.interp = true;
        let layer_id = app.layers[0].id;
        app.timeline.upsert(layer_id, ParamField::Opacity, 0.0, 0.2);
        app.timeline.upsert(layer_id, ParamField::Opacity, 1.0, 0.9);
        app.cam.yaw = 1.23;
        app.cam.pitch = -0.55;
        app.cam.distance = 9.0;
        app.exposure = 2.25;

        let scene = app.to_scene();
        let mut b = Vol3dApp::default();
        b.apply_scene(scene);

        assert_eq!(b.dims, app.dims);
        assert_eq!(b.global_seed, app.global_seed);
        assert_eq!(b.loop_seconds, app.loop_seconds);
        assert_eq!(b.evolutions, app.evolutions);
        assert_eq!(b.fps, app.fps);
        assert_eq!(b.interp, app.interp);
        assert_eq!(b.timeline.hash(), app.timeline.hash());
        assert_eq!(b.cam.yaw, app.cam.yaw);
        assert_eq!(b.cam.pitch, app.cam.pitch);
        assert_eq!(b.cam.distance, app.cam.distance);
        assert_eq!(b.exposure, app.exposure);
        assert_eq!(b.layers.len(), app.layers.len());
    }
}
