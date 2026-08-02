// Pure UI-logic helpers for the authoring UI (cycle 3, Task 1): layer-list
// reordering, gradient-stop editing, and a regen debounce predicate. No
// egui/GPU imports — these are plain functions over cycle 2's data model
// (`layer::LayerDesc`, `ramp::RampStop`) so they're unit-testable without a
// window or device.
//
// ponytail: not yet called from `app.rs` (that's a later authoring-UI task),
// so `#![allow(dead_code)]` mirrors `layer.rs`'s same situation — otherwise
// a plain `cargo check` (no test cfg) flags every `pub fn` here as dead.
#![allow(dead_code)]

use crate::layer::LayerDesc;
use crate::ramp::{sample_stops, RampStop};

/// Push a default layer and select it. Stamps a fresh `id` from `next_id`
/// (post-incrementing it) so the new layer never collides with an existing
/// one. Returns the new `selected` index.
pub fn add_layer(layers: &mut Vec<LayerDesc>, _selected: usize, next_id: &mut u64) -> usize {
    let id = *next_id;
    *next_id += 1;
    layers.push(LayerDesc {
        id,
        ..Default::default()
    });
    layers.len() - 1
}

/// Clone the selected layer, insert the copy right after it, and select the
/// copy. The copy gets a fresh `id` from `next_id` (post-incrementing it) so
/// it doesn't collide with the original's timeline tracks. Returns the new
/// `selected` index.
pub fn duplicate_layer(layers: &mut Vec<LayerDesc>, selected: usize, next_id: &mut u64) -> usize {
    if layers.is_empty() {
        return 0;
    }
    let idx = selected.min(layers.len() - 1);
    let mut copy = layers[idx].clone();
    copy.id = *next_id;
    *next_id += 1;
    layers.insert(idx + 1, copy);
    idx + 1
}

/// Remove the selected layer, but never below 1 layer (no-op at `len == 1`).
/// Returns a `selected` index clamped into `[0, len)`.
pub fn delete_layer(layers: &mut Vec<LayerDesc>, selected: usize) -> usize {
    if layers.len() <= 1 {
        return selected.min(layers.len().saturating_sub(1));
    }
    let idx = selected.min(layers.len() - 1);
    layers.remove(idx);
    idx.min(layers.len() - 1)
}

/// Swap the selected layer with its predecessor, following it. No-op at the
/// start of the list.
pub fn move_up(layers: &mut [LayerDesc], selected: usize) -> usize {
    if layers.is_empty() || selected == 0 || selected >= layers.len() {
        return selected.min(layers.len().saturating_sub(1));
    }
    layers.swap(selected, selected - 1);
    selected - 1
}

/// Swap the selected layer with its successor, following it. No-op at the
/// end of the list.
pub fn move_down(layers: &mut [LayerDesc], selected: usize) -> usize {
    if layers.is_empty() || selected + 1 >= layers.len() {
        return selected.min(layers.len().saturating_sub(1));
    }
    layers.swap(selected, selected + 1);
    selected + 1
}

/// Insert a new stop at `t` (clamped to `[0, 1]`), colored by sampling the
/// existing ramp at that `t` (white/opaque if there's nothing to sample
/// yet). Keeps `stops` sorted by `t` and returns the new stop's index.
pub fn add_stop(stops: &mut Vec<RampStop>, t: f32) -> usize {
    let t = t.clamp(0.0, 1.0);
    let stop = if stops.is_empty() {
        RampStop {
            t,
            color: [255, 255, 255],
            alpha: 255,
        }
    } else {
        let [r, g, b, a] = sample_stops(stops, t);
        RampStop {
            t,
            color: [r, g, b],
            alpha: a,
        }
    };
    let idx = stops.partition_point(|s| s.t < t);
    stops.insert(idx, stop);
    idx
}

/// Move stop `i` to a new `t` (clamped to `[0, 1]`), re-sorting `stops` by
/// `t`. Returns the moved stop's new index. `i` is clamped into range (a UI
/// may hold a stale "selected stop" index after `remove_stop` shrinks the
/// list).
pub fn move_stop(stops: &mut Vec<RampStop>, i: usize, t: f32) -> usize {
    let t = t.clamp(0.0, 1.0);
    let i = i.min(stops.len().saturating_sub(1));
    let mut stop = stops.remove(i);
    stop.t = t;
    let idx = stops.partition_point(|s| s.t < t);
    stops.insert(idx, stop);
    idx
}

/// Remove stop `i`, but never below 1 stop (no-op at `len == 1`).
pub fn remove_stop(stops: &mut Vec<RampStop>, i: usize) {
    if stops.len() <= 1 {
        return;
    }
    let i = i.min(stops.len() - 1);
    stops.remove(i);
}

/// Regen debounce window, in seconds.
pub const REGEN_DEBOUNCE: f64 = 0.12;

/// True once `dirty` and at least `REGEN_DEBOUNCE` seconds have elapsed
/// since the last edit.
pub fn should_regen(now: f64, last_edit: f64, dirty: bool) -> bool {
    dirty && (now - last_edit) >= REGEN_DEBOUNCE
}

