# Vol3D v3 — Animation Timeline SP1: Keyframe Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make any per-layer scalar parameter keyframable along the loop's phase axis so playback plays a real keyframed animation, and make the built-in `evolutions` phase-shift opt-in (default off).

**Architecture:** A CPU-side `Timeline` of `(layer_id, ParamField) → Track` keyframe tracks. `evaluate_scene_at(phase)` produces a per-frame scene; the fps frame-cache bakes each frame `i` from `evaluate_scene_at(i/N)`. No shader change. Layers gain stable `id: u64` so tracks survive reorder/delete. A `anim_param` UI helper adds a stopwatch ◆ + keyframe-upsert to every scalar row.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `bytemuck`, `naga`. All under `v3/`. Zero readback.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-timeline-sp1-foundation-design.md`.

## Global Constraints

- All under `v3/`; v2 (`src/`) is REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga shaders/generate.wgsl` validates (no shader change expected).
- Interpolation is **linear** in SP1 (bezier/hold = SP3). Keyframe `phase ∈ [0,1]`.
- `evolutions` default **0.0** (opt-in). Existing (un-keyframed) scenes must render unchanged aside from evolution now defaulting off.
- No change to blend/compositing/distortion/noise/SDF math or the raymarch. Zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/anim_timeline.rs  # NEW: Keyframe, Track (sample), Timeline (upsert/remove/is_animated/evaluate_into/remove_layer/hash) + tests
v3/src/layer.rs          # MOD: LayerDesc.id:u64; ParamField enum + get_param/set_param; evolutions-related defaults untouched here
v3/src/main.rs (or lib)  # MOD: `mod anim_timeline;`
v3/src/ui_logic.rs       # MOD: add_layer/duplicate_layer take &mut u64 next_id and stamp the new layer's id
v3/src/app.rs            # MOD: Vol3dApp.timeline + next_layer_id; id assignment; evaluate_scene_at; pack_scene; per-frame bake; playhead-scrub eval+regen; evolutions default 0; anim_param helper + stopwatch on every scalar row
v3/src/render/frame_cache.rs # MOD: bake takes per-frame layers
v3/src/anim.rs           # MOD: BakeKey gains timeline_hash
v3/RUN.md                # MOD (Task 6)
```

---

## Task 1: Timeline data model (`anim_timeline.rs` + `ParamField`)

**Files:**
- Create: `v3/src/anim_timeline.rs`
- Modify: `v3/src/layer.rs` (add `pub id: u64` to `LayerDesc` with default 0; add `ParamField` + `get_param`/`set_param`)
- Modify: `v3/src/main.rs` (add `mod anim_timeline;`)

**Interfaces produced:**
- `layer::ParamField` (`#[derive(Clone,Copy,PartialEq,Eq,Debug,Hash)] #[repr(u8)]`) with variants: `Opacity, ScaleX, ScaleY, ScaleZ, OffsetX, OffsetY, OffsetZ, RotationX, RotationY, RotationZ, Amplitude, InMin, InMax, OutMin, OutMax, SdfRadius, SdfSoftness, SdfHeight, Persistence, Lacunarity, DistortionStrength, DistortionFrequency, DistortionSwirl, DistortionRotX, DistortionRotY, DistortionRotZ`. `ParamField::ALL: [ParamField; 26]` + `fn label(self)->&'static str`.
- `impl LayerDesc { pub fn get_param(&self, f: ParamField) -> f32; pub fn set_param(&mut self, f: ParamField, v: f32); }`
- `anim_timeline::Keyframe { pub phase: f32, pub value: f32 }`
- `anim_timeline::Track { keys: Vec<Keyframe> }` with `pub fn sample(&self, phase: f32) -> f32`, `pub fn upsert(&mut self, phase: f32, value: f32)`, `pub fn len(&self)->usize`, `pub fn is_empty(&self)->bool`.
- `anim_timeline::Timeline { tracks: BTreeMap<(u64, u8), Track> }` (key = `(layer_id, field as u8)`) with `evaluate_into(&self, layers:&mut [LayerDesc], phase:f32)`, `upsert(&mut self, id:u64, f:ParamField, phase:f32, value:f32)`, `remove(&mut self, id:u64, f:ParamField)`, `is_animated(&self, id:u64, f:ParamField)->bool`, `track_len(&self, id:u64, f:ParamField)->usize`, `remove_layer(&mut self, id:u64)`, `hash(&self)->u64`.

