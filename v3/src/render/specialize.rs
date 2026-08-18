// Per-scene specialization of `generate.wgsl`.
//
// WHY THIS EXISTS: `generate.wgsl` dispatches every noise family, every SDF shape and every
// distortion mode from runtime `switch`es over `GpuLayer` fields. Nothing is statically dead, so
// a backend must compile ALL of it — including FBM's 8-octave loop, Worley/Voronoi's 3x3x3 (27
// iteration) cell loops, and `apply_distortion`'s turbulence path (`warp_field` = a 6-way noise
// switch, called 3x per octave x 8 octaves, inside the per-layer loop). Tint -> MSL handles that
// fine, but Tint -> HLSL -> DXC on Windows inlines and unrolls it into a 16-60 SECOND
// `create_compute_pipeline` call. That call is synchronous, so it blocks the browser's GPU
// process past Chromium's watchdog, which kills it (`GPU process exited unexpectedly:
// exit_code=2`) — the tab never paints a single frame. Measured on an RTX 3080 / Vivaldi:
// monolithic 57.8 s, this specialized form 0.7 s.
//
// THE MECHANISM: a scene only ever uses a few families. For every family the scene does NOT
// reference, replace that generator's *body* with a constant `return`. Call sites and switch arms
// stay exactly as they were (so no WGSL parsing is needed here), but the expensive helpers become
// unreachable and Tint's dead-code elimination drops them before the HLSL backend ever sees them.
// A scene that genuinely uses everything pays the old price; no scene the UI can build does.

use crate::layer::GpuLayer;

/// One switchable generator family in `generate.wgsl`. Bit values are internal (a cache key), NOT
/// a GPU-visible contract — unlike `NoiseType`'s discriminants, these can be renumbered freely.
pub mod feature {
    pub const VALUE: u32 = 1 << 0;
    pub const PERLIN: u32 = 1 << 1;
    pub const SIMPLEX: u32 = 1 << 2;
    pub const WORLEY: u32 = 1 << 3;
    pub const VORONOI: u32 = 1 << 4;
    pub const WHITE: u32 = 1 << 5;
    pub const FBM: u32 = 1 << 6;
    /// Any layer with `distortion_type != None` — gates the whole warp path.
    pub const DISTORT: u32 = 1 << 7;
}

/// `NoiseType` discriminants, as they arrive in `GpuLayer::noise_type` / `fbm_base` /
/// `warp_noise`. Kept as raw `u32` here because that is what the packed layer carries; see
/// `layer::NoiseType` for the authoritative list.
fn family_bit(noise_type: u32) -> u32 {
    match noise_type {
        0 => feature::VALUE,
        1 => feature::PERLIN,
        2 => feature::SIMPLEX,
        3 => feature::FBM,
        5 => feature::WORLEY,
        6 => feature::VORONOI,
        7 => feature::WHITE,
        // 4, 8..=12 are the SDF shapes: straight-line distance math, cheap to compile, and always
        // kept. They contribute no bit.
        _ => 0,
    }
}

/// Which generator families `layers` can actually reach this frame.
///
/// A family is needed when a layer selects it directly (`noise_type`), when an FBM layer uses it
/// as its base (`fbm_base`), or when a *warping* distortion reads it (`warp_noise`). `warp_noise`
/// deliberately does NOT count for `Swirl`/`Polar`, which are pure coordinate math and never call
/// `warp_field` — the default scene sets `warp_noise: Perlin` on every layer, so honoring it
/// unconditionally would pull Perlin (and the whole warp path) into every compile for nothing.
pub fn feature_mask(layers: &[GpuLayer]) -> u32 {
    let mut mask = 0;
    for l in layers {
        mask |= family_bit(l.noise_type);
        if l.noise_type == 3 {
            mask |= family_bit(l.fbm_base);
        }
        // DomainWarp | Curl | Turbulence — the three modes whose bodies call `warp_field`.
        let warps = matches!(l.distortion_type, 1 | 2 | 5);
        if l.distortion_type != 0 {
            mask |= feature::DISTORT;
        }
        if warps {
            mask |= family_bit(l.warp_noise);
            // `warp_loop` layers don't sample `warp_field` at all — they go through
            // `warp_field_loop`, which hardcodes `pnoise3_core` (tileable Perlin) and ignores
            // `warp_noise`. Perlin must therefore stay alive regardless of the selector, or the
            // stub turns the whole warp into a constant offset (a rigid diagonal translation,
            // with Warp Freq/Octaves inert because every octave returns the same value).
            if l.warp_loop != 0 {
                mask |= feature::PERLIN;
            }
        }
    }
    mask
}

