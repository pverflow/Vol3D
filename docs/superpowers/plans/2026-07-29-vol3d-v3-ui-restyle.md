# Vol3D v3 — UI Restyle (v2 look + usability) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Restyle v3's egui UI to v2's dark pro-tool look (exact tokens from v2 `base.css`) + light/dark toggle + a top bar, and fix Properties/layer-row usability — presentation-only, cycles ①–③ logic untouched.

**Architecture:** A `theme.rs` maps v2's palette to `egui::Visuals` (dark + light), applied at startup + on toggle. A top `TopBottomPanel` hosts title/fps/resolution/seed/theme. Properties becomes `CollapsingHeader` groups with `Grid` rows; layer rows get accent highlight + eye toggle + danger Delete.

**Tech Stack:** Rust 1.97, `egui`/`eframe` `=0.35.0`, `wgpu =29.0.4`. All under `v3/`.

**Spec:** `docs/superpowers/specs/2026-07-29-vol3d-v3-ui-restyle-design.md`.

## Global Constraints

- All under `v3/`; v2 untouched. `source "$HOME/.cargo/env"` before every cargo call.
- Both `cargo check` (native) AND `cargo check --target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green.
- **Presentation-only:** do NOT change rendering, generation, gradient/authoring logic, `mark_dirty`/regen/`pending_regen`/debounce, or the FrameCache-to-be. Only visuals/layout/widget-wrapping.
- Reconcile egui 0.35 `Visuals`/widget API via `cargo check` + installed source `~/.cargo/registry/.../egui-0.35.0/`.
- No GPU in sandbox: gates are compile + tests; visual is the user's run (final task).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure (under `v3/`)

```
v3/src/
  theme.rs   # NEW: Palette (dark+light from v2 tokens), hex->Color32, build egui::Visuals, Theme enum (+tests)
  app.rs     # MOD: apply theme + toggle; top bar (TopBottomPanel::top); Properties CollapsingHeader groups + Grid; layer-row polish
```

## v2 tokens (verbatim from `src/ui/styles/base.css` — use these exact hex)

Dark: bg-base `#0b0b0f`, bg-panel `#13131a`, bg-elevated `#1a1a24`, bg-control `#22222e`, bg-hover `#2a2a3a`, bg-active `#32324a`, border `#2a2a3a`, border-focus `#5555aa`, text-primary `#e8e8f0`, text-secondary `#8888aa`, text-muted `#55556a`, accent `#6c6cff`, accent-hover `#8080ff`, danger `#ff4d6d`. radius 6/4/10, spacing 4/8/12/16/20/24, topbar 48, panel-left 280, panel-right 320, font 13px.
Light: bg-base `#f4f4f8`, bg-panel `#ffffff`, bg-elevated `#eef0f5`, bg-control `#e8e8f0`, bg-hover `#e0e0ea`, bg-active `#d4d4e4`, border `#d2d2de`, border-focus `#6c6cff`, text-primary `#1a1a24`, text-secondary `#55556a`, text-muted `#9090a4`, accent `#5555ee`, danger `#d63a58`.

---

## Task 1: `theme.rs` — palette + egui Visuals (dark + light) + toggle + tests

**Files:** Create `v3/src/theme.rs`; modify `v3/src/main.rs` (`mod theme;`), `v3/src/app.rs` (apply on startup).

**Interfaces:** `fn hex(s: &str) -> egui::Color32` (parse `#rrggbb`); `struct Palette { bg_base, bg_panel, bg_control, bg_hover, bg_active, border, border_focus, text, text_weak, accent, danger: Color32, .. }`; `Palette::DARK`/`Palette::LIGHT` (const-ish from the tokens); `enum Theme { Dark, Light }` + `Theme::palette(&self) -> Palette`; `fn visuals(theme: Theme) -> egui::Visuals` (build from the palette); `fn apply(ctx: &egui::Context, theme: Theme)` (`ctx.set_visuals(visuals(theme))` + style spacing/rounding).