- [ ] **Step 1: `LayerDesc.id` + `ParamField` + get/set (write failing test first)** — in `layer.rs` add `pub id: u64` to `LayerDesc` (Default `0`), the `ParamField` enum + `ALL`/`label`, and:
```rust
impl LayerDesc {
    pub fn get_param(&self, f: ParamField) -> f32 {
        use ParamField::*;
        match f {
            Opacity => self.opacity, Amplitude => self.amplitude,
            ScaleX => self.scale[0], ScaleY => self.scale[1], ScaleZ => self.scale[2],
            OffsetX => self.offset[0], OffsetY => self.offset[1], OffsetZ => self.offset[2],
            RotationX => self.rotation_deg[0], RotationY => self.rotation_deg[1], RotationZ => self.rotation_deg[2],
            InMin => self.in_min, InMax => self.in_max, OutMin => self.out_min, OutMax => self.out_max,
            SdfRadius => self.sdf_radius, SdfSoftness => self.sdf_softness, SdfHeight => self.sdf_height,
            Persistence => self.persistence, Lacunarity => self.lacunarity,
            DistortionStrength => self.distortion_strength, DistortionFrequency => self.distortion_frequency, DistortionSwirl => self.distortion_swirl,
            DistortionRotX => self.distortion_rotation[0], DistortionRotY => self.distortion_rotation[1], DistortionRotZ => self.distortion_rotation[2],
        }
    }
    pub fn set_param(&mut self, f: ParamField, v: f32) { /* mirror match, assigning v */ }
}
```
Test (in `layer.rs` tests):
```rust
#[test] fn param_get_set_roundtrip() {
    let mut l = LayerDesc::default();
    for f in ParamField::ALL { l.set_param(f, 0.375); assert_eq!(l.get_param(f), 0.375, "{f:?}"); }
}
```
- [ ] **Step 2: run → fail → implement → pass:** `cd v3 && source "$HOME/.cargo/env" && cargo test param_get_set_roundtrip` (fails to compile → implement both matches → passes).
- [ ] **Step 3: `Track::sample` (TDD)** — create `anim_timeline.rs` with `Keyframe`, `Track`, and:
```rust
pub fn sample(&self, phase: f32) -> f32 {
    let ks = &self.keys;
    if ks.is_empty() { return 0.0; }
    if phase <= ks[0].phase { return ks[0].value; }
    let last = ks.len() - 1;
    if phase >= ks[last].phase { return ks[last].value; }
    for w in ks.windows(2) {
        if phase <= w[1].phase {
            let span = (w[1].phase - w[0].phase).max(1e-8);
            let t = ((phase - w[0].phase) / span).clamp(0.0, 1.0);
            return w[0].value + (w[1].value - w[0].value) * t;
        }
    }
    ks[last].value
}
```
`upsert(phase,value)`: replace the key within `1e-5` of `phase` else insert, keeping `keys` sorted by phase.
Tests:
```rust
#[test] fn track_sample() {
    let mut t = Track::default();
    assert_eq!(t.sample(0.5), 0.0);                 // empty
    t.upsert(0.0, 1.0); assert_eq!(t.sample(0.3), 1.0); // single-key hold
    t.upsert(1.0, 3.0);
    assert!((t.sample(0.5) - 2.0).abs() < 1e-6);    // linear mid
    assert_eq!(t.sample(-0.2), 1.0);                // hold before
    assert_eq!(t.sample(1.5), 3.0);                 // hold after
    t.upsert(0.5, 5.0); assert_eq!(t.len(), 3);     // insert keeps sorted
    t.upsert(0.5, 9.0); assert_eq!(t.len(), 3);     // upsert replaces
    assert_eq!(t.sample(0.5), 9.0);
}
```
- [ ] **Step 4: run → fail → implement → pass.**
- [ ] **Step 5: `Timeline` (TDD)** — `tracks: BTreeMap<(u64,u8), Track>`. `upsert` gets/creates the track then `Track::upsert`. `remove` drops the entry. `is_animated`/`track_len` look up. `remove_layer(id)` retains only keys whose `.0 != id`. `evaluate_into` iterates tracks, finds the layer with matching `id` in `layers`, `set_param(field, track.sample(phase))` (field decoded from the `u8`). `hash()` = FNV-1a over each track's `(id, field_u8, [phase.to_bits(), value.to_bits()]…)` in BTree order.
```rust
#[test] fn timeline_eval_and_hash() {
    let mut tl = Timeline::default();
    let mut layers = vec![LayerDesc { id: 7, ..Default::default() }];
    tl.upsert(7, ParamField::Opacity, 0.0, 0.2);
    tl.upsert(7, ParamField::Opacity, 1.0, 0.8);
    let h0 = tl.hash();
    tl.evaluate_into(&mut layers, 0.5);
    assert!((layers[0].opacity - 0.5).abs() < 1e-6);      // interpolated
    assert!(tl.is_animated(7, ParamField::Opacity));
    tl.upsert(7, ParamField::Opacity, 0.5, 0.9);
    assert_ne!(h0, tl.hash());                            // hash tracks edits
    tl.remove_layer(7); assert!(!tl.is_animated(7, ParamField::Opacity));
}
```
Also a `hash` stability test: same tracks built in a different insertion order → equal `hash()`.
- [ ] **Step 6: run → fail → implement → pass.**
- [ ] **Step 7: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): keyframe timeline data model (ParamField, Track, Timeline) + layer ids

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: App state — timeline, layer-id assignment, evaluation, evolution opt-in