/// Replace the body of top-level `fn <name>(...)` with `return <ret>;`.
///
/// Relies on `generate.wgsl`'s formatting: top-level functions close with a `}` in column 0.
/// Returns `None` when the function isn't found or has no column-0 close, so a rename upstream
/// degrades to "compiles the slow way" rather than emitting broken WGSL —
/// `every_stub_target_exists` is the test that stops that going unnoticed.
fn stub_body(src: &str, name: &str, ret: &str) -> Option<String> {
    let at = src.find(&format!("\nfn {name}("))?;
    let body_open = src[at..].find('{')? + at;
    let body_close = src[body_open..].find("\n}")? + body_open;
    let mut out = String::with_capacity(src.len());
    out.push_str(&src[..=body_open]);
    out.push_str("\n  return ");
    out.push_str(ret);
    out.push(';');
    out.push_str(&src[body_close..]);
    Some(out)
}

/// (feature bit, function to neutralize, constant it returns instead).
///
/// Only the compile-expensive generators are listed. `noise_value` is cheap but listed for
/// symmetry; the SDF shapes are not listed at all (see `family_bit`).
const STUBS: &[(u32, &str, &str)] = &[
    (feature::VALUE, "noise_value", "0.5"),
    (feature::PERLIN, "pnoise3_core", "0.5"),
    (feature::SIMPLEX, "snoise3_core", "0.5"),
    (feature::WORLEY, "worley_f1f2", "vec2<f32>(0.5, 0.7)"),
    (feature::VORONOI, "noise_voronoi", "0.5"),
    (feature::WHITE, "noise_white", "0.5"),
    (feature::FBM, "noise_fbm", "0.5"),
    // The warp path: `apply_distortion` is the switch, the two `warp_field*`s are its samplers.
    // Returning `p` keeps `apply_distortion` an exact identity, which is what
    // `DistortionType::None` already means.
    (feature::DISTORT, "apply_distortion", "p"),
    (feature::DISTORT, "warp_field", "0.5"),
    (feature::DISTORT, "warp_field_loop", "0.5"),
];

