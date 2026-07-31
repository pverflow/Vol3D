// Pure animation helpers for cycle 4 (phase clock, frame indexing, dense-cache budget,
// bake-key invalidation). No GPU here — these are plain math/hash functions consumed by
// `app.rs`/`render/*` in later cycle-4 tasks (Task 1 here only wires them up + tests them;
// nothing in the non-test binary calls them yet, hence the blanket dead_code allow below,
// mirroring `layer.rs`'s same-shaped allow for the same reason).
#![allow(dead_code)]

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advance_phase_wraps() {
        assert!((advance_phase(0.9, 0.2, 1.0) - 0.1).abs() < 1e-5); // 0.9+0.2 -> 0.1
        assert_eq!(advance_phase(0.5, 1.0, 0.0), 0.5); // loop_seconds 0 = frozen
    }

    #[test]
    fn frame_for_phase_nearest_wraps() {
        assert_eq!(frame_for_phase(0.0, 8), 0);
        assert_eq!(frame_for_phase(0.99, 8), 0); // rounds to 8 -> wraps to 0
        assert_eq!(frame_for_phase(0.5, 8), 4);
        assert_eq!(frame_for_phase(0.3, 1), 0);
    }

    #[test]
    fn max_frames_dense_budget() {
        // 128^3*4 = 8_388_608 bytes/frame; 256MB budget -> 32; never 0
        assert_eq!(max_frames(128, 256 * 1024 * 1024), 32);
        assert!(max_frames(512, 8 * 1024 * 1024) >= 1); // floor at 1 even if over budget
    }

    #[test]
    fn is_stale_detects_edits() {
        let a = BakeKey::new(&[], 128, 1.0, 8);
        let b = a.clone();
        assert!(!is_stale(&Some(a.clone()), &b));
        let c = BakeKey::new(&[], 256, 1.0, 8);
        assert!(is_stale(&Some(a), &c));
        assert!(is_stale(&None, &c)); // never baked = stale
    }
}

use crate::layer::GpuLayer;

/// Advance the animation `phase` (a value in `[0, 1)` representing position in a loop) by
/// `dt` seconds against a `loop_seconds`-long loop. `loop_seconds <= 0` means "frozen" — the
/// phase never advances (avoids a div-by-zero and gives an explicit pause state).
pub fn advance_phase(phase: f32, dt: f32, loop_seconds: f32) -> f32 {
    if loop_seconds <= 0.0 {
        return phase;
    }
    ((phase + dt / loop_seconds) % 1.0 + 1.0) % 1.0
}

/// Map a `phase` in `[0, 1)` to the nearest baked frame index out of `n`, wrapping (so a
/// phase that rounds up to `n` lands back on frame `0`, keeping the loop seamless).
pub fn frame_for_phase(phase: f32, n: u32) -> usize {
    if n == 0 {
        return 0;
    }
    ((phase.rem_euclid(1.0) * n as f32).round() as usize) % n as usize
}

/// Cap for `max_frames` — a dense `FrameCache` of more than this many `res³` textures isn't a
/// sane default budget target regardless of how much `budget_bytes` allows.
const MAX_FRAMES_CAP: u32 = 64;

/// How many `res³` rgba8unorm frames fit in `budget_bytes`, floored at 1 (a cache always has
/// at least one frame, even if that single frame already exceeds budget) and capped at
/// `MAX_FRAMES_CAP`.
pub fn max_frames(res: u32, budget_bytes: u64) -> u32 {
    let bytes_per_frame = (res as u64).pow(3) * 4;
    let frames = (budget_bytes / bytes_per_frame).max(1);
    frames.min(MAX_FRAMES_CAP as u64) as u32
}

/// Snapshot of everything a baked `FrameCache` depends on. Comparing two `BakeKey`s (`==`)
/// tells you whether a previous bake is still valid for the current scene.
#[derive(Clone, Debug, PartialEq)]
pub struct BakeKey {
    layers_hash: u64,
    res: u32,
    evolutions_bits: u32,
    n: u32,
}

impl BakeKey {
    /// `layers` is the packed `GpuLayer` slice about to be (or already) baked; `res`/`n` are
    /// the volume resolution and frame count, `evolutions` the animation's noise-cycle count.
    /// `evolutions` is compared bit-for-bit (`to_bits`) rather than as `f32` directly, since
    /// `f32` isn't `Eq` — fine here because the value comes from a `DragValue`/const, not from
    /// an accumulated float that could differ by rounding.
    pub fn new(layers: &[GpuLayer], res: u32, evolutions: f32, n: u32) -> Self {
        Self {
            layers_hash: fnv1a(bytemuck::cast_slice(layers)),
            res,
            evolutions_bits: evolutions.to_bits(),
            n,
        }
    }
}

/// FNV-1a over raw bytes — simple, dependency-free, plenty for a cache-invalidation
/// fingerprint (not used anywhere security-sensitive).
fn fnv1a(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    bytes
        .iter()
        .fold(OFFSET, |h, &b| (h ^ b as u64).wrapping_mul(PRIME))
}

/// A cache is stale if it was never baked (`None`) or if `current`'s inputs differ from what
/// was last baked.
pub fn is_stale(baked: &Option<BakeKey>, current: &BakeKey) -> bool {
    match baked {
        None => true,
        Some(b) => b != current,
    }
}
