@group(0) @binding(0) var vol: texture_3d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Cam {
  eye: vec3<f32>, _p0: f32,
  fwd: vec3<f32>, _p1: f32,
  right: vec3<f32>, _p2: f32,
  up: vec3<f32>,
  aspect: f32, tan_half_fov: f32, steps: f32, macro_dim: f32, frac: f32,
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
  let hit = intersect_aabb(ro, rd, vec3<f32>(0.0), vec3<f32>(1.0));
  let tnear = hit.x; let tfar = hit.y;
  if (tnear > tfar || tfar < 0.0) { return vec4<f32>(0.02, 0.02, 0.03, 1.0); }
  let start = max(tnear, 0.0);
  let steps = C.steps;
  let dt = (tfar - start) / steps;
  let md = C.macro_dim;
  var t = start + dt * 0.5;
  var acc = vec3<f32>(0.0); var trans = 1.0;
  for (var i = 0; i < 1024; i = i + 1) {
    if (f32(i) >= steps || t > tfar) { break; }
    let pos = ro + rd * t;
    // Empty-space skip: if this macrocell's max density is below threshold, jump straight to
    // its far boundary (AABB exit) instead of fine-marching the void. Ported from v2
    // `src/shaders/preview/raymarch.frag.glsl` sparse path (pos/rd already in [0,1]³ here, so
    // no per-tile rescale). Occupancy is a macrocell overlay — sample its cell center.
    let mc = floor(pos * md);
    let occ_uvw = (mc + 0.5) / md;
    // Skip on the UNION of both frames: never skip a macrocell occupied in EITHER frame, or an
    // interpolated feature crossing this cell would vanish. Live/paused (occ_b==occ) → max is a
    // no-op, skip grid unchanged.
    let maxd = max(textureSampleLevel(occ, occ_samp, occ_uvw, 0.0).r,
                   textureSampleLevel(occ_b, occ_samp, occ_uvw, 0.0).r);
    if (maxd < SKIP_THRESHOLD) {
      let exit_t = intersect_aabb(pos, rd, mc / md, (mc + 1.0) / md);
      t = t + max(dt, exit_t.y + 1e-4);
      continue;
    }
    // Interpolate the two frames (lerps color .rgb + density .a). frac==0 → sa unchanged.
    let sa = textureSampleLevel(vol, samp, pos, 0.0);
    let sb = textureSampleLevel(vol_b, samp, pos, 0.0);
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
