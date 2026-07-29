// Per-layer color ramp (density -> RGBA) and the 256xN LUT atlas the GPU
// composite pass samples. Ported from v2's `src/core/colorRamp.ts`
// (`buildRampLUT` / `sampleStops`): sorted stops, clamp outside range, linear
// interpolation between the bracketing pair. One difference from v2: there
// `enabled` is a render-time gate checked separately from LUT contents, but
// here (no separate per-layer gate uniform in the v3 atlas path) a
// disabled ramp bakes straight to a transparent row, same as an empty one.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampStop {
    pub t: f32,
    pub color: [u8; 3],
    pub alpha: u8,
}

#[derive(Clone, Debug, Default)]
pub struct ColorRamp {
    pub enabled: bool,
    pub stops: Vec<RampStop>,
}

fn clamp_byte(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

fn lerp_byte(a: u8, b: u8, f: f32) -> u8 {
    clamp_byte(a as f32 + (b as f32 - a as f32) * f)
}

/// Sample a *sorted* stop list at `t`, clamping outside the stop range and
/// linearly interpolating color+alpha between the bracketing pair otherwise.
/// Mirrors v2's `sampleStops`. `pub(crate)` so `ui_logic::add_stop` (cycle 3)
/// can reuse it to color a freshly-inserted stop.
pub(crate) fn sample_stops(stops: &[RampStop], t: f32) -> [u8; 4] {
    let first = stops[0];
    if t <= first.t {
        return [first.color[0], first.color[1], first.color[2], first.alpha];
    }
    let last = stops[stops.len() - 1];
    if t >= last.t {
        return [last.color[0], last.color[1], last.color[2], last.alpha];
    }
    for w in stops.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t >= a.t && t <= b.t {
            let span = (b.t - a.t).max(1e-6);
            let f = (t - a.t) / span;
            return [
                lerp_byte(a.color[0], b.color[0], f),
                lerp_byte(a.color[1], b.color[1], f),
                lerp_byte(a.color[2], b.color[2], f),
                lerp_byte(a.alpha, b.alpha, f),
            ];
        }
    }
    [last.color[0], last.color[1], last.color[2], last.alpha]
}

/// Build a `lut_w`-wide, `layers.len()`-tall RGBA8 LUT atlas: row `i` is
/// layer `i`'s ramp (texel `x` <-> `t = x / (lut_w - 1)`). A disabled or
/// stop-less ramp bakes to an all-zero (transparent) row.
pub fn build_ramp_lut_atlas(layers: &[ColorRamp], lut_w: usize) -> Vec<u8> {
    let mut atlas = vec![0u8; lut_w * layers.len() * 4];
    for (row, ramp) in layers.iter().enumerate() {
        if !ramp.enabled || ramp.stops.is_empty() {
            continue; // already zeroed = transparent
        }
        let mut stops = ramp.stops.clone();
        stops.sort_by(|a, b| a.t.total_cmp(&b.t));
        let row_start = row * lut_w * 4;
        for x in 0..lut_w {
            let t = x as f32 / (lut_w - 1) as f32;
            let [r, g, b, a] = sample_stops(&stops, t);
            let o = row_start + x * 4;
            atlas[o] = r;
            atlas[o + 1] = g;
            atlas[o + 2] = b;
            atlas[o + 3] = a;
        }
    }
    atlas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fire_ramp() -> ColorRamp {
        // Ported from v2 RAMP_PRESETS.fire (src/core/colorRamp.ts).
        ColorRamp {
            enabled: true,
            stops: vec![
                RampStop {
                    t: 0.0,
                    color: [0, 0, 0],
                    alpha: 0,
                },
                RampStop {
                    t: 0.25,
                    color: [128, 0, 0],
                    alpha: 60,
                },
                RampStop {
                    t: 0.5,
                    color: [255, 80, 0],
                    alpha: 140,
                },
                RampStop {
                    t: 0.75,
                    color: [255, 200, 0],
                    alpha: 200,
                },
                RampStop {
                    t: 1.0,
                    color: [255, 255, 255],
                    alpha: 255,
                },
            ],
        }
    }

    fn flat_blue_ramp() -> ColorRamp {
        ColorRamp {
            enabled: true,
            stops: vec![RampStop {
                t: 0.5,
                color: [0, 0, 255],
                alpha: 255,
            }],
        }
    }

    #[test]
    fn ramp_lut_atlas_two_layers() {
        let layers = [fire_ramp(), flat_blue_ramp()];
        let atlas = build_ramp_lut_atlas(&layers, 256);
        assert_eq!(atlas.len(), 256 * 2 * 4);

        // Row 0 (fire), texel at t=1 (x=255): white, opaque.
        let o = 255 * 4;
        assert_eq!(&atlas[o..o + 4], &[255, 255, 255, 255]);

        // Row 1 (flat blue): every texel is blue-opaque (single stop -> constant).
        let row1 = 256 * 4;
        for x in 0..256 {
            let o = row1 + x * 4;
            assert_eq!(&atlas[o..o + 4], &[0, 0, 255, 255], "x={x}");
        }
    }

    #[test]
    fn disabled_ramp_row_is_transparent() {
        let layers = [ColorRamp {
            enabled: false,
            stops: fire_ramp().stops,
        }];
        let atlas = build_ramp_lut_atlas(&layers, 256);
        assert!(atlas.iter().all(|&b| b == 0));
    }

    #[test]
    fn empty_ramp_row_is_transparent() {
        let layers = [ColorRamp {
            enabled: true,
            stops: vec![],
        }];
        let atlas = build_ramp_lut_atlas(&layers, 256);
        assert!(atlas.iter().all(|&b| b == 0));
    }
}
