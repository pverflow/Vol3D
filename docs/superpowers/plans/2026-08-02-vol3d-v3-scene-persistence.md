# Vol3D v3 — Scene Persistence (save-as-default) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Save the current scene and auto-load it on startup (single default slot), so the user's setup persists. Web → localStorage; native → a JSON file. Corrupt/absent → fall back to the demo scene.

**Spec:** `docs/superpowers/specs/2026-08-02-vol3d-v3-scene-persistence-design.md`.

**Tech Stack:** Rust 1.97, `eframe`/`egui` `=0.35.0`, `wgpu =29.0.4`, `serde`+`serde_json` (new), `web-sys` (localStorage). All under `v3/`.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green. `naga` unaffected (no shader change).
- **Corrupt/absent/old saved data MUST fall back to `demo_scene()` — never panic.** No auto-save on every edit (explicit Save-as-default only). Only the authored `LayerDesc` is serialized (never `GpuLayer`). No change to generation/render/cache.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/Cargo.toml            # MOD: + serde (derive), serde_json; web-sys features Window,Storage
v3/src/layer.rs          # MOD: derive Serialize/Deserialize on LayerDesc, NoiseType, BlendMode, DistortionType, ParamField
v3/src/ramp.rs           # MOD: derive Serialize/Deserialize on ColorRamp, RampStop
v3/src/anim_timeline.rs  # MOD: derive on Keyframe; Timeline::to_entries()/from_entries(); TrackEntry
v3/src/persistence.rs    # NEW: SceneFile struct; save_scene/load_scene (cfg web/native)
v3/src/main.rs           # MOD: mod persistence;
v3/src/app.rs            # MOD: to_scene/apply_scene/save_current_scene/load_default_scene; top-bar buttons; startup load in new()
v3/RUN.md                # MOD (Task 4)
```

---

## Task 1: serde on authored types + SceneFile + Timeline entries

**Files:** `Cargo.toml`, `layer.rs`, `ramp.rs`, `anim_timeline.rs`, `persistence.rs` (new, struct only), `main.rs`.

**Interfaces produced:**
- `#[derive(Serialize, Deserialize)]` on `LayerDesc`, `NoiseType`, `BlendMode`, `DistortionType`, `ParamField` (layer.rs); `ColorRamp`, `RampStop` (ramp.rs); `Keyframe` (anim_timeline.rs).
- `anim_timeline::TrackEntry { pub layer_id: u64, pub field: ParamField, pub keys: Vec<Keyframe> }` (+ Serialize/Deserialize); `Timeline::to_entries(&self) -> Vec<TrackEntry>`; `Timeline::from_entries(Vec<TrackEntry>) -> Timeline`.
- `persistence::SceneFile { version:u32, layers:Vec<LayerDesc>, next_layer_id:u64, dims:[u32;3], global_seed:<match app>, loop_seconds:f32, evolutions:f32, fps:u32, interp:bool, tracks:Vec<TrackEntry>, camera:CamState }` with `#[derive(Serialize, Deserialize)]` + `#[serde(default)]` on the struct; `CamState { yaw:f32, pitch:f32, distance:f32 }`.

- [ ] **Step 1: deps** — add to `Cargo.toml`: `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"` (in `[dependencies]`); add `"Window", "Storage"` to the wasm `web-sys` features (`web-sys = { version = "0.3", features = ["Window","Storage"] }`).
- [ ] **Step 2: derives** — add `Serialize, Deserialize` derives to the types listed above. (`ParamField` `#[repr(u8)]` enum serializes by variant name — fine.) `cargo check` catches any nested type still missing a derive.
- [ ] **Step 3: TrackEntry + Timeline (TDD)** — add `TrackEntry`, `to_entries` (iterate `tracks`, decode `u8`→`ParamField`, clone keys), `from_entries` (insert each into a fresh `BTreeMap` keyed `(layer_id, field as u8)`). Test:
```rust
#[test] fn timeline_entries_roundtrip() {
    let mut tl = Timeline::default();
    tl.upsert(7, ParamField::Opacity, 0.0, 0.2);
    tl.upsert(7, ParamField::Opacity, 1.0, 0.8);
    tl.upsert(9, ParamField::ScaleX, 0.5, 3.0);
    let back = Timeline::from_entries(tl.to_entries());
    assert_eq!(back.hash(), tl.hash());
}
```
- [ ] **Step 4: SceneFile round-trip (TDD)** — create `persistence.rs` with `SceneFile`/`CamState`; `mod persistence;` in main.rs. Test (in persistence.rs):
```rust
#[test] fn scenefile_json_roundtrip() {
    let s = SceneFile { version:1, layers: crate::layer::demo_scene(), next_layer_id: 3,
        dims:[64,64,256], global_seed: Default::default(), loop_seconds:4.0, evolutions:0.0,
        fps:30, interp:false, tracks: vec![], camera: CamState{yaw:0.3,pitch:0.5,distance:3.0} };
    let js = serde_json::to_string(&s).unwrap();
    let back: SceneFile = serde_json::from_str(&js).unwrap();
    assert_eq!(back.dims, s.dims); assert_eq!(back.layers.len(), s.layers.len());
}
#[test] fn garbage_json_is_none_not_panic() {
    assert!(serde_json::from_str::<SceneFile>("{ not valid").is_err());
}
```
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): serde on authored scene types + SceneFile + Timeline entries (round-trip tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: platform storage (localStorage / file)

**Files:** `v3/src/persistence.rs`.

**Interfaces produced:** `persistence::save_scene(json: &str) -> bool`; `persistence::load_scene() -> Option<String>`.

- [ ] **Step 1: wasm storage** — `#[cfg(target_arch="wasm32")]`:
```rust
fn storage() -> Option<web_sys::Storage> { web_sys::window()?.local_storage().ok()? }
pub fn save_scene(json: &str) -> bool { storage().map(|s| s.set_item("vol3d_scene_v1", json).is_ok()).unwrap_or(false) }
pub fn load_scene() -> Option<String> { storage()?.get_item("vol3d_scene_v1").ok()? }
```
- [ ] **Step 2: native storage** — `#[cfg(not(target_arch="wasm32"))]`: path = `$HOME/.vol3d/scene.json` (create the dir; fall back to `./vol3d_scene.json` if `HOME` unset). `save_scene` writes (create dir + `fs::write`, return `is_ok()`); `load_scene` = `fs::read_to_string(path).ok()`. No panics on IO error (return false/None).
- [ ] **Step 3: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): scene storage — localStorage (web) + ~/.vol3d/scene.json (native)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: app wiring — save/apply/load + UI + startup

