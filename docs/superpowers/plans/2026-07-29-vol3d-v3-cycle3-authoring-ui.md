# Vol3D v3 — Cycle ③ Authoring UI (egui) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Replace the hardcoded demo scene + 3 sliders with a real egui authoring UI: interactive layers panel + per-layer properties (starter noise set) + a custom color gradient editor, driving the existing debounced GPU compute generation.

**Architecture:** `Vol3dApp` holds `layers: Vec<LayerDesc>` + `selected` + globals + regen bookkeeping. egui `SidePanel`s (Layers left, Properties right) mutate that; edits set `dirty`+timestamp; a ~120ms debounce triggers the cycle-② `generate()` path. A custom gradient-editor widget edits each layer's `ColorRamp`. Rendering/shaders unchanged from cycle ②.

**Tech Stack:** Rust 1.97, `egui`/`eframe`/`egui-wgpu =0.35.0`, `wgpu =29.0.4`, `bytemuck`. All under `v3/`.

**Spec:** `docs/superpowers/specs/2026-07-29-vol3d-v3-cycle3-authoring-ui-design.md`.

## Global Constraints

- All code under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo/naga.
- Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green; `naga` validates both shaders (unchanged, but confirm).
- No GPU in sandbox: gates are compile + tests + naga; egui interaction is the user's GPU run (final task).
- Reuse cycle ②'s `LayerDesc`, packer, `GpuLayer`, `build_ramp_lut_atlas`, `GenParams`, `VolumeGen::generate`, raymarch embed. Do NOT change `render/*` or `shaders/*` except where noted.
- Reconcile egui 0.35 widget API via `cargo check` (0.35 differs from older egui — e.g. `App::ui`, `egui::Panel`).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  ui_logic.rs   # NEW: pure helpers — layer-list ops, gradient stop math, debounce predicate (+ tests)
  gradient.rs   # NEW: custom egui gradient-editor widget (paint + pointer; uses ui_logic stop math)
  app.rs        # MODIFIED: Vol3dApp state (layers/selected/globals/dirty/last_edit_time); Layers + Properties panels; debounced regen wiring
```

---

## Task 1: Pure UI-logic helpers + tests

**Files:** Create `v3/src/ui_logic.rs`. Modify `v3/src/main.rs` (`mod ui_logic;`).

**Interfaces produced:**
- Layer-list ops over `Vec<LayerDesc>` + a `selected: usize`, each returning the new `selected` (or mutating in place + returning it), keeping `selected` in `[0, len)`:
  `add_layer(layers, selected) -> usize` (push a `LayerDesc::default()`, select it), `duplicate_layer(layers, selected) -> usize`, `delete_layer(layers, selected) -> usize` (never empties below 1 layer — if len==1, no-op or keep one), `move_up(layers, selected) -> usize`, `move_down(layers, selected) -> usize`.
- Gradient stop math on `Vec<RampStop>` (from cycle ②'s `ramp.rs`): `add_stop(stops, t) -> usize` (insert a stop at `t` with color sampled from the current stops via `sample_stops`, return its index, keep sorted), `move_stop(stops, i, t) -> usize` (set stop i's `t` clamped [0,1], re-sort, return its new index), `remove_stop(stops, i)` (keep ≥1), and reuse `sample_stops` (already in `ramp.rs`).
- `fn should_regen(now: f64, last_edit: f64, dirty: bool) -> bool { dirty && (now - last_edit) >= REGEN_DEBOUNCE }`, `const REGEN_DEBOUNCE: f64 = 0.12`.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn add_then_delete_keeps_selection_valid() {
    let mut ls = vec![LayerDesc::default()];
    let s = add_layer(&mut ls, 0);            // 2 layers, select new
    assert_eq!(ls.len(), 2); assert_eq!(s, 1);
    let s = delete_layer(&mut ls, s);          // back to 1
    assert_eq!(ls.len(), 1); assert!(s < ls.len());
    let s = delete_layer(&mut ls, s);          // refuse to empty
    assert_eq!(ls.len(), 1);
}
#[test]
fn move_up_down_reorders_and_tracks_selection() {
    let mut ls = vec![a(), b(), c()];          // helpers set a distinct marker per layer
    let s = move_down(&mut ls, 0);             // a now at index 1
    assert_eq!(s, 1); assert!(is_a(&ls[1]));
    let s = move_up(&mut ls, s);               // back to 0
    assert_eq!(s, 0); assert!(is_a(&ls[0]));
}
#[test]
fn gradient_stop_ops() {
    let mut st = vec![RampStop{t:0.0,color:[0,0,0],alpha:0}, RampStop{t:1.0,color:[255,255,255],alpha:255}];
    let i = add_stop(&mut st, 0.5);            // inserted, sorted
    assert_eq!(st.len(), 3); assert!((st[i].t - 0.5).abs() < 1e-6);
    let i = move_stop(&mut st, i, 1.5);        // clamps to 1.0, re-sorts to the end
    assert!((st[i].t - 1.0).abs() < 1e-6);
    remove_stop(&mut st, i); assert_eq!(st.len(), 2);
    // never below 1
    remove_stop(&mut st, 0); remove_stop(&mut st, 0);
    assert!(st.len() >= 1);
}
#[test]
fn debounce_predicate() {
    assert!(!should_regen(1.00, 1.00, true));   // no time elapsed
    assert!(should_regen(1.20, 1.00, true));    // 200ms > 120ms
    assert!(!should_regen(1.20, 1.00, false));  // not dirty
}
```
Run: `source "$HOME/.cargo/env" && cd v3 && cargo test ui_logic` → FAIL (not implemented).

