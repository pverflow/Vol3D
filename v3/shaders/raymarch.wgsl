@group(0) @binding(0) var vol: texture_3d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Cam {
  eye: vec3<f32>, _p0: f32,
  fwd: vec3<f32>, _p1: f32,
  right: vec3<f32>, _p2: f32,
  up: vec3<f32>,
  aspect: f32, tan_half_fov: f32, steps: f32, _p3: f32,
};
@group(0) @binding(2) var<uniform> C: Cam;

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
  let t0 = (vec3<f32>(0.0) - ro) / rd;
  let t1 = (vec3<f32>(1.0) - ro) / rd;
  let tn3 = min(t0, t1); let tf3 = max(t0, t1);
  let tnear = max(max(tn3.x, tn3.y), tn3.z);
  let tfar = min(min(tf3.x, tf3.y), tf3.z);
  if (tnear > tfar || tfar < 0.0) { return vec4<f32>(0.02, 0.02, 0.03, 1.0); }
  let start = max(tnear, 0.0);
  let steps = C.steps;
  let dt = (tfar - start) / steps;
  var t = start + dt * 0.5;
  var acc = vec3<f32>(0.0); var trans = 1.0;
  for (var i = 0; i < 1024; i = i + 1) {
    if (f32(i) >= steps) { break; }
    let pos = ro + rd * t;
    let s = textureSampleLevel(vol, samp, pos, 0.0);
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
