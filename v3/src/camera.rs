// Orbit camera + the uniform buffer layout consumed by `shaders/raymarch.wgsl`'s `Cam` struct.
//
// WGSL alignment note: in the `uniform` address space, `vec3<f32>` has align 16 (not 12), so the
// struct's own alignment is 16 and its *size* rounds up to the next multiple of 16. The tail below
// (from `steps` on) is all scalar `f32` fields — deliberately, so none of them re-triggers the
// vec3-in-uniform padding rule (a `[f32;3]`/`vec3<f32>` field there would demand 16-byte alignment
// again). Rust doesn't do WGSL's implicit struct-size rounding (every field here is align-4, so
// `#[repr(C)]` alone stops at the last field's end) — the trailing `_pad` below exists purely to
// match that WGSL-side rounding so `size_of::<CamUniform>()` equals what the shader's bind group
// layout expects. Without it wgpu would validate-error on binding the buffer ("size N is less than
// minimum M").
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct CamUniform {
    pub eye: [f32; 3],
    pub _p0: f32,
    pub fwd: [f32; 3],
    pub _p1: f32,
    pub right: [f32; 3],
    pub _p2: f32,
    pub up: [f32; 3],
    pub aspect: f32,
    pub tan_half_fov: f32,
    pub steps: f32,
    /// = `anim::macro_dims(dims[axis], MACRO) as f32` per axis; the raymarch reads these to size
    /// occupancy macrocells for empty-space skipping (now per-axis: a non-cubic volume's macrocell
    /// counts differ per axis). `basis` leaves these 0.0 — `RaymarchCallback::prepare` sets them
    /// after building the uniform (needs the bound volume's dims).
    pub macro_dims_x: f32,
    pub macro_dims_y: f32,
    pub macro_dims_z: f32,
    /// Interpolation fraction in `[0,1)` between the two bound baked frames (bindings 0/3 = frame
    /// `i`, bindings 5/6 = frame `i+1`); the raymarch does `mix(sample_a, sample_b, frac)` per
    /// step. `0.0` for the live/paused path (both slots bound to the same volume) →
    /// `mix(a,a,0)=a`, byte-identical to the single-frame result. `basis` leaves it 0.0;
    /// `RaymarchCallback::prepare` sets it from `bind_playback`'s returned frac when playing.
    pub frac: f32,
    /// = `anim::aspect_from_dims(dims)`; each axis's size relative to the shortest (shortest
    /// axis = 1.0, min-normalized — see Task 1). The raymarch scales the unit-box intersect and
    /// the volume/occupancy sample coordinate by this so a non-cubic volume renders as a box of
    /// the right proportions instead of being squashed into a cube. `basis` leaves this field
    /// `[1,1,1]`; `RaymarchCallback::prepare` sets it from the bound dims.
    pub box_aspect_x: f32,
    pub box_aspect_y: f32,
    pub box_aspect_z: f32,
    /// Opacity of the box-wireframe overlay drawn over the raymarch result (Task 1 of the
    /// bounding-box-wireframe cycle); `0.0` = fully off, and the overlay code in `fs` is entirely
    /// guarded behind `C.wire_alpha > 0.0` so the off-path is byte-identical to before this field
    /// existed. Occupies the slot at offset 100 that used to be padding — see the module doc
    /// comment above for why the tail lands there.
    pub wire_alpha: f32,
    /// Pads the struct to WGSL's std140 struct-size rounding (next multiple of 16; the struct's
    /// own alignment, from its vec3 members). The tail from `tan_half_fov` through `wire_alpha`
    /// is 10 scalar f32s (40 bytes) past the first 64 bytes, landing at 104 — 2 trailing f32s (8
    /// bytes) bring it to 112. See the module doc comment above.
    pub _pad1: f32,
    pub _pad2: f32,
}

pub struct OrbitCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        Self {
            yaw: 0.8,
            pitch: 0.5,
            distance: 3.0,
        }
    }
}

