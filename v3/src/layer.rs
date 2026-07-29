// ponytail: `demo_scene()`/`pack_layers()` are wired into `app.rs` (Task 3),
// but `demo_scene()` doesn't construct every `BlendMode` variant (only
// Normal/Multiply) — the rest (Add/Screen/Overlay/Subtract/SmoothMin) exist
// for parity with v2's full `BLEND_MODE_INDEX` and stay reachable via
// `blend_mode as u32` once a real UI can pick them. Without this, the
// non-test binary build sees those variants as dead.
#![allow(dead_code)]

// CPU-side layer data model for the v3 generation pipeline (cycle 2).
// `LayerDesc` is the ergonomic Rust-side layer (ported from v2's `Layer` +
// `NoiseConfig` + `RemapConfig`, `src/types/{layer,noise}.ts`); `GpuLayer` is
// its `#[repr(C)]` std430-matched packed form uploaded to the GPU in Task 2.
// `mat3_from_euler` and the ramp side of this file are ports of v2's
// `mathUtils.ts` / `colorRamp.ts` (see ramp.rs).

use crate::ramp::ColorRamp;

/// Noise/shape source for a layer's `noiseEval`. Fixed subset for v3 cycle 2
/// (Task 2's WGSL depends on these exact discriminants):
/// `0=Value, 1=Perlin, 2=Simplex, 3=FBM, 4=SdfSphere`.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseType {
    Value = 0,
    Perlin = 1,
    Simplex = 2,
    Fbm = 3,
    SdfSphere = 4,
}

/// Compositing mode a layer blends into the accumulated volume with. Order
/// matches v2's `BLEND_MODE_INDEX` (`src/core/renderer/VolumeGenerator.ts`).
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlendMode {
    Normal = 0,
    Add = 1,
    Multiply = 2,
    Screen = 3,
    Overlay = 4,
    Subtract = 5,
    SmoothMin = 6,
}

/// Build a column-major mat3 from Euler XYZ rotation **in radians**
/// (`Rx * Ry * Rz`), returned as 3 padded columns matching a WGSL `mat3x3`
/// reconstructed from 3 `vec4`s (`.xyz` = column, `.w` = 0). Ported from v2's
/// `mat3FromEuler` (`src/utils/mathUtils.ts`); v2 stores rotation in degrees,
/// so callers convert with `.to_radians()` (see `pack_layer`).
pub fn mat3_from_euler(rx: f32, ry: f32, rz: f32) -> [[f32; 4]; 3] {
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();

    [
        [cy * cz, cy * sz, -sy, 0.0],
        [sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy, 0.0],
        [cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy, 0.0],
    ]
}

/// Per-frame/per-scene uniform, std140/std430-compatible at 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GenParams {
    pub res: u32,
    pub layer_count: u32,
    pub global_seed: f32,
    pub anim_phase: f32,
}

/// Packed per-layer GPU form. Field order/offsets are the std430 contract
/// Task 2's WGSL `GpuLayer` struct mirrors byte-for-byte — see
/// `gpu_layer_std430_layout` below before touching field order.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuLayer {
    pub rot0: [f32; 4],
    pub rot1: [f32; 4],
    pub rot2: [f32; 4],          // 0,16,32 (rotation columns)
    pub scale: [f32; 4],         // 48 (.xyz = scale, .w pad)
    pub offset: [f32; 4],        // 64 (.xyz = offset, .w pad)
    pub remap_curve: [f32; 4],   // 80
    pub feather_curve: [f32; 4], // 96
    pub feather: [f32; 4],       // 112 (.xyz = feather x/y/z, .w pad)
    // scalar block 128..208 (20 x 4 bytes):
    pub amplitude: f32,
    pub seed: f32,
    pub opacity: f32,
    pub in_min: f32, // 128
    pub in_max: f32,
    pub out_min: f32,
    pub out_max: f32,
    pub sdf_radius: f32, // 144
    pub sdf_softness: f32,
    pub sdf_height: f32,
    pub persistence: f32,
    pub lacunarity: f32, // 160
    pub noise_type: u32,
    pub blend_mode: u32,
    pub invert: u32,
    pub worley_mode: u32, // 176
    pub feather_shape: u32,
    pub octaves: u32,
    pub fbm_base: u32,
    pub distortion_type: u32, // 192
}

