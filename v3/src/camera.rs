// Orbit camera + the uniform buffer layout consumed by `shaders/raymarch.wgsl`'s `Cam` struct.
//
// WGSL alignment note: in the `uniform` address space, `vec3<f32>` has align 16 (not 12), so the
// struct's own alignment is 16 and its *size* rounds up to the next multiple of 16. This `Cam`
// struct's last field ends at byte 76, so WGSL pads the struct to 80 bytes. Rust doesn't do that
// implicit rounding (every field here is align-4, so `#[repr(C)]` alone stops at 76) — the trailing
// `_p4` pad below exists purely to match that WGSL-side rounding so `size_of::<CamUniform>()` (80)
// equals what the shader's bind group layout expects. Without it wgpu would validate-error on
// binding the buffer ("size 76 is less than minimum 80").
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
    pub _p3: f32,
    pub _p4: f32,
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
    pub fn basis(&self, aspect: f32, steps: f32) -> CamUniform {
        let center = [0.5f32, 0.5, 0.5];
        let (cp, sp) = (self.pitch.cos(), self.pitch.sin());
        let (cy, sy) = (self.yaw.cos(), self.yaw.sin());
        let dir = [cp * cy, sp, cp * sy]; // eye offset direction
        let eye = [
            center[0] + dir[0] * self.distance,
            center[1] + dir[1] * self.distance,
            center[2] + dir[2] * self.distance,
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
            _p3: 0.0,
            _p4: 0.0,
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
        let c = OrbitCamera::default().basis(1.0, 64.0);
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
    }

    #[test]
    fn cam_uniform_size_matches_wgsl_std140_padding() {
        // shaders/raymarch.wgsl's `Cam` struct: 3 vec3+pad fields (16 bytes each = 48) + up
        // (vec3, 12 bytes) + 4 trailing f32s (16 bytes) = 76 bytes, then WGSL rounds the struct
        // size up to a multiple of its own alignment (16, from the vec3 members) = 80 bytes.
        assert_eq!(std::mem::size_of::<CamUniform>(), 80);
    }
}
