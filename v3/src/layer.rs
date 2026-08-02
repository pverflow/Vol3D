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

/// Noise/shape source for a layer's `noiseEval`. WGSL depends on these exact
/// discriminants (`generate.wgsl`'s `eval_noise`/`eval_base_noise` switches):
/// `0=Value, 1=Perlin, 2=Simplex, 3=FBM, 4=SdfSphere, 5=Worley, 6=Voronoi,
/// 7=White` (Worley/Voronoi/White appended cycle 4 task 1, v2 parity port —
/// see v2's `NoiseType`/`WorleyMode`, `src/types/noise.ts`), `8=SdfBox,
/// 9=SdfCone, 10=SdfCapsule, 11=SdfCylinder, 12=SdfPlume` (cycle 4 task 2,
/// v2 parity port — see v2's `src/core/sdfField.ts` /
/// `src/shaders/noise/sdf_{box,cone,capsule,cylinder,plume}.glsl`).
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseType {
    Value = 0,
    Perlin = 1,
    Simplex = 2,
    Fbm = 3,
    SdfSphere = 4,
    Worley = 5,
    Voronoi = 6,
    White = 7,
    SdfBox = 8,
    SdfCone = 9,
    SdfCapsule = 10,
    SdfCylinder = 11,
    SdfPlume = 12,
}

impl NoiseType {
    /// True for source types whose `eval_noise` is a signed-distance-based
    /// shape (reads sdf_radius/sdf_softness[/sdf_height]) rather than a
    /// procedural noise field — mirrors v2's `isSdfSource`
    /// (`src/types/noise.ts`). All 6 SDF shapes (task 2 completed the set).
    pub fn is_sdf(self) -> bool {
        matches!(
            self,
            NoiseType::SdfSphere
                | NoiseType::SdfBox
                | NoiseType::SdfCone
                | NoiseType::SdfCapsule
                | NoiseType::SdfCylinder
                | NoiseType::SdfPlume
        )
    }
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

/// Domain-distortion applied to a layer's sample position before noise
/// evaluation (`generate.wgsl`'s `apply_distortion` switch). Mirrors v2's
/// `DistortionType` (`src/types/layer.ts`); GLSL sources ported verbatim:
/// `src/shaders/distortion/{domain_warp,curl,swirl,polar}.glsl`. `Turbulence`
/// (cycle 4 distortion-improvements task 1) is new: a multi-octave warp
/// accumulated from `warp_field`, not a v2 port.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DistortionType {
    None = 0,
    DomainWarp = 1,
    Curl = 2,
    Swirl = 3,
    Polar = 4,
    Turbulence = 5,
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
///
/// `global_seed` was dropped (cycle 4): it was unread by the shader — already folded into
/// each layer's `seed` at pack time (see `app.rs::pack_for_gpu`, unchanged) — so carrying it
/// here too was dead weight. `anim_evolutions` replaces it.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GenParams {
    pub res: u32,
    pub layer_count: u32,
    pub anim_phase: f32,
    pub anim_evolutions: f32,
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
    // scalar block 128..224 (24 x 4 bytes):
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
    pub distortion_strength: f32,
    pub distortion_frequency: f32,
    pub distortion_swirl: f32,
    pub _pad_distort: f32, // 208
    // distortion-improvements cycle 4 task 1 (append-only, 0..224 unchanged):
    pub drot0: [f32; 4],         // 224 (warp-space rotation column 0)
    pub drot1: [f32; 4],         // 240 (warp-space rotation column 1)
    pub drot2: [f32; 4],         // 256 (warp-space rotation column 2)
    pub warp_noise: u32,         // 272
    pub distortion_octaves: u32, // 276
    // distortion-offset cycle task 1 (append-only, 0..280 unchanged; the two
    // former `_pad_di0/1` scalars are now live fields, plus one more appended):
    pub distortion_offset_x: f32, // 280 (was _pad_di0)
    pub distortion_offset_y: f32, // 284 (was _pad_di1)
    pub distortion_offset_z: f32, // 288
    pub _pad_do: [f32; 3],        // 292..304 (pad to 16-byte multiple)
}

