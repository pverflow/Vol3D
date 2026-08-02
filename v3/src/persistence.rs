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