- [ ] **Step 1: Failing tests**
```rust
#[test] fn hex_parses() {
    assert_eq!(hex("#6c6cff"), egui::Color32::from_rgb(0x6c,0x6c,0xff));
    assert_eq!(hex("#0b0b0f"), egui::Color32::from_rgb(11,11,15));
}
#[test] fn palettes_differ_and_have_expected_accents() {
    assert_eq!(Theme::Dark.palette().accent, hex("#6c6cff"));
    assert_eq!(Theme::Light.palette().accent, hex("#5555ee"));
    assert_ne!(Theme::Dark.palette().bg_panel, Theme::Light.palette().bg_panel);
}
```
Run → FAIL.

- [ ] **Step 2: Implement `theme.rs`.** `hex` parses `#rrggbb` (panic/`from_rgb(0,0,0)` fallback on bad input — inputs are our own constants). `Palette::DARK`/`LIGHT` from the token table. `visuals(theme)`:
```rust
pub fn visuals(theme: Theme) -> egui::Visuals {
    let p = theme.palette();
    let mut v = if matches!(theme, Theme::Dark) { egui::Visuals::dark() } else { egui::Visuals::light() };
    v.panel_fill = p.bg_panel;
    v.window_fill = p.bg_panel;
    v.extreme_bg_color = p.bg_base;
    v.faint_bg_color = p.bg_elevated;
    v.override_text_color = Some(p.text);
    v.selection.bg_fill = p.accent.linear_multiply(0.5);
    v.selection.stroke = egui::Stroke::new(1.0, p.accent);
    v.hyperlink_color = p.accent;
    let w = &mut v.widgets;
    w.noninteractive.bg_fill = p.bg_panel; w.noninteractive.fg_stroke = egui::Stroke::new(1.0, p.text_weak); w.noninteractive.bg_stroke = egui::Stroke::new(1.0, p.border);
    w.inactive.bg_fill = p.bg_control; w.inactive.fg_stroke = egui::Stroke::new(1.0, p.text); w.inactive.bg_stroke = egui::Stroke::new(1.0, p.border);
    w.hovered.bg_fill = p.bg_hover; w.hovered.bg_stroke = egui::Stroke::new(1.0, p.border_focus);
    w.active.bg_fill = p.bg_active; w.active.bg_stroke = egui::Stroke::new(1.0, p.accent);
    // rounding 6px on all widget states (reconcile field name: `rounding` vs `corner_radius` in egui 0.35 via cargo check)
    v
}
pub fn apply(ctx: &egui::Context, theme: Theme) {
    ctx.set_visuals(visuals(theme));
    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(8.0, 6.0);
    style.spacing.button_padding = egui::vec2(8.0, 4.0);
    ctx.set_style(style);
}
```
(Reconcile the exact egui-0.35 `Visuals`/`WidgetVisuals` field names — `rounding`/`corner_radius`, `bg_stroke`/`weak_bg_fill` — against installed source; `cargo check` is the arbiter.) Run → PASS.

- [ ] **Step 3: Apply on startup** in `Vol3dApp::new` (add `theme: Theme` field, default Dark) — call `theme::apply(&cc.egui_ctx, Theme::Dark)`. (Toggle wired in Task 2.)

- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): theme.rs — v2 dark+light palette -> egui Visuals + apply on startup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Top bar (title + fps + resolution + seed + theme toggle)

**Files:** Modify `v3/src/app.rs`.

**Interfaces:** consumes `theme` (Task 1). A `TopBottomPanel::top` rendered before the side panels.

- [ ] **Step 1: Top bar panel** — at the START of `ui()` (before the side/central panels), add:
```rust
egui::TopBottomPanel::top("topbar").exact_height(48.0).show_inside(ui, |ui| {
    ui.horizontal_centered(|ui| {
        ui.heading("Vol3D");
        ui.separator();
        // resolution combo (moved from layers panel) -> mark_dirty + cache_stale on change
        // global_seed DragValue (moved) -> mark_dirty
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            // theme toggle button: flips self.theme, calls theme::apply(ui.ctx(), self.theme)
            // fps/ms label (moved out of the layers panel): format!("{:.1} ms ({:.0} fps)", ema, 1000.0/ema)
        });
    });
});
```
(Reconcile `TopBottomPanel::show_inside` vs `.show(ctx,…)` for the `App::ui(ui)` context against installed egui 0.35 — likely `show_inside(ui, …)` since we have a `Ui`, not a `Context`. cargo check arbitrates.)