/// Ergonomic Rust-side layer description (ported field-for-field from v2's
/// `Layer`/`NoiseConfig`/`RemapConfig`). `rotation_deg` is Euler XYZ in
/// **degrees** (as v2 stores it); `pack_layer` converts to radians.
#[derive(Clone, Debug)]
pub struct LayerDesc {
    /// Stable identity for this layer, independent of its position in the
    /// `Vec<LayerDesc>` (which reorders on drag/delete). Used by the
    /// animation timeline (`anim_timeline.rs`) to key tracks to a layer that
    /// survives reordering. Default `0` — unset until the owning UI assigns
    /// a unique id.
    pub id: u64,
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
    pub distortion_type: DistortionType,
    pub distortion_strength: f32,
    pub distortion_frequency: f32,
    pub distortion_swirl: f32,
    /// Euler XYZ (degrees) rotation applied to the warp domain only — lets
    /// the distortion be oriented independently of the layer's own
    /// `rotation_deg` (cycle 4 distortion-improvements task 1).
    pub distortion_rotation: [f32; 3],
    /// Noise field the distortion warp reads from (`generate.wgsl`'s
    /// `warp_field`), NOT the layer's own `noise_type` — fixes distortion
    /// having no effect on flat SDF fields (cycle 4 task 1).
    pub warp_noise: NoiseType,
    /// Octave count for `DistortionType::Turbulence`'s fbm-like warp loop.
    pub distortion_octaves: u32,
    /// Scrolls the warp-field sampling position for `DomainWarp`/`Curl`/
    /// `Turbulence` (added to `q` before it's fed to `warp_field`) —
    /// keyframable so the warp pattern can drift over time. Does NOT affect
    /// the returned distorted position, only where the warp noise is
    /// sampled from (distortion-offset cycle task 1).
    pub distortion_offset: [f32; 3],
    pub ramp: ColorRamp,
    /// UI-only visibility toggle (cycle 3): invisible layers are skipped at
    /// pack time (`app.rs`), contributing neither shape nor color. Not part
    /// of `GpuLayer` — filtering happens before packing, not on the GPU.
    pub visible: bool,
}

impl Default for LayerDesc {
    fn default() -> Self {
        Self {
            id: 0,
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
            distortion_type: DistortionType::None,
            distortion_strength: 0.3, // v2 defaultLayer() distortion.strength
            distortion_frequency: 2.0, // v2 defaultLayer() distortion.warpFrequency
            distortion_swirl: 1.0,    // v2 defaultLayer() distortion.swirlAmount
            distortion_rotation: [0.0, 0.0, 0.0],
            warp_noise: NoiseType::Perlin,
            distortion_octaves: 4,
            distortion_offset: [0.0, 0.0, 0.0],
            ramp: ColorRamp::default(), // disabled, no stops
            visible: true,
        }
    }
}

/// A single scalar, animatable `LayerDesc` field. Keyed by the animation
/// timeline (`anim_timeline::Timeline`, cycle 4 timeline task) — `#[repr(u8)]`
/// so a `(layer_id, field as u8)` pair is a cheap, `Copy`, `BTreeMap`-orderable
/// track key.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum ParamField {
    Opacity,
    ScaleX,
    ScaleY,
    ScaleZ,
    OffsetX,
    OffsetY,
    OffsetZ,
    RotationX,
    RotationY,
    RotationZ,
    Amplitude,
    InMin,
    InMax,
    OutMin,
    OutMax,
    SdfRadius,
    SdfSoftness,
    SdfHeight,
    Persistence,
    Lacunarity,
    DistortionStrength,
    DistortionFrequency,
    DistortionSwirl,
    DistortionRotX,
    DistortionRotY,
    DistortionRotZ,
    DistortionOffsetX,
    DistortionOffsetY,
    DistortionOffsetZ,
}

impl ParamField {
    pub const ALL: [ParamField; 29] = [
        ParamField::Opacity,
        ParamField::ScaleX,
        ParamField::ScaleY,
        ParamField::ScaleZ,
        ParamField::OffsetX,
        ParamField::OffsetY,
        ParamField::OffsetZ,
        ParamField::RotationX,
        ParamField::RotationY,
        ParamField::RotationZ,
        ParamField::Amplitude,
        ParamField::InMin,
        ParamField::InMax,
        ParamField::OutMin,
        ParamField::OutMax,
        ParamField::SdfRadius,
        ParamField::SdfSoftness,
        ParamField::SdfHeight,
        ParamField::Persistence,
        ParamField::Lacunarity,
        ParamField::DistortionStrength,
        ParamField::DistortionFrequency,
        ParamField::DistortionSwirl,
        ParamField::DistortionRotX,
        ParamField::DistortionRotY,
        ParamField::DistortionRotZ,
        ParamField::DistortionOffsetX,
        ParamField::DistortionOffsetY,
        ParamField::DistortionOffsetZ,
    ];