/// Milliseconds from an arbitrary origin, for logging how long pipeline creation took.
/// `std::time::Instant` panics on wasm, so the web path reads `performance.now()`.
#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// `generate.wgsl`, with every generator the scene can't reach reduced to a constant.
pub fn specialize(src: &str, mask: u32) -> String {
    let mut out = src.to_string();
    for &(bit, name, ret) in STUBS {
        if mask & bit == 0 {
            if let Some(next) = stub_body(&out, name, ret) {
                out = next;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::feature::*;
    use super::*;
    use crate::layer::{pack_layer, pack_layers, DistortionType, LayerDesc, NoiseType};

    const SRC: &str = include_str!("../../shaders/generate.wgsl");

    /// Line endings depend on the checkout (git may hand us CRLF on Windows, LF elsewhere), which
    /// would make every literal needle below a coin flip. `stub_body` itself only ever matches on
    /// `\n`, so it is ending-agnostic; these assertions normalize to match.
    fn lf(s: &str) -> String {
        s.replace("\r\n", "\n")
    }

    /// The transform is string-matched against the real shader, so a rename in `generate.wgsl`
    /// would silently stop specializing (back to 60 s pipeline creation on Windows, i.e. the
    /// browser-killing bug). This is the guard for that.
    #[test]
    fn every_stub_target_exists() {
        for &(_, name, ret) in STUBS {
            assert!(
                stub_body(SRC, name, ret).is_some(),
                "generate.wgsl has no top-level `fn {name}(` with a column-0 close — \
                 specialization would silently no-op"
            );
        }
    }

    #[test]
    fn stubbing_removes_the_body_but_keeps_the_signature() {
        let out = lf(&stub_body(SRC, "worley_f1f2", "vec2<f32>(0.5, 0.7)").unwrap());
        assert!(out.contains("fn worley_f1f2(p: vec3<f32>, seed: f32) -> vec2<f32> {"));

        // Scoped to this function's own body: `noise_voronoi` has an identically-shaped 3x3x3
        // loop and is deliberately left alone here, so a whole-file search would prove nothing.
        let at = out.find("fn worley_f1f2(").unwrap();
        let body = &out[at..at + out[at..].find("\n}").unwrap()];
        assert!(body.contains("return vec2<f32>(0.5, 0.7);"));
        // The 27-iteration cell loop is what made this expensive; it must be gone from the body.
        assert!(!body.contains("for ("), "worley body still loops: {body}");

        // Callers are untouched — no parsing, so `noise_worley` still calls it.
        assert!(out[at + 20..].contains("worley_f1f2(") || out[..at].contains("worley_f1f2("));
    }

    #[test]
    fn specialize_keeps_used_families_and_drops_unused_ones() {
        let out = lf(&specialize(SRC, SIMPLEX));
        // Simplex is in use: its core survives intact.
        assert!(out.contains("fn snoise3_core(v: vec3<f32>) -> f32 {\n  let C"));
        // Everything else is neutralized.
        assert!(out.contains("fn pnoise3_core(P: vec3<f32>, rep: vec3<f32>) -> f32 {\n  return 0.5;"));
        assert!(out.contains("fn noise_fbm(p_in: vec3<f32>, octaves: u32, persistence: f32, lacunarity: f32, base: u32, seed: f32) -> f32 {\n  return 0.5;"));
        assert!(out.contains("fn apply_distortion(L: GpuLayer, p: vec3<f32>) -> vec3<f32> {\n  return p;"));
        // Still a valid compute shader.
        assert!(out.contains("@compute @workgroup_size(4, 4, 4)"));
        assert!(out.contains("fn main("));
    }

    #[test]
    fn specialize_with_everything_is_the_original() {
        let all = VALUE | PERLIN | SIMPLEX | WORLEY | VORONOI | WHITE | FBM | DISTORT;
        assert_eq!(specialize(SRC, all), SRC);
    }

    #[test]
    fn mask_of_fbm_layer_includes_its_base() {
        let l = pack_layer(&LayerDesc {
            noise_type: NoiseType::Fbm,
            fbm_base: NoiseType::Simplex,
            ..Default::default()
        });
        assert_eq!(feature_mask(&[l]), FBM | SIMPLEX);
    }

    #[test]
    fn mask_of_warping_distortion_includes_its_warp_noise() {
        let l = pack_layer(&LayerDesc {
            noise_type: NoiseType::SdfSphere, // no family bit of its own
            distortion_type: DistortionType::Turbulence,
            warp_noise: NoiseType::Worley,
            ..Default::default()
        });
        assert_eq!(feature_mask(&[l]), DISTORT | WORLEY);
    }

    /// `warp_loop` layers sample `warp_field_loop`, which hardcodes `pnoise3_core` (tileable
    /// Perlin) and ignores `warp_noise` entirely. So Perlin must be in the mask whenever loop mode
    /// is on, whatever the selector says — otherwise `pnoise3_core` is stubbed to `0.5`,
    /// `warp_field_loop` returns a constant `0.75`, all three turbulence taps come out equal, and
    /// the layer gets a constant diagonal translation instead of a warp (with Warp Freq/Octaves
    /// having no effect, since every octave returns the same constant).
    #[test]
    fn mask_of_loop_warp_always_includes_perlin() {
        for warp in [
            NoiseType::Value,
            NoiseType::Simplex,
            NoiseType::Worley,
            NoiseType::Voronoi,
            NoiseType::White,
        ] {
            let l = pack_layer(&LayerDesc {
                noise_type: NoiseType::SdfPlume,
                distortion_type: DistortionType::Turbulence,
                warp_noise: warp,
                warp_loop: true,
                ..Default::default()
            });
            let mask = feature_mask(&[l]);
            assert_ne!(
                mask & PERLIN,
                0,
                "warp_loop with warp_noise={warp:?} must keep pnoise3_core alive"
            );
        }
    }

    /// Loop mode off: the selector is honored, so Perlin is only pulled in when actually chosen.
    #[test]
    fn mask_of_non_loop_warp_does_not_force_perlin() {
        let l = pack_layer(&LayerDesc {
            noise_type: NoiseType::SdfPlume,
            distortion_type: DistortionType::Turbulence,
            warp_noise: NoiseType::Worley,
            warp_loop: false,
            ..Default::default()
        });
        assert_eq!(feature_mask(&[l]), DISTORT | WORLEY);
    }

    /// `Swirl`/`Polar` are pure coordinate math — they need the distortion switch but never touch
    /// `warp_field`, so their (always-populated) `warp_noise` must not drag a noise family in.
    #[test]
    fn mask_of_non_warping_distortion_ignores_warp_noise() {
        let l = pack_layer(&LayerDesc {
            noise_type: NoiseType::SdfSphere,
            distortion_type: DistortionType::Swirl,
            warp_noise: NoiseType::Perlin,
            ..Default::default()
        });
        assert_eq!(feature_mask(&[l]), DISTORT);
    }

    #[test]
    fn mask_of_default_scene_excludes_the_warp_path() {
        // The demo scene is FBM(Simplex) + Perlin + SdfSphere, all `DistortionType::None` —
        // despite every layer carrying the default `warp_noise: Perlin`.
        let mask = feature_mask(&pack_layers(&crate::layer::demo_scene()));
        assert_eq!(mask, FBM | SIMPLEX | PERLIN);
        assert_eq!(mask & DISTORT, 0);
    }

    #[test]
    fn empty_scene_needs_nothing() {
        assert_eq!(feature_mask(&[]), 0);
        // And specializing to nothing still yields a compilable entry point.
        let out = lf(&specialize(SRC, 0));
        assert!(out.contains("fn main("));
        assert!(out.contains("return p;"));
    }
}