/// Ergonomic Rust-side layer description (ported field-for-field from v2's
/// `Layer`/`NoiseConfig`/`RemapConfig`). `rotation_deg` is Euler XYZ in
/// **degrees** (as v2 stores it); `pack_layer` converts to radians.
#[derive(Clone, Debug)]
pub struct LayerDesc {
    pub noise_type: NoiseType,
    pub fbm_base: NoiseType,
    pub octaves: u32,
    pub persistence: f32,
    pub lacunarity: f32,
    pub scale: [f32; 3],
    pub rotation_deg: [f32; 3],
    pub offset: [f32; 3],
    pub amplitude: f32,
    pub seed: f32,
    pub sdf_radius: f32,
    pub sdf_softness: f32,
    pub sdf_height: f32,
    pub blend_mode: BlendMode,
    pub opacity: f32,
    pub invert: bool,
    pub in_min: f32,
    pub in_max: f32,
    pub out_min: f32,
    pub out_max: f32,
    pub remap_curve: [f32; 4],
    pub feather: [f32; 3],
    pub feather_shape: u32,
    pub feather_curve: [f32; 4],
    pub worley_mode: u32,
    pub distortion_type: u32,
    pub ramp: ColorRamp,
}

impl Default for LayerDesc {
    fn default() -> Self {
        Self {
            noise_type: NoiseType::Value,
            fbm_base: NoiseType::Perlin,
            octaves: 4,
            persistence: 0.5,
            lacunarity: 2.0,
            scale: [1.0, 1.0, 1.0],
            rotation_deg: [0.0, 0.0, 0.0],
            offset: [0.0, 0.0, 0.0],
            amplitude: 1.0,
            seed: 0.0,
            sdf_radius: 0.3,   // v2 DEFAULT_SDF
            sdf_softness: 0.1, // v2 DEFAULT_SDF
            sdf_height: 1.0,   // v2 DEFAULT_SDF
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            invert: false,
            in_min: 0.0,
            in_max: 1.0,
            out_min: 0.0,
            out_max: 1.0,
            remap_curve: [0.0, 0.0, 1.0, 1.0], // identity bezier handles
            feather: [0.0, 0.0, 0.0],
            feather_shape: 0,
            feather_curve: [0.0, 0.0, 1.0, 1.0],
            worley_mode: 0,
            distortion_type: 0,
            ramp: ColorRamp::default(), // disabled, no stops
        }
    }
}

/// Pack an ergonomic `LayerDesc` into its GPU std430 form. Rotation
/// (degrees) -> `mat3_from_euler` (radians); enums -> `u32`; the color ramp
/// is NOT part of `GpuLayer` (it feeds `build_ramp_lut_atlas` separately).
pub fn pack_layer(l: &LayerDesc) -> GpuLayer {
    let [rot0, rot1, rot2] = mat3_from_euler(
        l.rotation_deg[0].to_radians(),
        l.rotation_deg[1].to_radians(),
        l.rotation_deg[2].to_radians(),
    );
    GpuLayer {
        rot0,
        rot1,
        rot2,
        scale: [l.scale[0], l.scale[1], l.scale[2], 0.0],
        offset: [l.offset[0], l.offset[1], l.offset[2], 0.0],
        remap_curve: l.remap_curve,
        feather_curve: l.feather_curve,
        feather: [l.feather[0], l.feather[1], l.feather[2], 0.0],
        amplitude: l.amplitude,
        seed: l.seed,
        opacity: l.opacity,
        in_min: l.in_min,
        in_max: l.in_max,
        out_min: l.out_min,
        out_max: l.out_max,
        sdf_radius: l.sdf_radius,
        sdf_softness: l.sdf_softness,
        sdf_height: l.sdf_height,
        persistence: l.persistence,
        lacunarity: l.lacunarity,
        noise_type: l.noise_type as u32,
        blend_mode: l.blend_mode as u32,
        invert: l.invert as u32,
        worley_mode: l.worley_mode,
        feather_shape: l.feather_shape,
        octaves: l.octaves,
        fbm_base: l.fbm_base as u32,
        distortion_type: l.distortion_type,
    }
}

pub fn pack_layers(layers: &[LayerDesc]) -> Vec<GpuLayer> {
    layers.iter().map(pack_layer).collect()
}

use crate::ramp::RampStop;

