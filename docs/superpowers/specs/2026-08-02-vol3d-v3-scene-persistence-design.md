# Vol3D v3 — Scene Persistence (save-as-default) — Design

**Date:** 2026-08-02
**Status:** Approved (user: use my current settings as the default opening scene — tired of rebuilding it every time).
**Parent:** first of the Presets line; solves "my scene persists" via a single default slot.

## Goal

Let the user **save the current scene** and have it **auto-load on startup**, so their setup persists across reloads/relaunches. Single "default" slot (named presets + import/export are a later step). Web → `localStorage`; native → a JSON file. Graceful: missing/corrupt/old data → fall back to the built-in `demo_scene()` (never crash).

## What's a "scene" (serialized)

A `SceneFile` (serde, JSON) capturing the authored state — **not** transient UI (playhead/playing/hover):
- `version: u32` (=1, for future migration)
- `layers: Vec<LayerDesc>` (all per-layer params incl `id`, noise, distortion, ramp)
- `next_layer_id: u64`
- `dims: [u32;3]`, `global_seed`, `loop_seconds: f32`, `evolutions: f32`, `fps: u32`, `interp: bool`
- `tracks: Vec<TrackEntry>` — the keyframe timeline (see below)
- `camera: CamState { yaw: f32, pitch: f32, distance: f32 }` (restore the view)

## Serialization details

- Derive `serde::{Serialize, Deserialize}` on the authored types: `LayerDesc`, `NoiseType`, `BlendMode`, `DistortionType`, `ramp::ColorRamp`, `ramp::RampStop`, `anim_timeline::{Keyframe}`, `layer::ParamField`. (NOT `GpuLayer` — that's the packed GPU form; only the authored `LayerDesc` is saved.)
- **Timeline** is `BTreeMap<(u64,u8), Track>` — JSON can't key a map on a tuple, so serialize as `Vec<TrackEntry { layer_id: u64, field: ParamField, keys: Vec<Keyframe> }>`. Add `Timeline::to_entries()` / `Timeline::from_entries(Vec<TrackEntry>)`.
- Robustness: `#[serde(default)]` on `SceneFile` fields so a missing field falls back to a sane default; a parse error → `None` → demo scene. New deps: `serde = { version="1", features=["derive"] }`, `serde_json = "1"` (both wasm-compatible).

## Storage (`src/persistence.rs`, new)

- `save_scene(json: &str) -> bool` / `load_scene() -> Option<String>` (raw JSON), platform-split by `cfg`:
  - **wasm:** `web_sys::window()?.local_storage().ok()??` → `set_item/get_item("vol3d_scene_v1", …)`. Add web-sys features `Window`, `Storage`.
  - **native:** a file at `$HOME/.vol3d/scene.json` (create the dir; fall back to `./vol3d_scene.json` if `$HOME` unset) via `std::fs`.
- `Vol3dApp`: `fn save_current_scene(&self)` (build `SceneFile` → `serde_json::to_string` → `persistence::save_scene`); `fn load_default_scene() -> Option<SceneFile>` (`persistence::load_scene()` → `serde_json::from_str` → `Some`, or `None` on any error); `fn apply_scene(&mut self, s: SceneFile)` (overwrite layers/dims/globals/timeline/camera; recompute derived state — `recompute_frame_count`, `cache_stale=true`, `mark_dirty`, rebuild `next_layer_id`).

## Startup + UI (`app.rs`, `main.rs`)

- **Startup:** in `Vol3dApp::new(cc)`, after `Default::default()`, `if let Some(s) = Self::load_default_scene() { app.apply_scene(s); }` — so a saved scene opens; else the demo scene (unchanged first-run).
- **UI (top bar):** a **"Save as default"** button → `self.save_current_scene()` (persists the current scene). A **"Reset to demo"** button → `self.apply_scene(SceneFile::from(demo default))` (or reload `demo_scene()` + defaults) so the user can revert. (No auto-save on every edit — explicit, so experimental states don't stick.)

## Scope

**In:** `SceneFile` serde (authored state incl timeline + camera); platform storage (localStorage / file); Save-as-default + Reset buttons; auto-load on startup; graceful fallback.
**Out:** named/multiple presets; import/export to a file the user picks (native file dialog); versioned migration logic (just a version field + graceful fallback for now); auto-save-on-edit.

## Testing

- **Unit (Rust):** `SceneFile` round-trips (`to_string`→`from_str` == original) for a demo scene incl a keyframed track; `Timeline::to_entries`/`from_entries` round-trip; a truncated/garbage JSON → `load` returns `None` (no panic); `apply_scene` restores layers/dims/globals/timeline and rebuilds `next_layer_id` past the max layer id.
- **Both targets:** `cargo check` native + wasm32 (web-sys Storage feature present), `cargo clippy -D warnings`, `cargo test`. `naga` unaffected.
- **User GPU run:** build a scene → **Save as default** → reload the page / relaunch → the scene (layers, box dims, colors, keyframes, camera) comes back; **Reset to demo** reverts; a first-run (no saved data) still shows the demo scene.

## Success criteria

- Save-as-default persists the full authored scene; it auto-loads on startup; Reset reverts; corrupt/absent data falls back to demo without crashing; both `cargo check` + clippy + tests green; no regression to generation/render.

## Risks

- **serde on many types** — mechanical; a missed derive is a compile error (caught by `cargo check`). `ParamField`/enums serialize by variant name (stable).
- **Timeline tuple-key** — handled via `TrackEntry` Vec form; round-trip tested.
- **Untrusted/old JSON** — `#[serde(default)]` + parse-error→`None`→demo; never crash. (No secrets involved; localStorage is per-origin.)
- **Native path** — `$HOME/.vol3d/`; document it; cwd fallback.
- **wasm web-sys Storage feature** — add it; `cargo check --target wasm32` gates it.