- [ ] **Step 2: Implement `ui_logic.rs`** — the helpers above (pure; no egui import). Reuse `crate::ramp::{RampStop, sample_stops}` and `crate::layer::LayerDesc`. `add_stop` colors the new stop from `sample_stops(stops, t)`. Run → PASS.

- [ ] **Step 3: gate + commit**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): cycle-3 pure UI-logic helpers (layer ops, gradient stop math, debounce) + tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Layers + Properties panels + debounced regen

**Files:** Modify `v3/src/app.rs`.

**Interfaces:** Consumes `ui_logic` (Task 1) + `LayerDesc` (cycle ②). Produces `Vol3dApp { layers: Vec<LayerDesc>, selected: usize, resolution: u32, global_seed: f32, dirty: bool, last_edit_time: f64, .. }` and the two panels; the raymarch callback still generates in `prepare` when a regen is due.

- [ ] **Step 1: App state + remove demo sliders**

Replace the demo-scene/3-slider state with: `layers: Vec<LayerDesc>` (seed it with `demo_scene()` so it opens non-empty), `selected: usize`, `resolution: u32` (default 128), `global_seed: f32`, `dirty: bool` (true initially), `last_edit_time: f64`. A helper `fn mark_dirty(&mut self, ctx)` sets `dirty=true; self.last_edit_time = ctx.input(|i| i.time)`.

- [ ] **Step 2: Layers panel (`SidePanel::left`)**

For each layer row: `ui.selectable_label(self.selected==i, name)` (click → `self.selected=i`), a `Checkbox` on `layers[i].visible`, a blend `ComboBox`. Buttons row: Add / Duplicate / Delete / Up / Down calling the `ui_logic` ops (`self.selected = add_layer(&mut self.layers, self.selected)` etc.). Any mutation → `self.mark_dirty(ctx)`. (Reconcile exact egui 0.35 widget calls via `cargo check`.)

- [ ] **Step 3: Properties panel (`SidePanel::right`) for `layers[selected]`**

`ComboBox` noise type (Value/Perlin/Simplex/FBM/SdfSphere); `DragValue`s for scale[3], rotation[3] (deg), offset[3], amplitude, opacity (clamp 0..1), remap in_min/in_max/out_min/out_max; `Checkbox` invert; blend `ComboBox`; conditional FBM (octaves/persistence/lacunarity + base combo) and SDF (radius/softness/height) groups by type. Each widget: if its `Response.changed()`, `self.mark_dirty(ctx)`. (Gradient editor added in Task 3 — leave a placeholder `ui.label("color: (gradient editor — task 3)")` for now.)

- [ ] **Step 4: Debounced regen wiring**

In `update()`, after drawing panels: `let now = ctx.input(|i| i.time); if should_regen(now, self.last_edit_time, self.dirty) { self.dirty = false; self.pending_regen = true; }` and `if self.dirty { ctx.request_repaint(); }` (so the debounce fires without user input). The `CentralPanel` viewport callback's `prepare` checks `self.pending_regen` (thread the flag into the `RaymarchCallback` like cycle ② threaded `dirty`): when set, pack `self.layers` (fold `global_seed` into each seed), build the LUT atlas, `generate(res=self.resolution, …)`, rebuild the raymarch bind group, clear the flag. Resolution `ComboBox` (64/128/256) + `global_seed` `DragValue` live in the Layers or a small top area; changing them marks dirty.

