# Vol3D v3 — UI Restyle (v2 look + usability) — Design

**Date:** 2026-07-29
**Status:** Approved (user: "go"). Precedes cycle ④'s animation UI so those controls land already styled.
**Parent:** v3 direction spec; builds on cycle ③ (authoring UI). Presentation-only — no render/generation/logic change.

## Goal

Restyle v3's raw-egui UI to v2's dark pro-tool visual language (exact tokens from v2 `src/ui/styles/base.css`), add a top bar, and fix specific usability pains — keeping the layout, rendering, generation, and gradient/authoring logic (cycles ①–③) untouched.

## Theme (egui `Style`/`Visuals` from v2 tokens)

A `theme.rs` mapping v2's `:root` tokens to `egui::Visuals`, applied at startup (and on toggle):

- **Dark (default):** panel/window fill `#13131a`; extreme_bg/viewport `#0b0b0f`; widget (`noninteractive`/`inactive`) bg `#22222e`; `hovered` `#2a2a3a`; `active` `#32324a`; borders `#2a2a3a`; focus/selection stroke `#5555aa`; text `#e8e8f0`, weak text `#8888aa`; **accent `#6c6cff`** for `selection.bg_fill` + active widget strokes + slider/handle highlights; `danger #ff4d6d` for Delete. Rounding 6px (4 small); item spacing ~8px; button padding ~8×4; window/panel margins ~12px; 13px font.
- **Light:** the parallel v2 light token set (`#f4f4f8`/`#ffffff`/… accent `#5555ee`).
- A **dark/light toggle** in the top bar (persist in app state; egui `Context::set_visuals`).

## Layout

Keep the current structure (it matches v2's panel widths) + add a top bar:
- **Top bar** (~48px): app title, the **fps/ms counter** (moved out of the Layers panel), the **Resolution** combo, **global seed**, and the **theme toggle**. (Export/Presets are later cycles — no dead buttons now.)
- **Left panel** (~280px): Layers.
- **Center:** viewport (fills remaining space).
- **Right panel** (~320px): Properties.

## Usability fixes

1. **Properties → collapsible grouped sections** (`egui::CollapsingHeader`): **Noise**, **Transform**, **Remap**, **Color** — instead of today's flat list. Sections remember open/closed.
2. **Tidy rows** via `egui::Grid` (label → control aligned columns) instead of default vertical sprawl.
3. **Layer rows:** accent highlight on the selected row; **visibility as an eye toggle** (icon/glyph) rather than a bare checkbox; blend as a compact combo; clearer Add/Dup/Delete/▲▼ affordances (Delete tinted `danger`).
4. **Gradient editor:** selected stop handle drawn in the accent; bar framed to the theme. (Logic unchanged from cycle ③.)
5. fps/ms readout relocated to the top bar.

## Scope

**In:** `theme.rs` (dark+light Visuals from v2 tokens) + apply/toggle; top bar (title/fps/resolution/seed/theme-toggle); Properties collapsible grouped sections + `Grid` rows; layer-row polish (accent highlight, eye toggle, danger Delete); gradient/handle accent touch. All in `app.rs`/new `theme.rs`.
**Deferred / untouched:** the raymarch/generation/gradient LOGIC (cycles ①–③); drag-reorder; presets/export UI (their cycles); animation UI (cycle ④, lands in this style after).

## Testing

- **Unit (Rust, in-sandbox):** pure token→`Color32` conversion (hex `#rrggbb` → `Color32`) + a couple palette-sanity asserts; theme struct selection (dark vs light returns the right accent). egui rendering itself isn't headless-testable — visual is the user's run.
- **Compile:** both `cargo check` (native + wasm32), `cargo clippy -D warnings`, `cargo test`. `naga` unaffected (no shader change) but run it.
- **User run:** the UI reads as v2's dark pro tool (or light on toggle); Properties grouped + tidy; layer rows/eye/accent; fps in the top bar; nothing rendering/authoring regressed.

## Success criteria

- v3 visually matches v2's dark pro-tool language (themed panels/widgets/accent), with a working light/dark toggle; Properties is grouped + tidy; the top bar hosts title/fps/resolution/seed/theme; layer rows are polished. Cycles ①–③ behavior unchanged.
- Pure theme-helper tests + both `cargo check` + clippy green.

## Risks

- **egui theming is approximate** — egui `Visuals` ≠ CSS; the match is "reads like v2," not pixel-identical. Reconcile `Visuals` field names against installed egui 0.35 via `cargo check`.
- **Layout churn** touching `app.rs` heavily — but presentation-only; keep the state/logic wiring from cycle ③ intact (guard against accidentally changing `mark_dirty`/regen behavior).
- egui `CollapsingHeader`/`Grid` id management (stable ids per section/row).

## Deferred / future

Drag-reorder; presets/export UI; the animation controls (cycle ④); per-widget pixel-tuning; custom fonts if the system font drifts from v2.