impl OrbitCamera {
    /// `box_aspect` (see `anim::aspect_from_dims`) is the rendered box's per-axis size relative
    /// to its shortest axis (shortest = 1.0) — `basis` frames the orbit on that box's actual
    /// center (`box_aspect * 0.5`, not the cube's fixed `[0.5]³`) and scales `self.distance` by
    /// the box's diagonal-vs-cube-diagonal ratio (`fit`) so a taller/wider box still fits in
    /// view instead of orbiting at a cube-sized distance around an off-center point. At
    /// `[1,1,1]` (cubic), `center = [0.5]³` and `fit = 1` — byte-identical to the old hardcoded
    /// behavior.
    pub fn basis(&self, aspect: f32, steps: f32, box_aspect: [f32; 3]) -> CamUniform {
        let center = [
            box_aspect[0] * 0.5,
            box_aspect[1] * 0.5,
            box_aspect[2] * 0.5,
        ];
        let fit = ((box_aspect[0] * box_aspect[0]
            + box_aspect[1] * box_aspect[1]
            + box_aspect[2] * box_aspect[2])
            .sqrt()
            / 3.0f32.sqrt())
        .max(1e-4);
        let d = self.distance * fit;
        let (cp, sp) = (self.pitch.cos(), self.pitch.sin());
        let (cy, sy) = (self.yaw.cos(), self.yaw.sin());
        let dir = [cp * cy, sp, cp * sy]; // eye offset direction
        let eye = [
            center[0] + dir[0] * d,
            center[1] + dir[1] * d,
            center[2] + dir[2] * d,
        ];
        let fwd = norm([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
        let world_up = [0.0f32, 1.0, 0.0];
        let right = norm(cross(fwd, world_up));
        let up = cross(right, fwd);
        CamUniform {
            eye,
            _p0: 0.0,
            fwd,
            _p1: 0.0,
            right,
            _p2: 0.0,
            up,
            aspect,
            tan_half_fov: (0.5f32).tan(),
            steps,
            macro_dims_x: 0.0,
            macro_dims_y: 0.0,
            macro_dims_z: 0.0,
            frac: 0.0,
            box_aspect_x: 1.0,
            box_aspect_y: 1.0,
            box_aspect_z: 1.0,
            wire_alpha: 0.0,
            _pad1: 0.0,
            _pad2: 0.0,
        }
    }
}

fn norm(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-6);
    [v[0] / l, v[1] / l, v[2] / l]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basis_is_orthonormal_and_looks_at_center() {
        let c = OrbitCamera::default().basis(1.0, 128.0, [1.0, 1.0, 1.0]); // cube: center [0.5]³, fit 1
                                                                           // fwd points from eye toward center (0.5,0.5,0.5)
        let to_center = norm([0.5 - c.eye[0], 0.5 - c.eye[1], 0.5 - c.eye[2]]);
        for (f, t) in c.fwd.iter().zip(to_center.iter()) {
            assert!((f - t).abs() < 1e-4);
        }
        // right ⟂ fwd, up ⟂ fwd, unit-ish
        let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert!(dot(c.fwd, c.right).abs() < 1e-4);
        assert!(dot(c.fwd, c.up).abs() < 1e-4);
        assert!((dot(c.right, c.right) - 1.0).abs() < 1e-3);

        // tall box centers higher in Z and pulls the eye further out:
        let t = OrbitCamera::default().basis(1.0, 128.0, [1.0, 1.0, 4.0]);
        // fwd aims at box center [0.5,0.5,2.0]
        let tc = norm([0.5 - t.eye[0], 0.5 - t.eye[1], 2.0 - t.eye[2]]);
        for (f, x) in t.fwd.iter().zip(tc.iter()) {
            assert!((f - x).abs() < 1e-5);
        }
    }

    #[test]
    fn cam_uniform_size_matches_wgsl_std140_padding() {
        // shaders/raymarch.wgsl's `Cam` struct: 3 vec3+pad fields (16 bytes each = 48) + up+aspect
        // (16 bytes) = 64 bytes, then 10 trailing scalar f32s (tan_half_fov, steps, macro_dims_x/y/z,
        // frac, box_aspect_x/y/z, wire_alpha = 40 bytes) = 104 bytes, then WGSL rounds the struct
        // size up to a multiple of its own alignment (16, from the vec3 members) = 112 bytes.
        assert_eq!(std::mem::size_of::<CamUniform>(), 112);
    }
}
