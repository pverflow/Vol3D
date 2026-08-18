# Vol3D v3 — Animation Timeline SP3: Value & Interpolation — Design

**Date:** 2026-08-03
**Status:** Approved (continue the phased timeline; SP1 foundation + SP2 visual panel done → SP3).
**Parent:** timeline SP1/SP2 (`anim_timeline` tracks + the visual panel with `selected_key`).

## Goal

Give keyframes **per-key interpolation modes** and **direct value editing** — the core of "value curves." Today every segment is linear and you can only change a key's value via the param slider at that phase. SP3: pick **Linear / Hold / Ease** per keyframe (how it eases into the *next* key), and edit the **selected key's value** right in the timeline. (Full bezier tangent-handle dragging needs a value-vs-time graph — deferred to a later refinement; Ease covers the common "smooth" need.)

## Data model (`anim_timeline.rs`)

- **`Interp`** enum: `Linear` (default), `Hold` (step — value holds until the next key), `Ease` (smoothstep in/out). `#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]` with `#[default] Linear`.
- **`Keyframe`** gains `#[serde(default)] pub interp: Interp` (old saved scenes without the field → `Linear`, so they load + play unchanged).
- **`Track::sample`** — in the straddling segment `w[0]..w[1]`, remap `t` by **`w[0].interp`** (the left key's outgoing mode): `Linear → t`, `Hold → 0.0` (stays at `w[0].value`), `Ease → t*t*(3.0 - 2.0*t)` (smoothstep). Then `w[0].value + (w[1].value - w[0].value) * remapped`. Ends still hold (before first / after last). At all-`Linear` this is byte-identical to today.
- **Preserve interp through edits:** `Track::upsert(phase, value)` keeps an existing key's `interp` when it only updates the value (new keys default `Linear`). `Timeline::move_key` (SP2) must carry `interp` too (read the whole `Keyframe`, remove, re-insert at the new phase with the same value+interp). Add `Track::key_at(phase) -> Option<Keyframe>` + a full-`Keyframe` insert helper for this.
- **Edit helpers:** `Track::set_value_at(phase, v)` (update the key's value, keep interp), `Track::set_interp_at(phase, interp)`, `Track::interp_at(phase) -> Option<Interp>`; `Timeline::set_key_value(id, f, phase, v)`, `Timeline::set_key_interp(id, f, phase, interp)`, `Timeline::key_interp(id, f, phase) -> Option<Interp>` (thin wrappers).

## UI (`app.rs`, timeline panel)

When `selected_key` is `Some`, in the panel's control row (next to the existing 🗑 button), show for that key:
- **Value:** a `DragValue` (speed ~0.01) bound to the key's current value (`timeline.value_at_key`) → on change `timeline.set_key_value(...)` + `mark_dirty`.
- **Interp:** three small toggle buttons **Lin / Hold / Ease** (the active one highlighted, from `timeline.key_interp(...)`) → on click `timeline.set_key_interp(...)` + `mark_dirty`.
- Optionally reflect the mode in the dot shape/color (small nicety; e.g. Hold = square, Ease = ringed) — cheap in the paint loop, or skip.

## Scope

**In:** `Interp` (Linear/Hold/Ease) per keyframe; `Track::sample` honoring it; interp preserved through `upsert`/`move_key`; value + interp edit helpers; selected-key value field + interp buttons; serde (old saves default Linear).
**Out:** bezier tangent handles + a value-vs-time graph editor (later); vertical-drag-to-edit-value (the field is precise); per-track (vs per-key) modes.

## Testing

- **Unit (Rust):** `Track::sample` with a Hold key (mid-segment == left value), an Ease key (mid == smoothstep(0.5)=0.5 of the delta, and quarter/three-quarter match smoothstep), Linear unchanged; `upsert` preserves interp on value-replace; `move_key` preserves value **and** interp; `set_value_at`/`set_interp_at`/`interp_at`; serde round-trip of a Keyframe with `interp=Ease`; a Keyframe JSON missing `interp` deserializes to `Linear`.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`. (No shader change.)
- **User GPU run:** set a param's keyframe to **Hold** → it steps (no ramp) until the next key; **Ease** → smooth in/out vs Linear's constant slope; edit a selected key's **value** from the timeline → playback reflects it; retiming a key (SP2 drag) keeps its interp; a pre-SP3 saved scene loads (all keys Linear) and plays identically.

## Success criteria

- Per-keyframe Linear/Hold/Ease honored by sampling; selected-key value editable in the panel; interp survives retime/value-edit; old saves default Linear + unchanged; both `cargo check` + clippy + tests green; no SP1/SP2 regression.

## Risks

- **upsert/move_key interp preservation** — the SP2 `move_key` currently drops interp (reads only value); must read the full keyframe. Unit-tested.
- **serde back-compat** — `#[serde(default)]` on `Keyframe.interp` so pre-SP3 saved scenes load (test-locked).
- **sample identity** — all-Linear must equal today; `Hold→0`/`Ease→smoothstep` only change non-Linear keys. Reviewer checks the Linear path is unchanged.