- [ ] **Step 2: Move fps + resolution + global_seed** out of the Layers panel into the top bar (delete them from `layers_panel`). Keep their behavior (fps EMA unchanged; resolution/seed still `mark_dirty` + set `cache_stale` where that exists). Theme toggle: a button that flips `self.theme` and calls `theme::apply(ui.ctx(), self.theme)`.

- [ ] **Step 3: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): top bar (title, fps, resolution, seed, theme toggle); fps out of layers panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Properties grouped sections + tidy rows + layer-row polish

**Files:** Modify `v3/src/app.rs`.

- [ ] **Step 1: Properties → collapsing groups + Grid.** Wrap the selected layer's controls in `egui::CollapsingHeader::new("Noise"/"Transform"/"Remap"/"Color").default_open(true).show(ui, |ui| { egui::Grid::new("...").num_columns(2).show(ui, |ui| { ui.label("Scale"); ui.horizontal(|ui|{ /* 3 DragValues */}); ui.end_row(); ... }) })`. Groups: **Noise** (type combo + FBM/SDF conditional params + amplitude/invert), **Transform** (scale/rotation/offset), **Remap** (in/out min·max), **Color** (the gradient editor). Preserve every widget's existing `.changed() -> mark_dirty` wiring — do NOT alter regen behavior. Give each Grid a stable unique id.

- [ ] **Step 2: Layer-row polish** in `layers_panel`: selected row highlighted with the accent (`ui.visuals().selection.bg_fill` via `selectable_label`, already accent from the theme — verify it reads well); replace the visibility `Checkbox` with an eye toggle (a `SelectableLabel`/button showing `👁`/`🚫` or `"◉"`/`"○"` glyph that flips `layers[i].visible` + `mark_dirty`); tint the Delete button text with `Palette::danger` (`ui.visuals().error_fg_color` or the palette danger). Keep the ScrollArea. Keep all ops via `ui_logic`.

- [ ] **Step 3: Gradient accent touch** (small): in `gradient.rs`, draw the SELECTED stop handle using `ui.visuals().selection.stroke.color` (accent) instead of a hardcoded highlight. Logic unchanged.

- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Properties collapsible grouped sections + Grid rows; layer-row polish (eye toggle, accent, danger delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: User GPU run handoff

**Files:** Modify `v3/RUN.md`.

- [ ] **Step 1:** Update `RUN.md` — the UI is now themed (v2 dark pro-tool look + light/dark toggle in the top bar), with a top bar (title/fps/resolution/seed/theme), grouped Properties, and polished layer rows. Ask the user to confirm: does it read like v2's dark UI (and light on toggle); is Properties grouped + tidy; do layer rows (eye toggle, accent highlight, danger delete) work; fps in the top bar; nothing rendering/authoring regressed. Note: this is visual-only; animation (cycle ④) lands next in this style.
- [ ] **Step 2:** commit + STOP for the user's run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): run/verify instructions for the UI restyle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** theme dark+light from v2 tokens + toggle (T1, T2 S2) ✓; top bar with title/fps/resolution/seed/theme (T2) ✓; Properties collapsible grouped sections + Grid (T3 S1) ✓; layer-row polish eye/accent/danger (T3 S2) ✓; gradient accent (T3 S3) ✓; presentation-only, cycles ①–③ logic untouched (constraint repeated per task) ✓; light toggle included ✓; user run (T4) ✓; deferred (drag-reorder/presets/export/animation) absent ✓.

**Placeholder scan:** the theme `visuals()` mapping + tests + the token table are concrete; the top-bar/Properties structure gives exact egui calls with `cargo check` + installed-source as the arbiter for 0.35 field-name drift (`rounding`/`corner_radius`, `show_inside`) — appropriate, not hand-waving.

**Type consistency:** `hex`/`Palette`/`Theme`/`visuals`/`apply` defined in T1, used in T2/T3; `self.theme: Theme` field added T1, toggled T2; every Properties/layer widget keeps its cycle-③ `.changed() -> mark_dirty` wiring (explicitly preserved, not redefined).