- [ ] **Step 5: gate + commit**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown
naga shaders/generate.wgsl && naga shaders/raymarch.wgsl
cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): egui Layers + Properties panels + debounced regen (demo sliders removed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Custom color gradient editor widget

**Files:** Create `v3/src/gradient.rs`. Modify `v3/src/app.rs` (mount it in Properties), `v3/src/main.rs` (`mod gradient;`).

**Interfaces:** `fn gradient_editor(ui: &mut egui::Ui, ramp: &mut ColorRamp, selected_stop: &mut Option<usize>) -> egui::Response` — draws the bar + handles + color picker, mutates `ramp.stops` via `ui_logic` stop math, returns a `Response` whose `.changed()` is true on any edit.

- [ ] **Step 1: Paint the gradient bar**

`let (rect, resp) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 24.0), egui::Sense::click_and_drag());` Paint a checker backdrop (for alpha) then the gradient: either many thin vertical rects sampling `sample_stops(&ramp.stops, x_frac)` across the width, or a per-pixel mesh — thin rects (~2px) is fine. Use `ui.painter().rect_filled(...)` with `Color32::from_rgba_unmultiplied(r,g,b,a)`.

- [ ] **Step 2: Stop handles + hit-test + drag**

Draw a small triangle/circle handle at each stop's `x = rect.left() + t*rect.width()`. On `resp.hovered()` + pointer: hit-test handles (nearest within a few px). Click a handle → `*selected_stop = Some(i)`. Drag the selected handle → `let t = ((pointer.x - rect.left())/rect.width()).clamp(0,1); *selected_stop = Some(move_stop(&mut ramp.stops, i, t)); changed = true;`. Click the bar away from any handle → `let i = add_stop(&mut ramp.stops, t); *selected_stop = Some(i); changed=true;`. Highlight the selected handle.

- [ ] **Step 3: Selected-stop color + remove**

Below the bar: if `Some(i) = *selected_stop`, an egui `color_edit_button_srgba(&mut c)` bound to that stop's color+alpha (convert `RampStop.color:[u8;3]+alpha:u8` ↔ `Color32`); on change → write back + `changed=true`. A "Remove stop" button → `remove_stop(&mut ramp.stops, i); *selected_stop=None; changed=true` (guard ≥1). Return `resp.union(...)`/set `changed` so callers see `.changed()`.

- [ ] **Step 4: Mount in Properties**

In `app.rs` Properties panel, replace the Task-2 placeholder with `if gradient_editor(ui, &mut self.layers[sel].color_ramp, &mut self.selected_stop).changed() { self.mark_dirty(ctx); }`. Add `selected_stop: Option<usize>` to `Vol3dApp` (reset to `None` when `selected` layer changes).

- [ ] **Step 5: gate + commit**

```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): custom egui color gradient editor (draggable stops, add/remove, per-stop color)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1: Update `RUN.md`** — the app is now an interactive authoring UI: Layers panel (add/dup/delete/reorder/visibility/blend), Properties (noise type/transform/remap/opacity/invert/blend + FBM/SDF params), and the color gradient editor. Document how to build a scene + what to report: can you add/reorder/delete layers; do properties + noise-type changes regenerate (debounced ~120ms); does the gradient editor edit each layer's color live (drag stops, add/remove, pick color); is the multi-layer color vivid + by-your-choice now; paste any egui/wgpu error. Note native (`cargo run`) + web (`trunk serve`). Deferred (not in this cycle): bezier curve editors, feather, presets, animation.

- [ ] **Step 2: commit + STOP for the user's GPU run**

```bash
git add v3/RUN.md && git commit -m "docs(v3): cycle-3 run/verify instructions (authoring UI)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Hand off: ask the user to run it, author a scene, and report reactivity + the gradient editor + any error.

---

## Self-Review

**Spec coverage:** layers CRUD+reorder+select+visibility+blend (T1 ops, T2 panel) ✓; properties for starter noise set + transform + remap + FBM/SDF (T2 S3) ✓; custom color gradient editor (T3) ✓; resolution + global seed (T2 S4) ✓; debounced regen (T1 `should_regen`, T2 S4) ✓; pure-fn unit tests (T1) ✓; deferred items (bezier/feather/presets/animation/drag-proxy) not present ✓; user GPU run (T4) ✓; render/shaders unchanged (only app.rs + new UI modules) ✓.

**Placeholder scan:** T1 tests + helpers are concrete; T2/T3 give the egui widget structure + the exact `ui_logic` calls, with `cargo check` as the arbiter for egui-0.35 signature drift (appropriate for a compile-gated UI task) — the gradient editor's paint/hit-test is spelled out step-by-step, not hand-waved.

**Type consistency:** `LayerDesc`/`RampStop`/`ColorRamp`/`sample_stops` come from cycle ②'s `layer.rs`/`ramp.rs`; `add_layer/duplicate_layer/delete_layer/move_up/move_down` (usize→usize) and `add_stop/move_stop/remove_stop/should_regen` names are defined in T1 and used verbatim in T2/T3; `gradient_editor(ui, &mut ColorRamp, &mut Option<usize>) -> Response` defined in T3 Interfaces and mounted in T3 S4; `Vol3dApp` fields (`layers/selected/resolution/global_seed/dirty/last_edit_time/pending_regen/selected_stop`) introduced across T2/T3 consistently.