    pub fn label(self) -> &'static str {
        use ParamField::*;
        match self {
            Opacity => "Opacity",
            ScaleX => "Scale X",
            ScaleY => "Scale Y",
            ScaleZ => "Scale Z",
            OffsetX => "Offset X",
            OffsetY => "Offset Y",
            OffsetZ => "Offset Z",
            RotationX => "Rotation X",
            RotationY => "Rotation Y",
            RotationZ => "Rotation Z",
            Amplitude => "Amplitude",
            InMin => "In Min",
            InMax => "In Max",
            OutMin => "Out Min",
            OutMax => "Out Max",
            SdfRadius => "SDF Radius",
            SdfSoftness => "SDF Softness",
            SdfHeight => "SDF Height",
            Persistence => "Persistence",
            Lacunarity => "Lacunarity",
            DistortionStrength => "Distortion Strength",
            DistortionFrequency => "Distortion Frequency",
            DistortionSwirl => "Distortion Swirl",
            DistortionRotX => "Distortion Rot X",
            DistortionRotY => "Distortion Rot Y",
            DistortionRotZ => "Distortion Rot Z",
            DistortionOffsetX => "Distortion Offset X",
            DistortionOffsetY => "Distortion Offset Y",
            DistortionOffsetZ => "Distortion Offset Z",
        }
    }

    /// Decode a `ParamField as u8` discriminant back into its variant (the
    /// inverse used by `Timeline::evaluate_into` to turn a track's `u8` key
    /// back into something `get_param`/`set_param` accept). `None` for any
    /// value outside the 29 valid discriminants.
    pub fn from_u8(v: u8) -> Option<ParamField> {
        Self::ALL.into_iter().find(|&f| f as u8 == v)
    }
}

impl LayerDesc {
    pub fn get_param(&self, f: ParamField) -> f32 {
        use ParamField::*;
        match f {
            Opacity => self.opacity,
            Amplitude => self.amplitude,
            ScaleX => self.scale[0],
            ScaleY => self.scale[1],
            ScaleZ => self.scale[2],
            OffsetX => self.offset[0],
            OffsetY => self.offset[1],
            OffsetZ => self.offset[2],
            RotationX => self.rotation_deg[0],
            RotationY => self.rotation_deg[1],
            RotationZ => self.rotation_deg[2],
            InMin => self.in_min,
            InMax => self.in_max,
            OutMin => self.out_min,
            OutMax => self.out_max,
            SdfRadius => self.sdf_radius,
            SdfSoftness => self.sdf_softness,
            SdfHeight => self.sdf_height,
            Persistence => self.persistence,
            Lacunarity => self.lacunarity,
            DistortionStrength => self.distortion_strength,
            DistortionFrequency => self.distortion_frequency,
            DistortionSwirl => self.distortion_swirl,
            DistortionRotX => self.distortion_rotation[0],
            DistortionRotY => self.distortion_rotation[1],
            DistortionRotZ => self.distortion_rotation[2],
            DistortionOffsetX => self.distortion_offset[0],
            DistortionOffsetY => self.distortion_offset[1],
            DistortionOffsetZ => self.distortion_offset[2],
        }
    }

