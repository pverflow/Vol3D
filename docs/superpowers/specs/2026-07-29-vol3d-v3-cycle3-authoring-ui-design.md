# Vol3D v3 — Cycle ③ Authoring UI (egui, vertical slice) — Design

**Date:** 2026-07-29
**Status:** Approved (user delegated the two open calls to me; proceed to plan + build).
**Parent:** v3 direction spec; builds on cycle ② (generation port, GPU-confirmed).

## Goal

Replace cycle ②'s hardcoded demo scene + 3 throwaway sliders with a **real interactive egui authoring UI**, so the user builds and colors multi-layer scenes themselves. Vertical slice: interactive layers panel + per-layer properties (starter noise set) + a **custom color gradient editor**, driving the existing GPU compute generation.

## Architecture (egui immediate-mode)

- **App state** (`Vol3dApp`): `layers: Vec<LayerDesc>` (cycle-②'s ergonomic layer), `selected: usize`, `resolution: u32`, `global_seed: f32`, and regen bookkeeping (`dirty: bool`, `last_edit_time: f64`). egui widgets mutate this each frame; a change sets `dirty` + stamps `last_edit_time = ctx.input(|i| i.time)`. The 3 demo sliders are removed.
- **Panels:** `SidePanel::left` = **Layers**; `SidePanel::right` = **Properties (selected layer)**; `CentralPanel` = the raymarch viewport (embed unchanged from cycle ①/②).
- **Regen (debounced):** in `update()`, if `dirty && (now - last_edit_time) > REGEN_DEBOUNCE (~0.12s)`, clear `dirty` and mark a `needs_regen` that the raymarch callback's `prepare` consumes (repack layers → build LUT → `generate()` → rebuild raymarch bind group, exactly as cycle ②). `request_repaint()` while `dirty` so the debounce actually fires. Dragging stays smooth; the viewport catches up ~120ms after the user pauses. No per-frame full-res regen. (The reduced-res drag proxy — v2's approach — stays deferred.)

## Components

### Layers panel (left)
- One row per layer, in stack order: a click-to-select name label (highlight `selected`), a visibility checkbox (`visible`), a blend-mode `ComboBox`.
- Buttons: **Add** (new default layer, selected), **Duplicate** (copy selected), **Delete** (remove selected; keep `selected` valid), **Move up / Move down** (reorder selected; button-based — drag-reorder deferred).
- All layer-list mutations go through pure helpers (unit-tested) that keep `selected` in range.

### Properties panel (right, for `layers[selected]`)
- **Noise type** `ComboBox` — starter set only: Value, Perlin, Simplex, FBM, SdfSphere (matches cycle ②'s ported set).
- **Transform:** scale (3 `DragValue`), rotation degrees (3), offset (3).
- **amplitude**, **opacity** (0..1), **invert** (checkbox), **blend mode** `ComboBox`.
- **Remap:** input min/max, output min/max (`DragValue`s).
- **Conditional:** FBM params (octaves, persistence, lacunarity, base-noise combo) shown when type=FBM; SDF params (radius, softness, height) shown when type=SdfSphere.
- **Color:** the gradient editor (below).

### Color gradient editor (custom egui widget — the notable build)
- Paint the layer's `ColorRamp` as a horizontal bar (sample stops across the width; show alpha via a checker backdrop).
- Draggable **stop handles** along the bar (drag = change `t`, clamped, re-sorted); **click empty bar** = add a stop at that `t` (color sampled from the current ramp there); **selected stop** → egui `color_edit_button_srgba` for RGB+alpha; **remove** selected stop (button; keep ≥1 stop).
- Every edit updates `layers[selected].color_ramp` → dirty.
- All stop math (add / move+clamp+sort / remove / sample-at-t) lives in **pure helper functions**, unit-tested; only the painting + pointer handling is egui-side.

## Scope

**In:** layers CRUD + reorder + select + visibility + blend; properties for the starter noise set (type, transform, amplitude, opacity, invert, blend, remap in/out ranges, FBM/SDF params); the custom color gradient editor; resolution picker + global seed; debounced regen.

**Deferred (later cycles/tasks):** bezier remap + feather curve editors, feather controls, presets save/load, animation UI, cutoff/contrast preview shaping, solo/lock, drag-reorder, the non-starter noise/SDF types in the picker, the reduced-res drag proxy, camera/preview-mode chrome beyond the existing orbit.

## Interaction with existing code

- Reuses cycle ②'s `LayerDesc`/packer/`GpuLayer`/`build_ramp_lut_atlas`/`GenParams` and the `VolumeGen::generate(...)` signature + the raymarch embed. Only `app.rs` (UI + state) and a new UI module grow; `render/*` and `shaders/*` are essentially unchanged (the callback's `prepare` already regenerates on dirty — cycle ③ just drives `dirty` from real widgets + debounce).
- Native + WebGPU from one codebase; both `cargo check` gates stay green.

## Testing

- **Unit (Rust, in-sandbox):** layer-list ops (`add`/`duplicate`/`delete`/`move_up`/`move_down` keep `selected` valid and reorder correctly); gradient stop math (`add_stop` samples current color, `move_stop` clamps+re-sorts, `remove_stop` keeps ≥1, `sample_at`); debounce predicate (`now - last_edit > threshold`). These are pure functions — the whole point of factoring UI logic out of the egui closures.
- **Compile/shader:** both `cargo check` (native + wasm32), `cargo clippy -D warnings`, `naga` (shaders unchanged but validate).
- **Interaction/visual:** the user's GPU run — build a multi-layer scene, edit ramps live, confirm vivid color + reactivity + reorder/visibility.

## Success criteria

- The user can, interactively: add/remove/duplicate/reorder layers, pick each layer's noise type + transform + blend + remap, and **edit each layer's color ramp with the gradient editor** — and see the volume regenerate (debounced) with vivid, self-chosen multi-layer color, native + WebGPU.
- Pure UI-logic unit tests + both `cargo check` + clippy + naga green.
- No regression to cycle ①/② rendering; generation/shaders unchanged.

## Risks

- **Custom gradient widget** in egui immediate mode — pointer/coordinate/DPI handling for the bar + stop handles is the main effort; factoring stop math into tested pure fns de-risks the logic, leaving only the paint/hit-test in egui.
- **Regen cost at high res** — mitigated by the ~120ms debounce + resolution picker; the drag proxy remains the deferred escalation if 256³ authoring still lags.
- **egui two-side-panel + viewport layout / version churn** — pin egui 0.35; reconcile any widget API via `cargo check`.

## Deferred / future

Bezier curve editors, feather, presets, animation UI (cycle ④), cutoff/contrast, drag-reorder, drag proxy, remaining noise/SDF library, export (⑤), packaging (⑥).