/// True the frame a regen (bake or live) is about to dispatch — the moment `dims` becomes the
/// shape actually being (re)generated. Mirrors `app.rs`'s two regen-dispatch branches: the bake
/// path (`playing && cache_stale && frame_count > 0`) and the live path (`!playing &&
/// pending_regen`, which covers both the debounced-edit regen and the pause-snap regen — both
/// just set `pending_regen` and funnel through the same branch). Lets the caller snapshot
/// `dims` into a `committed_dims` right as this fires, so e.g. the camera can frame the box
/// that's about to exist instead of the pending UI target a few frames ahead of it.
pub fn regen_dispatches(
    playing: bool,
    cache_stale: bool,
    frame_count: u32,
    pending_regen: bool,
) -> bool {
    (playing && cache_stale && frame_count > 0) || (!playing && pending_regen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a() -> LayerDesc {
        LayerDesc {
            seed: 1.0,
            ..Default::default()
        }
    }
    fn b() -> LayerDesc {
        LayerDesc {
            seed: 2.0,
            ..Default::default()
        }
    }
    fn c() -> LayerDesc {
        LayerDesc {
            seed: 3.0,
            ..Default::default()
        }
    }
    fn is_a(l: &LayerDesc) -> bool {
        l.seed == 1.0
    }

    #[test]
    fn add_then_delete_keeps_selection_valid() {
        let mut ls = vec![LayerDesc::default()];
        let mut next_id = 1;
        let s = add_layer(&mut ls, 0, &mut next_id); // 2 layers, select new
        assert_eq!(ls.len(), 2);
        assert_eq!(s, 1);
        assert_eq!(ls[1].id, 1);
        assert_eq!(next_id, 2);
        let s = delete_layer(&mut ls, s); // back to 1
        assert_eq!(ls.len(), 1);
        assert!(s < ls.len());
        let _s = delete_layer(&mut ls, s); // refuse to empty
        assert_eq!(ls.len(), 1);
    }

    #[test]
    fn duplicate_layer_stamps_a_fresh_id() {
        let mut ls = vec![LayerDesc {
            id: 5,
            ..Default::default()
        }];
        let mut next_id = 10;
        let s = duplicate_layer(&mut ls, 0, &mut next_id);
        assert_eq!(ls.len(), 2);
        assert_eq!(ls[0].id, 5); // original untouched
        assert_eq!(ls[s].id, 10); // copy gets a fresh id, not a clone of 5
        assert_eq!(next_id, 11);
    }

    #[test]
    fn move_up_down_reorders_and_tracks_selection() {
        let mut ls = vec![a(), b(), c()];
        let s = move_down(&mut ls, 0); // a now at index 1
        assert_eq!(s, 1);
        assert!(is_a(&ls[1]));
        let s = move_up(&mut ls, s); // back to 0
        assert_eq!(s, 0);
        assert!(is_a(&ls[0]));
    }

    #[test]
    fn gradient_stop_ops() {
        let mut st = vec![
            RampStop {
                t: 0.0,
                color: [0, 0, 0],
                alpha: 0,
            },
            RampStop {
                t: 1.0,
                color: [255, 255, 255],
                alpha: 255,
            },
        ];
        let i = add_stop(&mut st, 0.5); // inserted, sorted
        assert_eq!(st.len(), 3);
        assert!((st[i].t - 0.5).abs() < 1e-6);
        let i = move_stop(&mut st, i, 1.5); // clamps to 1.0, re-sorts to the end
        assert!((st[i].t - 1.0).abs() < 1e-6);
        remove_stop(&mut st, i);
        assert_eq!(st.len(), 2);
        // never below 1
        remove_stop(&mut st, 0);
        remove_stop(&mut st, 0);
        assert!(!st.is_empty());
    }

    #[test]
    fn move_stop_clamps_out_of_range_index() {
        let mut st = vec![
            RampStop {
                t: 0.0,
                color: [0, 0, 0],
                alpha: 0,
            },
            RampStop {
                t: 1.0,
                color: [255, 255, 255],
                alpha: 255,
            },
        ];
        // Stale "selected stop" index (e.g. after a remove_stop elsewhere)
        // must not panic — it clamps to the last valid stop.
        let i = move_stop(&mut st, 99, 0.5);
        assert_eq!(st.len(), 2);
        assert!((st[i].t - 0.5).abs() < 1e-6);
    }

    #[test]
    fn debounce_predicate() {
        assert!(!should_regen(1.00, 1.00, true)); // no time elapsed
        assert!(should_regen(1.20, 1.00, true)); // 200ms > 120ms
        assert!(!should_regen(1.20, 1.00, false)); // not dirty
    }

    #[test]
    fn regen_dispatches_bake_or_live_paths() {
        assert!(regen_dispatches(true, true, 8, false)); // bake path
        assert!(!regen_dispatches(true, false, 8, false)); // playing, cache fresh -> no bake
        assert!(!regen_dispatches(true, true, 0, false)); // playing, no frames yet -> no bake
        assert!(regen_dispatches(false, false, 0, true)); // live path (debounce fired or pause snap)
        assert!(!regen_dispatches(false, false, 0, false)); // idle: neither fires
    }
}