**Files:**
- Modify: `v3/src/ui_logic.rs` (id stamping), `v3/src/app.rs` (state + eval + evolution)

**Interfaces produced:**
- `ui_logic::add_layer(layers, selected, next_id: &mut u64) -> usize` and `ui_logic::duplicate_layer(layers, selected, next_id: &mut u64) -> usize` — stamp the newly created layer's `id` from `*next_id` then `*next_id += 1`. (`delete_layer`/`move_up`/`move_down` unchanged.)
- `Vol3dApp` fields: `pub timeline: anim_timeline::Timeline`, `next_layer_id: u64`.
- `impl Vol3dApp { fn evaluate_scene_at(&self, phase: f32) -> Vec<LayerDesc>; fn sync_playhead(&mut self, phase: f32); }` where `evaluate_scene_at` clones `self.layers` and applies the timeline; `sync_playhead` sets `self.phase = phase`, calls `self.timeline.evaluate_into(&mut self.layers, phase)`.

- [ ] **Step 1: id stamping in ui_logic** — thread `next_id: &mut u64` into `add_layer`/`duplicate_layer`; set the created layer's `.id = *next_id; *next_id += 1;`. Update all call sites in `app.rs` to pass `&mut self.next_layer_id`.
- [ ] **Step 2: Vol3dApp state + demo ids** — add `timeline: Timeline::default()`, `next_layer_id`. In the constructor/`demo_scene` wiring, assign a unique `id` to each demo layer and set `next_layer_id` past them (e.g. iterate `demo_scene()` result, stamp `id = i as u64`, set `next_layer_id = len`).
- [ ] **Step 3: delete prunes tracks** — at the delete-layer call site in `app.rs`, capture `let removed_id = self.layers[selected].id;` before `delete_layer`, then `self.timeline.remove_layer(removed_id);`.
- [ ] **Step 4: `evaluate_scene_at` + `sync_playhead`** — add both methods. `evaluate_scene_at`:
```rust
fn evaluate_scene_at(&self, phase: f32) -> Vec<layer::LayerDesc> {
    let mut ls = self.layers.clone();
    self.timeline.evaluate_into(&mut ls, phase);
    ls
}
```
- [ ] **Step 5: playhead scrub wiring** — where the Phase slider is drawn (`app.rs:859`), on `.changed()` call `self.sync_playhead(self.phase); self.mark_dirty(ui.ctx());` so scrubbing updates sliders + regenerates the live volume at the evaluated scene. Also in the play-advance tail (`app.rs:971` after `advance_phase`), call `self.timeline.evaluate_into(&mut self.layers, self.phase);` so the visible sliders track playback (guard: only if `!self.timeline.tracks.is_empty()` to avoid needless clones — expose an `is_empty()` on Timeline).
- [ ] **Step 6: evolution opt-in** — set `evolutions` default `0.0` (`app.rs:206`). Make every `anim_evolutions` come from `self.evolutions`: fix `pack_for_gpu` (`app.rs:283` `anim_evolutions: 1.0` → `self.evolutions`) and the `empty_params` (`app.rs:1049`) → `self.evolutions`. (`app.rs:1057` already uses `self.evolutions`.)
- [ ] **Step 7: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): timeline state on Vol3dApp — layer ids, playhead eval, evolution opt-in (default 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Per-frame bake integration

**Files:**
- Modify: `v3/src/render/frame_cache.rs` (`bake` per-frame layers), `v3/src/anim.rs` (`BakeKey` timeline hash), `v3/src/app.rs` (pre-evaluate frames, `pack_scene`, bake call, BakeKey)

**Interfaces produced:**
- `FrameCache::bake(&mut self, device, queue, gen, source_res: u32, frames: &[Vec<GpuLayer>], base_params: GenParams, lut_atlas: &[u8], lut_rows: u32)` — `n = frames.len()`; `bake_res` from `n`; frame `i` generates `frames[i]` at `anim_phase = i as f32 / n as f32`.
- `anim::BakeKey::new(layers: &[GpuLayer], res: u32, evolutions: f32, n: u32, timeline_hash: u64) -> BakeKey` (new trailing param).
- `impl Vol3dApp { fn pack_scene(&self, layers: &[layer::LayerDesc]) -> (Vec<layer::GpuLayer>, Vec<u8>, u32); }` — the layer/LUT packing extracted from `pack_for_gpu` (which now calls it with `&self.layers`).

- [ ] **Step 1: `BakeKey` timeline hash (TDD)** — add `timeline_hash: u64` to `BakeKey`; extend `BakeKey::new`. Update the existing `is_stale_detects_edits` test to pass a hash and add a case where only the hash differs ⇒ stale:
```rust
let a = BakeKey::new(&[], 128, 0.0, 8, 111);
let b = BakeKey::new(&[], 128, 0.0, 8, 222);
assert!(is_stale(&Some(a), &b)); // timeline edit invalidates
```
- [ ] **Step 2: run → fail → implement → pass** (`cargo test` in `v3`).
- [ ] **Step 3: `pack_scene` extraction** — pull the layer-packing + LUT-atlas building out of `pack_for_gpu` into `pack_scene(&self, layers: &[LayerDesc]) -> (Vec<GpuLayer>, Vec<u8>, u32)`; `pack_for_gpu` calls `self.pack_scene(&self.layers)` for its layer/LUT parts (GenParams stays in `pack_for_gpu`). No behavior change for the live path — verify `cargo test`/build.
- [ ] **Step 4: `bake` signature** — change `bake` to take `frames: &[Vec<GpuLayer>]` instead of `layers: &[GpuLayer]` + `n_requested`. Inside: `let n = frames.len() as u32;` keep the `playback_bake_res(source_res, n, BUDGET)` call; in the per-frame loop use `&frames[i]` for the generate, `anim_phase = i as f32 / n as f32` on a `GenParams` copy. Everything else (occupancy, textures) unchanged.
- [ ] **Step 5: app bake call** — at the bake call site (`app.rs`, `need_bake` branch ~1052-1069): build the per-frame layers and one LUT:
```rust
let n = self.frame_count;
let (_, lut, rows) = self.pack_scene(&self.layers);            // colors static in SP1
let frames: Vec<Vec<layer::GpuLayer>> = (0..n)
    .map(|i| self.pack_scene(&self.evaluate_scene_at(i as f32 / n as f32)).0)
    .collect();
// bake_key uses the first frame's packed layers + timeline hash
let bake_key = anim::BakeKey::new(&frames[0], self.resolution, self.evolutions, n, self.timeline.hash());
// ... frame_cache.bake(device, queue, gen, self.resolution, &frames, base_params, &lut, rows);
```
Wire `base_params` as today (its `anim_phase` is overwritten per frame inside `bake`). Keep `cache_stale`/single-fire gating unchanged.
- [ ] **Step 6: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && naga shaders/generate.wgsl && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): bake each cached frame from evaluate_scene_at(i/N); BakeKey timeline hash

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Keyframe UI — stopwatch on every scalar row

