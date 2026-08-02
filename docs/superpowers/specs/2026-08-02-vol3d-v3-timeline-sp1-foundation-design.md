# Vol3D v3 — Animation Timeline SP1: Keyframe Foundation — Design

**Date:** 2026-08-02
**Status:** Approved (user: build a full pro keyframe timeline, phased; SP1 = foundation; animate all scalar floats; evolution becomes opt-in).
**Parent:** builds on the phase clock + fps-driven frame cache (`FrameCache`) + generation. First of 4 sub-projects (SP1 foundation → SP2 visual timeline panel → SP3 value curves → SP4 polish/colors/enums).

## Goal

Make **any per-layer scalar parameter keyframable** along the loop's phase axis, so playback plays a real keyframed animation — and make the built-in phase-shift (`evolutions`) **opt-in** (default off) rather than the only animation. SP1 delivers the working mechanism (data model + CPU evaluation + bake integration + per-param keyframing via a stopwatch toggle). The visual track editor, value curves, and color/enum tracks come in later sub-projects.

## Architecture (the key idea)

The timeline **is** the existing phase axis (`0..1` = one loop). Keyframe interpolation happens **CPU-side, per baked frame**: for frame `i` the bake evaluates every track at `phase = i/N`, producing that frame's scene, then packs + generates it. **No shader change** — it reuses the fps frame-cache and generation exactly. Both keyframe animation and the (optional) domain `evolutions` are pure functions of `phase`, so they compose (frame `i` gets `anim_phase = i/N` for evolution AND evaluated params at `i/N`).

## Data model (`v3/src/anim_timeline.rs`, new)

- **Stable layer IDs.** `LayerDesc` gains `id: u64` (prerequisite — layers are a `Vec` with no stable identity today). A `next_layer_id` counter on `Vol3dApp` assigns IDs in `add_layer`/`duplicate_layer`/`demo_scene`. Tracks reference layers by `id`, surviving reorder/delete. (Duplicate gets a fresh id; its tracks are **not** copied in SP1 — noted as a later nicety.)
- **`ParamField`** — a `#[repr(u8)]`/enum of every animatable per-layer scalar: `Opacity, ScaleX/Y/Z, OffsetX/Y/Z, RotationX/Y/Z, Amplitude, InMin, InMax, OutMin, OutMax, SdfRadius, SdfSoftness, SdfHeight, Persistence, Lacunarity, DistortionStrength, DistortionFrequency, DistortionSwirl, DistortionRotX/Y/Z`. Plus `LayerDesc::get_param(ParamField) -> f32` and `set_param(ParamField, f32)` (two matches; round-trip unit-tested).
- **`Keyframe { phase: f32, value: f32 }`** (`phase` clamped to `[0,1]`).
- **`Track { keys: Vec<Keyframe> }`** kept sorted by `phase`; `sample(phase) -> f32` = **linear** between the two straddling keys, **hold** before the first / after the last, single key → that value. A track always has ≥1 key (removing the last key removes the track).
- **`Timeline { tracks: BTreeMap<(u64, ParamField), Track> }`** with `evaluate_into(&mut [LayerDesc], phase)` (for each track, find the layer by id, `set_param(field, track.sample(phase))`), `upsert(id, field, phase, value)`, `remove(id, field)`, `is_animated(id, field) -> bool`, `remove_layer(id)`, and a stable content `hash()` for cache invalidation.

## Value source-of-truth (how sliders + eval stay consistent)

`LayerDesc` fields always hold the **current-playhead value**: for a non-animated param that's the static authored value; for an animated param it's `track.sample(playhead)`, refreshed whenever the playhead moves (`timeline.evaluate_into(&mut layers, phase)`). So the UI renders `LayerDesc` fields directly, and the **live** generate packs `LayerDesc` as-is. The **bake** re-derives each frame from the tracks (`evaluate_scene_at(i/N)` = clone layers, overwrite animated fields with `sample(i/N)`), independent of the current playhead.

## Bake integration (`render/frame_cache.rs`, `anim.rs`, `app.rs`)