**Files:** `v3/src/app.rs`.

**Interfaces produced:** `impl Vol3dApp { fn to_scene(&self) -> SceneFile; fn apply_scene(&mut self, s: SceneFile); fn save_current_scene(&self); fn load_default_scene() -> Option<SceneFile>; }`

- [ ] **Step 1: `to_scene`** — build `SceneFile` from `self` (layers, next_layer_id, dims, global_seed, loop_seconds, evolutions, fps, interp, `self.timeline.to_entries()`, `CamState` from `self.cam.{yaw,pitch,distance}`). `version: 1`.
- [ ] **Step 2: `apply_scene`** — overwrite `self.layers/dims/global_seed/loop_seconds/evolutions/fps/interp`; `self.timeline = Timeline::from_entries(s.tracks)`; `self.cam.{yaw,pitch,distance} = s.camera.*`; set `self.next_layer_id = s.next_layer_id.max(layers' max id + 1)` (never reuse an id); then `self.recompute_frame_count(); self.cache_stale = true; self.dirty = true;` (force a regen + rebake). Guard: if `s.layers` is empty, keep the demo (don't apply an empty scene).
- [ ] **Step 3: save/load helpers** — `save_current_scene`: `if let Ok(js) = serde_json::to_string(&self.to_scene()) { persistence::save_scene(&js); }`. `load_default_scene() -> Option<SceneFile>`: `let js = persistence::load_scene()?; serde_json::from_str(&js).ok()`.
- [ ] **Step 4: startup load** — in `Vol3dApp::new(cc)`, after building the default app, `if let Some(s) = Self::load_default_scene() { app.apply_scene(s); }`.
- [ ] **Step 5: UI buttons** — in the top bar, add **"💾 Save as default"** (`if clicked → self.save_current_scene()`) and **"↺ Reset"** (`if clicked → self.apply_scene(default_scene_file())` where `default_scene_file()` builds a `SceneFile` from `layer::demo_scene()` + the constructor defaults — or simpler, reset the relevant fields to `Default::default()`'s scene values + `demo_scene()`). Keep them compact.
- [ ] **Step 6: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): Save-as-default + Reset + auto-load saved scene on startup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document **Save as default** (persists your current scene — layers, box dims, colors, keyframes, camera) + **Reset** (back to the demo), and that a saved scene **auto-loads on startup** (web = browser localStorage; native = `~/.vol3d/scene.json`). Ask the user to report: build a scene → Save as default → reload/relaunch → it comes back; Reset reverts to demo; first run (no data) shows the demo.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): scene persistence run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** serde on authored types + SceneFile + Timeline entries (T1) ✓; storage web/native (T2) ✓; to_scene/apply_scene/save/load + startup + UI (T3) ✓; graceful fallback (parse→None→demo, empty-guard) (T1 test, T3 S2) ✓; GPU run (T4) ✓; no GpuLayer serialized / no shader change ✓.
**Placeholder scan:** concrete code + tests; the only "match app" is `global_seed`'s type (implementer reads it) — a lookup.
**Type consistency:** `SceneFile`/`CamState` (T1) built by `to_scene`/consumed by `apply_scene` (T3); `Timeline::to_entries/from_entries` + `TrackEntry` (T1) used in to/apply (T3); `save_scene/load_scene(String)` (T2) used by `save_current_scene/load_default_scene` (T3).
