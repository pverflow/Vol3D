# Vol3D v3 — Animation Timeline SP2: Visual Timeline Panel — Design

**Date:** 2026-08-03
**Status:** Approved (user picked SP2 next). Continues the phased "full pro timeline" (SP1 foundation done → **SP2 visual panel** → SP3 value curves → SP4 polish).
**Parent:** timeline SP1 (`anim_timeline::Timeline` keyframe tracks + the `◆` stopwatch + phase playhead).

## Goal

A **visual timeline panel** so keyframes are seen + edited directly instead of only via the per-param stopwatch: a **ruler** (seconds), a **draggable playhead**, one **lane per animated track**, and **keyframe dots** you click to select, drag horizontally to retime, and delete. Makes the SP1 keyframe system usable at a glance.

## Layout (in the bottom `animation_panel`, below the Play/Loop/FPS/Phase controls)

- A **ruler** strip across the panel width: phase `0→1` maps to `0→loop_seconds`; a few tick labels (`0s`, mid, `{loop_seconds}s`).
- A **playhead**: a vertical line at `x = phase * width` spanning the ruler + all lanes; **drag it to scrub** (drives `sync_playhead` + `mark_dirty`, like the phase slider).
- One **lane** per animated track (from `timeline.to_entries()`), stacked, fixed height (~18 px), inside a vertical `ScrollArea` (max ~160 px) so many tracks scroll. Left gutter = a **label** `L{layer_index}·{ParamField::label}` (layers have no name in v3 → use the index; look up `layers.iter().position(|l| l.id == id)`; `?` if missing).
- **Keyframe dots** on each lane at `x = key.phase * lane_width` (small filled circles). The **selected** dot is highlighted (larger/ringed).

Painted with the egui `Painter` (lines/circles/text) over a rect allocated with `Sense::click_and_drag`.

## Interactions

- **Playhead drag:** dragging in the ruler/empty area (or on the playhead line) sets `phase = clamp(pointer_x / width, 0, 1)` → `sync_playhead(phase)` + `mark_dirty`.
- **Select a keyframe:** click near a dot (within a few px) → `selected_key = Some((layer_id, field, key_phase))`.
- **Drag a keyframe (retime):** dragging a selected/grabbed dot horizontally → new phase `clamp(pointer_x/lane_width, 0, 1)` → `timeline.move_key(id, field, old_phase, new_phase)` + update `selected_key` to the new phase + `mark_dirty` (re-bake). Vertical drag ignored (value editing is SP3's curve editor).
- **Delete:** `Delete`/`Backspace` (when a key is selected and the timeline has focus) or a small "🗑 key" button → `timeline.remove_key(id, field, phase)` (+ if the track empties, it's removed) + clear selection + `mark_dirty`.
- **Add** stays via the SP1 stopwatch `◆` (SP2 doesn't add a new add-path; optional double-click-lane-to-add is deferred to keep scope tight).

## New `Timeline`/`Track` methods (`anim_timeline.rs`)

- `Track::remove_at(&mut self, phase: f32) -> bool` (remove the key within `1e-4` of `phase`).
- `Track::value_at_key(&self, phase: f32) -> Option<f32>` (the exact key's value, for move).
- `Timeline::remove_key(&mut self, id, field: ParamField, phase: f32)` — `track.remove_at`; if the track is now empty, drop it (so `is_animated` flips false + the `◆` un-fills).
- `Timeline::move_key(&mut self, id, field: ParamField, from: f32, to: f32)` — read the key's value, `remove_at(from)`, `upsert(to, value)` (upsert keeps sorted + dedups a collision at `to`).

## State (`Vol3dApp`)

- `selected_key: Option<(u64, layer::ParamField, f32)>` (id, field, phase of the selected keyframe). Cleared on delete, on layer delete of that id, or when it no longer exists.

## Scope

**In:** the timeline panel (ruler + playhead + lanes + dots), select/drag-retime/delete keyframes, playhead scrub; `Timeline`/`Track` edit helpers; `selected_key` state.
**Out:** per-keyframe value editing / bezier curves (SP3); vertical drag; multi-select + box-select + snapping (SP4); double-click-to-add; color/enum lane rendering; renaming layers.

## Testing

- **Unit (Rust):** `Track::remove_at` (removes the right key, tolerance, false if none); `value_at_key`; `Timeline::remove_key` (empties → track dropped → `is_animated` false); `Timeline::move_key` (key moves to the new phase, value preserved, stays sorted, collision at `to` dedups). `hash()` changes after a move/remove.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`. (No shader change; `naga` unaffected.)
- **User GPU run:** animated params appear as lanes with dots at the right positions; dragging the playhead scrubs; clicking a dot selects it; dragging a dot retimes the keyframe (and playback reflects it); Delete removes it (and the `◆` un-fills when its last key goes); non-animated scenes show an empty/absent timeline; the panel scrolls with many tracks.

## Success criteria

- A visual timeline with lanes/dots/ruler/playhead; keyframes selectable, drag-to-retime, deletable; playhead scrub; edits re-bake and match the SP1 keyframe data; both `cargo check` + clippy + tests green; no regression to SP1 keyframing.

## Risks

- **egui hit-testing** (dot pick vs playhead vs empty) — define clear priority (nearest dot within radius wins; else playhead/scrub); reviewer checks a drag can't both scrub and retime.
- **move_key value/sort** — read value before removing; upsert re-sorts; unit-tested.
- **Coordinate mapping** — phase↔x consistent between paint + hit-test (one `phase_to_x`/`x_to_phase` pair); off-by-one puts dots where you can't grab them.
- **Panel height** — the bottom panel must accommodate the scroll area without squashing the existing controls; use a bounded `ScrollArea`.