- `FrameCache::bake` currently takes one `layers: &[GpuLayer]` and sets `anim_phase = i/n` per frame. Change it to take **per-frame packed layers** — `frames: &[&[GpuLayer]]` (or a flat `&[GpuLayer]` + `layer_count` stride), one packed set per frame. `app.rs` pre-evaluates the N frames (`evaluate_scene_at(i/N)` → `pack`) and passes them. `anim_phase = i/n` is still set per frame (for evolution). The color LUT atlas is unchanged (colors aren't animated in SP1).
- **`BakeKey`** (`anim.rs`) gains the `Timeline::hash()` so editing a keyframe invalidates the cache and re-bakes.
- **Paused playhead scrub** regenerates the live volume at `evaluate_scene_at(phase)` (via the existing dirty/regen path) so scrubbing shows the animated state.

## Evolution opt-in

`evolutions` default becomes **0.0** (off) — `LayerDesc`/`GenParams` defaults + demo scene. It stays a normal UI control the user can raise for the built-in domain swirl; it is now one *optional* input. (Keyframing global params — evolutions itself, loop — is deferred; SP1 keyframes per-layer scalars.)

## UI (`app.rs`)

- **`anim_param(...)` helper** wrapping each scalar param row: draws a **stopwatch ◆** toggle (filled when animated) + the existing `DragValue`/`Slider`. Behavior: ◆ off→on creates a track with one key at the playhead (current value); ◆ on→off removes the track. While animated, changing the value **upserts a keyframe** at the playhead. Any value/track change routes through the existing `mark_dirty` path (regen + `cache_stale`). Every scalar row in the properties panel (Noise/Transform/Remap/Distortion/SDF params) is wrapped in this helper — centralizing all keyframe logic in one place.
- The existing **Phase slider is the playhead**; moving it calls `timeline.evaluate_into(&mut layers, phase)` so sliders + live volume reflect the animated state. A tiny "N keys" indicator + clear on animated params.

## Scope

**In:** layer IDs; `ParamField` + get/set; `Track`/`Timeline` + linear sample + hash; `evaluate_scene_at`; per-frame bake + `BakeKey` timeline hash; paused-scrub regen; evolution default 0; stopwatch UI on all scalar params.
**Out (later SPs):** visual track lanes / draggable dots (SP2); bezier/hold interpolation + curve editor (SP3); color-ramp + enum (noise-type) tracks, multi-select, snapping, copy-tracks-on-duplicate, global-param (evolutions/loop) keyframing (SP4).

## Testing

- **Unit (Rust):** `Track::sample` (empty/one-key/linear-mid/hold-before/hold-after/seam); `ParamField` get/set round-trip for every variant; `Timeline::evaluate_into` writes the right layer/field; `evaluate_scene_at` independent of current field values; `Timeline::hash` changes iff tracks change; layer-id assignment unique.
- **Shader:** unchanged; `naga` still validates (no shader edits expected).
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** keyframe a param (◆, move playhead, change value → key) and Play → the value animates over the loop; multiple animated params compose; evolution defaults off and can be re-enabled; scrubbing the playhead shows interpolated state; non-animated scenes unchanged.

## Success criteria

- Any scalar per-layer param can be keyframed and animates on playback (interpolated per baked frame); evolution is opt-in (default 0); editing keyframes re-bakes; playhead scrub shows interpolated state; existing (un-keyframed) scenes render as before; both `cargo check` + naga + clippy + tests green; no regression to generation/compositing/distortion/fps-cache.

## Risks

- **Bake signature change** (per-frame layers) touches `FrameCache::bake` + its one caller — reconcile carefully; the layer count per frame is constant (only values differ). Reviewer verifies frame `i` uses `evaluate_scene_at(i/N)`.
- **Layer-id churn** — IDs must be assigned everywhere a layer is created (add/duplicate/demo) and tracks pruned on delete; a missed site leaks/misroutes tracks. Unit-test id uniqueness; reviewer greps creation sites.
- **UI breadth** — wrapping every scalar row in `anim_param` is broad; keep the helper the single source of keyframe logic so the churn is mechanical.
- **Playhead/field sync** — forgetting to `evaluate_into` on playhead move leaves stale slider/live values; make it one call at the scrub site.