**Files:**
- Modify: `v3/src/app.rs`

**Interfaces produced:**
- A helper (free fn or method) `anim_param(ui, timeline: &mut Timeline, playhead: f32, id: u64, field: ParamField, value: &mut f32, widget: impl FnOnce(&mut Ui, &mut f32) -> Response) -> bool` returning `true` if a regen is needed (value changed or track toggled). It draws the ◆ toggle (filled when `timeline.is_animated(id, field)`) before the widget; on ◆ toggle it creates a 1-key track at `playhead` (from `*value`) or removes the track; when animated and the widget `.changed()`, it `timeline.upsert(id, field, playhead, *value)`. Shows a small `N` (track_len) label when animated.

- [ ] **Step 1: helper** — implement `anim_param`. Keep it the single place keyframe logic lives. Sketch:
```rust
fn anim_param(ui: &mut egui::Ui, tl: &mut Timeline, playhead: f32, id: u64, field: ParamField,
              value: &mut f32, widget: impl FnOnce(&mut egui::Ui, &mut f32) -> egui::Response) -> bool {
    let mut need = false;
    let animated = tl.is_animated(id, field);
    let mark = if animated { "◆" } else { "◇" };
    if ui.small_button(mark).clicked() {
        if animated { tl.remove(id, field); } else { tl.upsert(id, field, playhead, *value); }
        need = true;
    }
    if animated { ui.weak(format!("{}", tl.track_len(id, field))); }
    if widget(ui, value).changed() {
        if tl.is_animated(id, field) { tl.upsert(id, field, playhead, *value); }
        need = true;
    }
    need
}
```
- [ ] **Step 2: wrap the scalar rows** — replace each scalar `DragValue`/`Slider` in the properties panel (opacity, amplitude, scale/offset/rotation xyz, in/out remap, sdf radius/softness/height, persistence, lacunarity, distortion strength/freq/swirl, distortion-rot xyz) with an `anim_param(...)` call using `self.layers[i].id`, the matching `ParamField`, `&mut` the field, and a closure drawing the same widget. If `anim_param` returns true → `self.mark_dirty(ui.ctx())`. Non-animatable controls (enum combos, octaves u32, visibility, blend mode, color) are left as-is.
- [ ] **Step 3: build/gate** — visual correctness is the GPU run; here just ensure it compiles + all gates green. Borrow note: `anim_param` needs `&mut self.timeline` while reading `self.layers[i].id`/`&mut self.layers[i].field` — capture `id` (a `u64` copy) and split borrows (read id first, then pass `&mut self.timeline` + `&mut value`); restructure to avoid aliasing `self`.
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): stopwatch keyframe toggle on every scalar param (anim_param helper)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: RUN.md + user GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1:** document keyframing: click the **◆** next to any numeric param to animate it (adds a keyframe at the current Phase/playhead); move the **Phase** slider and change the value to add more keyframes; Play to see it animate. Note **evolutions now defaults to 0 (off)** — raise it for the old built-in domain swirl. Ask the user to report: keyframing a param (e.g. opacity or offset) animates smoothly over the loop; multiple animated params compose; scrubbing Phase shows interpolated state; evolutions off by default and re-enable works; un-keyframed scenes look as before. Note deferred: visual track lanes (SP2), value curves (SP3), color/enum tracks (SP4).
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): keyframe timeline SP1 run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** stable layer ids (T1 §1, T2 §1-3) ✓; `ParamField`+get/set (T1) ✓; `Track::sample` linear+hold (T1 §3) ✓; `Timeline` upsert/remove/is_animated/evaluate_into/remove_layer/hash (T1 §5) ✓; `evaluate_scene_at` (T2 §4) ✓; per-frame bake + `BakeKey` timeline hash (T3) ✓; paused/playing playhead eval + regen (T2 §5) ✓; evolution default 0 + consistent (T2 §6) ✓; stopwatch on every scalar row (T4) ✓; GPU run (T5) ✓; linear-only, no shader change ✓.

**Placeholder scan:** all steps carry concrete code or exact edit targets; the only "mirror match" is `set_param` (fully determined by `get_param`'s field mapping).

**Type consistency:** `ParamField` (T1) used by `Timeline`/`get_param`/`set_param` (T1) + `anim_param` (T4); `Timeline::hash()->u64` (T1) feeds `BakeKey::new(…, timeline_hash)` (T3); `evaluate_scene_at`/`pack_scene` (T2/T3) feed the per-frame `bake(frames:&[Vec<GpuLayer>])` (T3); `add_layer/duplicate_layer(…, next_id:&mut u64)` (T2) called with `&mut self.next_layer_id`.
