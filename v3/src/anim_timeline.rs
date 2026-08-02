// Keyframe timeline data model (cycle 4 timeline task 1): pure, no GPU, no UI.
// A `Timeline` holds one `Track` per animated `(layer_id, ParamField)` pair;
// `evaluate_into` samples every track at a phase and writes the result back
// onto the matching `LayerDesc` via `set_param`. Layers are keyed by
// `LayerDesc::id` (not their `Vec` index) so tracks survive reordering.
#![allow(dead_code)]

use crate::anim::fnv1a;
use crate::layer::{LayerDesc, ParamField};
use std::collections::BTreeMap;

/// A single animated value at a point in the loop's `[0, 1)` phase.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Keyframe {
    pub phase: f32,
    pub value: f32,
}

/// Keyframes for one animated field, always kept sorted by `phase`.
#[derive(Clone, Debug, Default)]
pub struct Track {
    keys: Vec<Keyframe>,
}

impl Track {
    /// Linear-interpolate the value at `phase`; holds the first/last key's
    /// value outside the keyed range, and returns `0.0` if there are no keys.
    pub fn sample(&self, phase: f32) -> f32 {
        let ks = &self.keys;
        if ks.is_empty() {
            return 0.0;
        }
        if phase <= ks[0].phase {
            return ks[0].value;
        }
        let last = ks.len() - 1;
        if phase >= ks[last].phase {
            return ks[last].value;
        }
        for w in ks.windows(2) {
            if phase <= w[1].phase {
                let span = (w[1].phase - w[0].phase).max(1e-8);
                let t = ((phase - w[0].phase) / span).clamp(0.0, 1.0);
                return w[0].value + (w[1].value - w[0].value) * t;
            }
        }
        ks[last].value
    }

    /// Replace the key within `1e-5` of `phase`, if any, else insert a new
    /// one — keeping `keys` sorted by phase either way.
    pub fn upsert(&mut self, phase: f32, value: f32) {
        if let Some(existing) = self
            .keys
            .iter_mut()
            .find(|k| (k.phase - phase).abs() < 1e-5)
        {
            existing.value = value;
            return;
        }
        let idx = self.keys.partition_point(|k| k.phase < phase);
        self.keys.insert(idx, Keyframe { phase, value });
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The value of the key at `phase` (within `1e-4`), if one exists —
    /// unlike `sample`, this does not interpolate between keys.
    pub fn value_at_key(&self, phase: f32) -> Option<f32> {
        self.keys
            .iter()
            .find(|k| (k.phase - phase).abs() < 1e-4)
            .map(|k| k.value)
    }

    /// Remove the key at `phase` (within `1e-4`), if any. Returns whether a
    /// key was removed.
    pub fn remove_at(&mut self, phase: f32) -> bool {
        if let Some(i) = self
            .keys
            .iter()
            .position(|k| (k.phase - phase).abs() < 1e-4)
        {
            self.keys.remove(i);
            true
        } else {
            false
        }
    }
}

/// All animated `(layer_id, field)` tracks for a scene. `BTreeMap` keeps
/// iteration order deterministic (by `id` then `field as u8`), which
/// `evaluate_into`/`hash` both rely on.
#[derive(Clone, Debug, Default)]
pub struct Timeline {
    tracks: BTreeMap<(u64, u8), Track>,
}

/// One track's worth of keyframes in a flat, serde-friendly shape — the
/// persistence-file form of a `Timeline`'s otherwise-private
/// `BTreeMap<(u64, u8), Track>` (see `SceneFile::tracks`, `persistence.rs`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TrackEntry {
    pub layer_id: u64,
    pub field: ParamField,
    pub keys: Vec<Keyframe>,
}

impl Timeline {
    pub fn upsert(&mut self, id: u64, f: ParamField, phase: f32, value: f32) {
        self.tracks
            .entry((id, f as u8))
            .or_default()
            .upsert(phase, value);
    }

    pub fn remove(&mut self, id: u64, f: ParamField) {
        self.tracks.remove(&(id, f as u8));
    }