fn fire_ramp() -> ColorRamp {
    // v2 RAMP_PRESETS.fire (src/core/colorRamp.ts).
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

fn cool_ramp() -> ColorRamp {
    // A cool blue/cyan tint, shaped like v2's RAMP_PRESETS.smoke but chilled.
    ColorRamp {
        enabled: true,
        stops: vec![
            RampStop {
                t: 0.0,
                color: [10, 20, 40],
                alpha: 0,
            },
            RampStop {
                t: 0.5,
                color: [40, 120, 200],
                alpha: 120,
            },
            RampStop {
                t: 1.0,
                color: [180, 230, 255],
                alpha: 220,
            },
        ],
    }
}

/// ~3-layer demo scene: an FBM cloud (warm/fire ramp), a Perlin detail layer
/// multiplied in (shape only — ramp disabled, echoing v2's per-layer
/// enabled-toggle semantics: disabled = no color contribution), and an
/// SdfSphere mask multiplied in with a cool tint.
pub fn demo_scene() -> Vec<LayerDesc> {
    vec![
        LayerDesc {
            noise_type: NoiseType::Fbm,
            fbm_base: NoiseType::Simplex,
            octaves: 4,
            persistence: 0.5,
            lacunarity: 2.0,
            scale: [2.0, 2.0, 2.0],
            amplitude: 1.0,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            ramp: fire_ramp(),
            ..Default::default()
        },
        LayerDesc {
            noise_type: NoiseType::Perlin,
            scale: [6.0, 6.0, 6.0],
            amplitude: 0.5,
            blend_mode: BlendMode::Multiply,
            opacity: 1.0,
            ramp: ColorRamp::default(), // disabled: shape-only contribution
            ..Default::default()
        },
        LayerDesc {
            noise_type: NoiseType::SdfSphere,
            sdf_radius: 0.35,
            sdf_softness: 0.12,
            blend_mode: BlendMode::Multiply,
            opacity: 1.0,
            ramp: cool_ramp(),
            ..Default::default()
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_layer_std430_layout() {
        use std::mem::{offset_of, size_of};
        assert_eq!(size_of::<GpuLayer>(), 208); // multiple of 16
        assert_eq!(offset_of!(GpuLayer, rot0), 0);
        assert_eq!(offset_of!(GpuLayer, scale), 48);
        assert_eq!(offset_of!(GpuLayer, offset), 64);
        assert_eq!(offset_of!(GpuLayer, remap_curve), 80);
        assert_eq!(offset_of!(GpuLayer, feather), 112);
        assert_eq!(offset_of!(GpuLayer, amplitude), 128);
        assert_eq!(offset_of!(GpuLayer, noise_type), 176);
        assert_eq!(offset_of!(GpuLayer, distortion_type), 204);
    }

    #[test]
    fn gen_params_is_16_bytes() {
        assert_eq!(std::mem::size_of::<GenParams>(), 16);
    }

    #[test]
    fn mat3_euler_90deg_about_z_maps_x_to_y() {
        let cols = mat3_from_euler(0.0, 0.0, 90f32.to_radians());
        // matrix * (1,0,0) = column 0
        let col0 = cols[0];
        assert!((col0[0] - 0.0).abs() < 1e-5, "x: {}", col0[0]);
        assert!((col0[1] - 1.0).abs() < 1e-5, "y: {}", col0[1]);
        assert!((col0[2] - 0.0).abs() < 1e-5, "z: {}", col0[2]);
        // padding column w is always 0.
        for c in cols {
            assert_eq!(c[3], 0.0);
        }
    }

    #[test]
    fn noise_type_and_blend_mode_u32_mapping() {
        assert_eq!(NoiseType::Value as u32, 0);
        assert_eq!(NoiseType::Perlin as u32, 1);
        assert_eq!(NoiseType::Simplex as u32, 2);
        assert_eq!(NoiseType::Fbm as u32, 3);
        assert_eq!(NoiseType::SdfSphere as u32, 4);

        assert_eq!(BlendMode::Normal as u32, 0);
        assert_eq!(BlendMode::Add as u32, 1);
        assert_eq!(BlendMode::Multiply as u32, 2);
        assert_eq!(BlendMode::Screen as u32, 3);
        assert_eq!(BlendMode::Overlay as u32, 4);
        assert_eq!(BlendMode::Subtract as u32, 5);
        assert_eq!(BlendMode::SmoothMin as u32, 6);
    }

    #[test]
    fn demo_scene_packs_without_panicking() {
        let scene = demo_scene();
        assert_eq!(scene.len(), 3);

        let packed = pack_layers(&scene);
        assert_eq!(packed.len(), 3);
        assert_eq!(packed[0].noise_type, NoiseType::Fbm as u32);
        assert_eq!(packed[1].blend_mode, BlendMode::Multiply as u32);
        assert_eq!(packed[2].noise_type, NoiseType::SdfSphere as u32);

        let ramps: Vec<ColorRamp> = scene.iter().map(|l| l.ramp.clone()).collect();
        assert!(ramps[0].enabled);
        assert!(!ramps[1].enabled); // shape-only detail layer
        assert!(ramps[2].enabled);
    }
}
