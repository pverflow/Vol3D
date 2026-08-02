@group(0) @binding(0) var vol: texture_3d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Cam {
  eye: vec3<f32>, _p0: f32,
  fwd: vec3<f32>, _p1: f32,
  right: vec3<f32>, _p2: f32,
  up: vec3<f32>,
  aspect: f32, tan_half_fov: f32, steps: f32,
  macro_dims_x: f32, macro_dims_y: f32, macro_dims_z: f32,
  frac: f32,
  box_aspect_x: f32, box_aspect_y: f32, box_aspect_z: f32,
};
@group(0) @binding(2) var<uniform> C: Cam;
// Occupancy overlay (Task 1): r32float max-density per 8³ macrocell. Non-filterable, so a
// NEAREST/clamp sampler (binding 4). Sampled below to skip empty macrocells.
@group(0) @binding(3) var occ: texture_3d<f32>;
@group(0) @binding(4) var occ_samp: sampler;
// Temporal interpolation (Task 2): the second baked frame (i+1) and its occupancy overlay. Reuse
// `samp` (1) for both volumes and `occ_samp` (4) for both occupancies. For live/paused these are
// bound to the SAME textures as `vol`/`occ` with `C.frac == 0`, so the march below is byte-
// identical to the single-frame path.
@group(0) @binding(5) var vol_b: texture_3d<f32>;
@group(0) @binding(6) var occ_b: texture_3d<f32>;

// A macrocell whose max density is below this contributes nothing worth marching — skip it.
const SKIP_THRESHOLD: f32 = 2.0 / 255.0;

// Ray/box slab test in [0,1]³ space. Returns (tnear, tfar) along `rd` from `ro`.
// Used for both the outer volume box and the per-macrocell empty-space jump.
fn intersect_aabb(ro: vec3<f32>, rd: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> vec2<f32> {
  let t0 = (bmin - ro) / rd;
  let t1 = (bmax - ro) / rd;
  let tn3 = min(t0, t1);
  let tf3 = max(t0, t1);
  let tnear = max(max(tn3.x, tn3.y), tn3.z);
  let tfar = min(min(tf3.x, tf3.y), tf3.z);
  return vec2<f32>(tnear, tfar);
}

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  var o: VsOut;
  o.pos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = p[vi] * 0.5 + 0.5;
  return o;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let screen = in.uv * 2.0 - 1.0;
  let rd = normalize(C.fwd + screen.x * C.right * C.aspect * C.tan_half_fov + screen.y * C.up * C.tan_half_fov);
  let ro = C.eye;
  // Physical box: [0,asp]³ instead of the unit cube — a non-cubic volume (Task 1) renders taller/
  // wider along whichever axis has more voxels instead of being squashed into a cube. At
  // asp=[1,1,1] (cubic) this is exactly the old vec3(0.0)..vec3(1.0) box.
  let asp = vec3<f32>(C.box_aspect_x, C.box_aspect_y, C.box_aspect_z);
  let hit = intersect_aabb(ro, rd, vec3<f32>(0.0), asp);
  let tnear = hit.x; let tfar = hit.y;
  if (tnear > tfar || tfar < 0.0) { return vec4<f32>(0.02, 0.02, 0.03, 1.0); }
  let start = max(tnear, 0.0);
  let steps = C.steps;
  let dt = (tfar - start) / steps;
  let md = vec3<f32>(C.macro_dims_x, C.macro_dims_y, C.macro_dims_z);
  var t = start + dt * 0.5;
  var acc = vec3<f32>(0.0); var trans = 1.0;
  for (var i = 0; i < 1024; i = i + 1) {
    if (f32(i) >= steps || t > tfar) { break; }
    let pos = ro + rd * t;
    // Volume/occupancy textures are still sampled in [0,1]³ regardless of the physical box's
    // aspect, so rescale the physical-space position back to unit space. At asp=[1,1,1] this is
    // uvw==pos, identical to before.
    let uvw = pos / asp;
    // Empty-space skip: if this macrocell's max density is below threshold, jump straight to
    // its far boundary (AABB exit) instead of fine-marching the void. Ported from v2
    // `src/shaders/preview/raymarch.frag.glsl` sparse path. Occupancy is a macrocell overlay —
    // sample its cell center. `md` is now per-axis (Task 2): a non-cubic volume has a different
    // macrocell count along each axis.
    let mc = floor(uvw * md);
    let occ_uvw = (mc + vec3<f32>(0.5)) / md;
    // Skip on the UNION of both frames: never skip a macrocell occupied in EITHER frame, or an
    // interpolated feature crossing this cell would vanish. Live/paused (occ_b==occ) → max is a
    // no-op, skip grid unchanged.
    let maxd = max(textureSampleLevel(occ, occ_samp, occ_uvw, 0.0).r,
                   textureSampleLevel(occ_b, occ_samp, occ_uvw, 0.0).r);
    if (maxd < SKIP_THRESHOLD) {
      // Far-edge jump back in physical space (t marches along `rd` from `ro`, both physical).
      let exit_t = intersect_aabb(pos, rd, (mc / md) * asp, ((mc + vec3<f32>(1.0)) / md) * asp);
      t = t + max(dt, exit_t.y + 1e-4);
      continue;
    }
    // Interpolate the two frames (lerps color .rgb + density .a). frac==0 → sa unchanged.
    let sa = textureSampleLevel(vol, samp, uvw, 0.0);
    let sb = textureSampleLevel(vol_b, samp, uvw, 0.0);
    let s = mix(sa, sb, C.frac);
    if (s.a > 0.001) {
      let a = 1.0 - exp(-s.a * dt * 12.0);
      acc = acc + s.rgb * a * trans;
      trans = trans * (1.0 - a);
    }
    if (trans < 0.01) { break; }
    t = t + dt;
  }
  return vec4<f32>(pow(acc, vec3<f32>(0.4545)), 1.0);
}