    pub fn is_animated(&self, id: u64, f: ParamField) -> bool {
        self.tracks
            .get(&(id, f as u8))
            .is_some_and(|t| !t.is_empty())
    }

    pub fn track_len(&self, id: u64, f: ParamField) -> usize {
        self.tracks.get(&(id, f as u8)).map_or(0, Track::len)
    }

    /// Drop every track belonging to a deleted layer (e.g. on layer delete).
    pub fn remove_layer(&mut self, id: u64) {
        self.tracks.retain(|k, _| k.0 != id);
    }

    /// Remove the keyframe at `phase` from `(id, f)`'s track, dropping the
    /// track entirely if that was its last key. No-op if there's no track or
    /// no key at `phase`.
    pub fn remove_key(&mut self, id: u64, f: ParamField, phase: f32) {
        let key = (id, f as u8);
        if let Some(t) = self.tracks.get_mut(&key) {
            t.remove_at(phase);
            if t.is_empty() {
                self.tracks.remove(&key);
            }
        }
    }

    /// Retime the keyframe at `from` to `to` (clamped to `[0, 1]`), preserving
    /// its value. No-op if there's no track or no key at `from`.
    pub fn move_key(&mut self, id: u64, f: ParamField, from: f32, to: f32) {
        let key = (id, f as u8);
        if let Some(t) = self.tracks.get_mut(&key) {
            if let Some(v) = t.value_at_key(from) {
                t.remove_at(from);
                t.upsert(to.clamp(0.0, 1.0), v);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    /// Sample every track at `phase` and write the result onto whichever
    /// `layers` entry has a matching `id`. Tracks whose layer was deleted (no
    /// `id` match) or whose `u8` doesn't decode to a `ParamField` are
    /// silently skipped — this method never panics on a stale timeline.
    pub fn evaluate_into(&self, layers: &mut [LayerDesc], phase: f32) {
        for (&(id, field_u8), track) in &self.tracks {
            let Some(field) = ParamField::from_u8(field_u8) else {
                continue;
            };
            if let Some(layer) = layers.iter_mut().find(|l| l.id == id) {
                layer.set_param(field, track.sample(phase));
            }
        }
    }

    /// FNV-1a fingerprint over every track's keys, in `BTreeMap` (id, field)
    /// order — so it's insertion-order independent and changes whenever any
    /// track's keyframes change (used to invalidate a bake cache).
    pub fn hash(&self) -> u64 {
        let mut bytes = Vec::new();
        for (&(id, field_u8), track) in &self.tracks {
            bytes.extend_from_slice(&id.to_le_bytes());
            bytes.push(field_u8);
            for k in &track.keys {
                bytes.extend_from_slice(&k.phase.to_bits().to_le_bytes());
                bytes.extend_from_slice(&k.value.to_bits().to_le_bytes());
            }
        }
        fnv1a(&bytes)
    }

    /// Flatten every track into serde-friendly entries (see `TrackEntry`),
    /// decoding each `u8` field key back into a `ParamField`. Entries whose
    /// `u8` doesn't decode (stale/corrupt data) are skipped, same as
    /// `evaluate_into`.
    pub fn to_entries(&self) -> Vec<TrackEntry> {
        self.tracks
            .iter()
            .filter_map(|(&(layer_id, field_u8), track)| {
                let field = ParamField::from_u8(field_u8)?;
                Some(TrackEntry {
                    layer_id,
                    field,
                    keys: track.keys.clone(),
                })
            })
            .collect()
    }

    /// Rebuild a `Timeline` from flattened entries (the inverse of
    /// `to_entries`), keying each into a fresh `BTreeMap` by `(layer_id, field
    /// as u8)`.
    pub fn from_entries(entries: Vec<TrackEntry>) -> Timeline {
        let mut tracks = BTreeMap::new();
        for e in entries {
            tracks.insert((e.layer_id, e.field as u8), Track { keys: e.keys });
        }
        Timeline { tracks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_sample() {
        let mut t = Track::default();
        assert_eq!(t.sample(0.5), 0.0); // empty
        t.upsert(0.0, 1.0);
        assert_eq!(t.sample(0.3), 1.0); // single-key hold
        t.upsert(1.0, 3.0);
        assert!((t.sample(0.5) - 2.0).abs() < 1e-6); // linear mid
        assert_eq!(t.sample(-0.2), 1.0); // hold before
        assert_eq!(t.sample(1.5), 3.0); // hold after
        t.upsert(0.5, 5.0);
        assert_eq!(t.len(), 3); // insert keeps sorted
        t.upsert(0.5, 9.0);
        assert_eq!(t.len(), 3); // upsert replaces
        assert_eq!(t.sample(0.5), 9.0);
    }

    #[test]
    fn timeline_eval_and_hash() {
        let mut tl = Timeline::default();
        let mut layers = vec![LayerDesc {
            id: 7,
            ..Default::default()
        }];
        tl.upsert(7, ParamField::Opacity, 0.0, 0.2);
        tl.upsert(7, ParamField::Opacity, 1.0, 0.8);
        let h0 = tl.hash();
        tl.evaluate_into(&mut layers, 0.5);
        assert!((layers[0].opacity - 0.5).abs() < 1e-6); // interpolated
        assert!(tl.is_animated(7, ParamField::Opacity));
        tl.upsert(7, ParamField::Opacity, 0.5, 0.9);
        assert_ne!(h0, tl.hash()); // hash tracks edits
        tl.remove_layer(7);
        assert!(!tl.is_animated(7, ParamField::Opacity));
    }

    #[test]
    fn hash_is_stable_regardless_of_insertion_order() {
        let mut a = Timeline::default();
        a.upsert(3, ParamField::ScaleX, 0.0, 1.0);
        a.upsert(1, ParamField::Opacity, 0.5, 0.5);
        a.upsert(1, ParamField::Opacity, 0.0, 0.1);

        let mut b = Timeline::default();
        b.upsert(1, ParamField::Opacity, 0.0, 0.1);
        b.upsert(1, ParamField::Opacity, 0.5, 0.5);
        b.upsert(3, ParamField::ScaleX, 0.0, 1.0);

        assert_eq!(a.hash(), b.hash());
    }

    #[test]
    fn track_value_at_key_and_remove_at() {
        let mut t = Track::default();
        t.upsert(0.0, 1.0);
        t.upsert(0.5, 2.0);
        t.upsert(1.0, 3.0);
        assert_eq!(t.value_at_key(0.5), Some(2.0));
        assert!(t.remove_at(0.5));
        assert_eq!(t.len(), 2);
        assert_eq!(t.value_at_key(0.5), None);
        assert!(!t.remove_at(0.9));
    }

    #[test]
    fn timeline_move_key_and_remove_key() {
        let mut tl = Timeline::default();
        tl.upsert(7, ParamField::Opacity, 0.2, 0.5);
        tl.upsert(7, ParamField::Opacity, 0.8, 0.9);
        let h0 = tl.hash();

        tl.move_key(7, ParamField::Opacity, 0.2, 0.4);
        assert!(tl.is_animated(7, ParamField::Opacity));
        assert_eq!(tl.track_len(7, ParamField::Opacity), 2);
        let t = tl.tracks.get(&(7, ParamField::Opacity as u8)).unwrap();
        assert_eq!(t.value_at_key(0.2), None);
        assert_eq!(t.value_at_key(0.4), Some(0.5));
        assert_ne!(h0, tl.hash()); // hash tracks a move

        tl.remove_key(7, ParamField::Opacity, 0.4);
        tl.remove_key(7, ParamField::Opacity, 0.8);
        assert!(!tl.is_animated(7, ParamField::Opacity));
    }

    #[test]
    fn timeline_entries_roundtrip() {
        let mut tl = Timeline::default();
        tl.upsert(7, ParamField::Opacity, 0.0, 0.2);
        tl.upsert(7, ParamField::Opacity, 1.0, 0.8);
        tl.upsert(9, ParamField::ScaleX, 0.5, 3.0);
        let back = Timeline::from_entries(tl.to_entries());
        assert_eq!(back.hash(), tl.hash());
    }
}
