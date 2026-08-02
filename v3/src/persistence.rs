// Scene file format (cycle: scene-persistence, task 1): a serde-friendly
// snapshot of everything `Vol3dApp` needs to reconstruct a scene — authored
// layers, timeline tracks (flattened via `anim_timeline::TrackEntry`), and
// camera pose. Struct only here; reading/writing to disk/localStorage and
// wiring into `Vol3dApp` are later tasks.
//
// `SceneFile`/`CamState` aren't constructed by non-test code yet (that's the
// save/load wiring of a later task) — `allow(dead_code)` until then, same as
// `layer.rs`/`anim_timeline.rs`.
#![allow(dead_code)]

use crate::anim_timeline::TrackEntry;
use crate::layer::LayerDesc;

/// Camera pose subset of `camera::OrbitCamera` worth persisting (distance/
/// yaw/pitch fully describe the orbit; no persisted field for aspect/steps —
/// those are derived at render time, not authored state).
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct CamState {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}

impl Default for CamState {
    fn default() -> Self {
        Self {
            yaw: 0.8,
            pitch: 0.5,
            distance: 3.0,
        }
    }
}

/// On-disk/serialized scene snapshot. `#[serde(default)]` on the struct means
/// any field missing from older/hand-edited JSON falls back to `Default`
/// rather than failing to parse — only malformed JSON (not merely
/// incomplete) errors out (see `garbage_json_is_none_not_panic`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SceneFile {
    pub version: u32,
    pub layers: Vec<LayerDesc>,
    pub next_layer_id: u64,
    pub dims: [u32; 3],
    pub global_seed: f32,
    pub loop_seconds: f32,
    pub evolutions: f32,
    pub fps: u32,
    pub interp: bool,
    pub tracks: Vec<TrackEntry>,
    pub camera: CamState,
}

impl Default for SceneFile {
    fn default() -> Self {
        Self {
            version: 1,
            layers: Vec::new(),
            next_layer_id: 0,
            dims: [128, 128, 128],
            global_seed: 0.0,
            loop_seconds: 4.0,
            evolutions: 0.0,
            fps: 30,
            interp: false,
            tracks: Vec::new(),
            camera: CamState::default(),
        }
    }
}

/// Web: persist to `localStorage` under a fixed key. Native: persist to a
/// file under `$HOME/.vol3d/` (falling back to the cwd if `HOME` is unset).
/// Same two-function signature on both targets so callers (task 3) don't
/// need `cfg` of their own.
const STORAGE_KEY: &str = "vol3d_scene_v1";

#[cfg(target_arch = "wasm32")]
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

#[cfg(target_arch = "wasm32")]
pub fn save_scene(json: &str) -> bool {
    storage()
        .map(|s| s.set_item(STORAGE_KEY, json).is_ok())
        .unwrap_or(false)
}

#[cfg(target_arch = "wasm32")]
pub fn load_scene() -> Option<String> {
    storage()?.get_item(STORAGE_KEY).ok()?
}

#[cfg(not(target_arch = "wasm32"))]
fn scene_path() -> std::path::PathBuf {
    match std::env::var("HOME") {
        Ok(home) => std::path::Path::new(&home)
            .join(".vol3d")
            .join("scene.json"),
        Err(_) => std::path::PathBuf::from("./vol3d_scene.json"),
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn save_scene(json: &str) -> bool {
    let path = scene_path();
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
    }
    std::fs::write(path, json).is_ok()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn load_scene() -> Option<String> {
    std::fs::read_to_string(scene_path()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scenefile_json_roundtrip() {
        let s = SceneFile {
            version: 1,
            layers: crate::layer::demo_scene(),
            next_layer_id: 3,
            dims: [64, 64, 256],
            global_seed: Default::default(),
            loop_seconds: 4.0,
            evolutions: 0.0,
            fps: 30,
            interp: false,
            tracks: vec![],
            camera: CamState {
                yaw: 0.3,
                pitch: 0.5,
                distance: 3.0,
            },
        };
        let js = serde_json::to_string(&s).unwrap();
        let back: SceneFile = serde_json::from_str(&js).unwrap();
        assert_eq!(back.dims, s.dims);
        assert_eq!(back.layers.len(), s.layers.len());
    }

    #[test]
    fn garbage_json_is_none_not_panic() {
        assert!(serde_json::from_str::<SceneFile>("{ not valid").is_err());
    }
}