    pub fn set_param(&mut self, f: ParamField, v: f32) {
        use ParamField::*;
        match f {
            Opacity => self.opacity = v,
            Amplitude => self.amplitude = v,
            ScaleX => self.scale[0] = v,
            ScaleY => self.scale[1] = v,
            ScaleZ => self.scale[2] = v,
            OffsetX => self.offset[0] = v,
            OffsetY => self.offset[1] = v,
            OffsetZ => self.offset[2] = v,
            RotationX => self.rotation_deg[0] = v,
            RotationY => self.rotation_deg[1] = v,
            RotationZ => self.rotation_deg[2] = v,
            InMin => self.in_min = v,
            InMax => self.in_max = v,
            OutMin => self.out_min = v,
            OutMax => self.out_max = v,
            SdfRadius => self.sdf_radius = v,
            SdfSoftness => self.sdf_softness = v,
            SdfHeight => self.sdf_height = v,
            Persistence => self.persistence = v,
            Lacunarity => self.lacunarity = v,
            DistortionStrength => self.distortion_strength = v,
            DistortionFrequency => self.distortion_frequency = v,
            DistortionSwirl => self.distortion_swirl = v,
            DistortionRotX => self.distortion_rotation[0] = v,
            DistortionRotY => self.distortion_rotation[1] = v,
            DistortionRotZ => self.distortion_rotation[2] = v,
            DistortionOffsetX => self.distortion_offset[0] = v,
            DistortionOffsetY => self.distortion_offset[1] = v,
            DistortionOffsetZ => self.distortion_offset[2] = v,
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
    let [drot0, drot1, drot2] = mat3_from_euler(
        l.distortion_rotation[0].to_radians(),
        l.distortion_rotation[1].to_radians(),
        l.distortion_rotation[2].to_radians(),
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
        distortion_type: l.distortion_type as u32,
        distortion_strength: l.distortion_strength,
        distortion_frequency: l.distortion_frequency,
        distortion_swirl: l.distortion_swirl,
        _pad_distort: 0.0,
        drot0,
        drot1,
        drot2,
        warp_noise: l.warp_noise as u32,
        distortion_octaves: l.distortion_octaves,
        distortion_offset_x: l.distortion_offset[0],
        distortion_offset_y: l.distortion_offset[1],
        distortion_offset_z: l.distortion_offset[2],
        _pad_do: [0.0; 3],
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
        assert_eq!(size_of::<GpuLayer>(), 304); // multiple of 16
        assert_eq!(offset_of!(GpuLayer, rot0), 0);
        assert_eq!(offset_of!(GpuLayer, scale), 48);
        assert_eq!(offset_of!(GpuLayer, offset), 64);
        assert_eq!(offset_of!(GpuLayer, remap_curve), 80);
        assert_eq!(offset_of!(GpuLayer, feather), 112);
        assert_eq!(offset_of!(GpuLayer, amplitude), 128);
        assert_eq!(offset_of!(GpuLayer, noise_type), 176);
        assert_eq!(offset_of!(GpuLayer, distortion_type), 204);
        assert_eq!(offset_of!(GpuLayer, distortion_strength), 208);
        assert_eq!(offset_of!(GpuLayer, distortion_frequency), 212);
        assert_eq!(offset_of!(GpuLayer, distortion_swirl), 216);
        assert_eq!(offset_of!(GpuLayer, _pad_distort), 220);
        assert_eq!(offset_of!(GpuLayer, drot0), 224);
        assert_eq!(offset_of!(GpuLayer, drot1), 240);
        assert_eq!(offset_of!(GpuLayer, drot2), 256);
        assert_eq!(offset_of!(GpuLayer, warp_noise), 272);
        assert_eq!(offset_of!(GpuLayer, distortion_octaves), 276);
        assert_eq!(offset_of!(GpuLayer, distortion_offset_x), 280);
        assert_eq!(offset_of!(GpuLayer, distortion_offset_y), 284);
        assert_eq!(offset_of!(GpuLayer, distortion_offset_z), 288);
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
        assert_eq!(NoiseType::Worley as u32, 5);
        assert_eq!(NoiseType::Voronoi as u32, 6);
        assert_eq!(NoiseType::White as u32, 7);
        assert_eq!(NoiseType::SdfBox as u32, 8);
        assert_eq!(NoiseType::SdfCone as u32, 9);
        assert_eq!(NoiseType::SdfCapsule as u32, 10);
        assert_eq!(NoiseType::SdfCylinder as u32, 11);
        assert_eq!(NoiseType::SdfPlume as u32, 12);

        assert_eq!(BlendMode::Normal as u32, 0);
        assert_eq!(BlendMode::Add as u32, 1);
        assert_eq!(BlendMode::Multiply as u32, 2);
        assert_eq!(BlendMode::Screen as u32, 3);
        assert_eq!(BlendMode::Overlay as u32, 4);
        assert_eq!(BlendMode::Subtract as u32, 5);
        assert_eq!(BlendMode::SmoothMin as u32, 6);

        assert_eq!(DistortionType::None as u32, 0);
        assert_eq!(DistortionType::DomainWarp as u32, 1);
        assert_eq!(DistortionType::Curl as u32, 2);
        assert_eq!(DistortionType::Swirl as u32, 3);
        assert_eq!(DistortionType::Polar as u32, 4);
        assert_eq!(DistortionType::Turbulence as u32, 5);
    }

    #[test]
    fn is_sdf_true_for_sdf_shapes_false_for_noise_sources() {
        for t in [
            NoiseType::SdfSphere,
            NoiseType::SdfBox,
            NoiseType::SdfCone,
            NoiseType::SdfCapsule,
            NoiseType::SdfCylinder,
            NoiseType::SdfPlume,
        ] {
            assert!(t.is_sdf(), "{t:?} should be an SDF source");
        }
        for t in [
            NoiseType::Value,
            NoiseType::Perlin,
            NoiseType::Simplex,
            NoiseType::Fbm,
            NoiseType::Worley,
            NoiseType::Voronoi,
            NoiseType::White,
        ] {
            assert!(!t.is_sdf(), "{t:?} should not be an SDF source");
        }
    }

    #[test]
    fn param_get_set_roundtrip() {
        let mut l = LayerDesc::default();
        for f in ParamField::ALL {
            l.set_param(f, 0.375);
            assert_eq!(l.get_param(f), 0.375, "{f:?}");
        }
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
