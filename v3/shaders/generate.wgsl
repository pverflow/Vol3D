// Generation compute shader (v3 cycle 2, Task 2).
//
// Ports v2's GLSL noise/remap/feather/blend library (src/shaders/**) to WGSL
// and evaluates the per-voxel layer stack described by `GpuLayer` (mirrors
// the Rust `#[repr(C)]` struct in v3/src/layer.rs byte-for-byte). Each
// function below is a line-by-line translation of its v2 GLSL source; the
// source file:lines are noted per section. Task 3 wires the Rust side
// (bind group layout, buffer upload) to this shader.
//
// noise_type u32 mapping (must match v3/src/layer.rs `NoiseType`, pinned by
// Task 1): 0 = Value, 1 = Perlin, 2 = Simplex, 3 = Fbm, 4 = SdfSphere,
// 5 = Worley, 6 = Voronoi, 7 = White (Worley/Voronoi/White added cycle 4
// task 1, v2 parity port).
// blend_mode u32 mapping (must match v3/src/layer.rs `BlendMode`, same v2
// BLEND_MODE_INDEX order): 0 Normal, 1 Add, 2 Multiply, 3 Screen,
// 4 Overlay, 5 Subtract, 6 SmoothMin.

// ---------------------------------------------------------------------
// Support: src/shaders/common/hash.glsl
// ---------------------------------------------------------------------

// hash.glsl L3-8
fn hash11(p_in: f32) -> f32 {
  var p = fract(p_in * 0.1031);
  p = p * (p + 33.33);
  p = p * (p + p);
  return fract(p);
}

// hash.glsl L10-14
fn hash13(p3_in: vec3<f32>) -> f32 {
  var p3 = fract(p3_in * 0.1031);
  p3 = p3 + vec3<f32>(dot(p3, p3.zyx + vec3<f32>(31.32)));
  return fract((p3.x + p3.y) * p3.z);
}

// hash.glsl L16-20. Used by noise_worley/noise_voronoi below (cycle 4 task
// 1).
fn hash33(p3_in: vec3<f32>) -> vec3<f32> {
  var p3 = fract(p3_in * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + vec3<f32>(dot(p3, p3.yxz + vec3<f32>(33.33)));
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// hash.glsl L22-26 (ported for parity; not currently called — no v2 source
// used hash23 either).
fn hash23(p3_in: vec3<f32>) -> vec2<f32> {
  var p3 = fract(p3_in * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + vec3<f32>(dot(p3, p3.yzx + vec3<f32>(33.33)));
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ---------------------------------------------------------------------
// Support: src/shaders/common/math_utils.glsl
// ---------------------------------------------------------------------

// math_utils.glsl L3 (vec3 overload). WGSL has no function overloading by
// param type, so the vec3/vec4 GLSL overloads get distinct names.
fn mod289_3(x: vec3<f32>) -> vec3<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

// math_utils.glsl L4 (vec4 overload)
fn mod289_4(x: vec4<f32>) -> vec4<f32> {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

// math_utils.glsl L5
fn permute(x: vec4<f32>) -> vec4<f32> {
  return mod289_4(((x * 34.0) + 10.0) * x);
}

// math_utils.glsl L6
fn taylor_inv_sqrt(r: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(1.79284291400159) - vec4<f32>(0.85373472095314) * r;
}

// math_utils.glsl L7
fn fade3(t: vec3<f32>) -> vec3<f32> {
  return t * t * t * (t * (t * 6.0 - vec3<f32>(15.0)) + vec3<f32>(10.0));
}

// math_utils.glsl L10-13
fn rot_x(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, c, -s), vec3<f32>(0.0, s, c));
}

// math_utils.glsl L14-17
fn rot_y(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(vec3<f32>(c, 0.0, s), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(-s, 0.0, c));
}

// math_utils.glsl L18-21 (ported for parity with the source file; unused by
// the layer loop today — fbm only uses rot_x/rot_y per-octave, matching v2).
fn rot_z(a: f32) -> mat3x3<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat3x3<f32>(vec3<f32>(c, -s, 0.0), vec3<f32>(s, c, 0.0), vec3<f32>(0.0, 0.0, 1.0));
}

// math_utils.glsl L24-26: v2's generic remap() had no callers in
// layer_gen.frag.glsl (that file inlines its own in/out-range math inside
// applyRemapCurve, see apply_remap_curve below) and wasn't called from this
// file either — dropped entirely rather than ported dead (fix round 1
// review).

// math_utils.glsl L29-32 (ported for parity; the blend-mode smooth-min below
// is blend_modes.glsl's own blendSmoothMin, which uses a different sign on
// the correction term — see blend_smooth_min. Not the same function, kept
// distinct on purpose to match each source file exactly.)
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/value3d.glsl -> noise_value(p, seed)
// (seed threaded as an explicit param instead of the v2 `u_seed` uniform,
// per the brief: GpuLayer fields replace global uniforms.)
// ---------------------------------------------------------------------

// value3d.glsl L4-6 (_valueLattice)
fn value_lattice(ip: vec3<f32>, seed: f32) -> f32 {
  return hash13(ip + vec3<f32>(seed * 0.37));
}

// value3d.glsl L8-27 (noiseEval)
fn noise_value(p: vec3<f32>, seed: f32) -> f32 {
  let ip = floor(p);
  let fp = fract(p);
  let u = fp * fp * (vec3<f32>(3.0) - 2.0 * fp);

  let v000 = value_lattice(ip, seed);
  let v100 = value_lattice(ip + vec3<f32>(1.0, 0.0, 0.0), seed);
  let v010 = value_lattice(ip + vec3<f32>(0.0, 1.0, 0.0), seed);
  let v110 = value_lattice(ip + vec3<f32>(1.0, 1.0, 0.0), seed);
  let v001 = value_lattice(ip + vec3<f32>(0.0, 0.0, 1.0), seed);
  let v101 = value_lattice(ip + vec3<f32>(1.0, 0.0, 1.0), seed);
  let v011 = value_lattice(ip + vec3<f32>(0.0, 1.0, 1.0), seed);
  let v111 = value_lattice(ip + vec3<f32>(1.0, 1.0, 1.0), seed);

  return mix(
    mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
    mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
    u.z
  );
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/perlin3d.glsl -> noise_perlin(p, seed)
// ---------------------------------------------------------------------

// perlin3d.glsl L5-64 (_pnoise3). `rep` is passed in exactly as v2 does
// (called with vec3(289.0) below); `mod()` has no WGSL builtin, so it's
// expanded to the floor-based formula math_utils.glsl's mod289 already uses
// (GLSL's `mod(x,y) = x - y*floor(x/y)`, NOT WGSL's truncating `%`).
fn pnoise3_core(P: vec3<f32>, rep: vec3<f32>) -> f32 {
  var Pi0 = floor(P) - rep * floor(floor(P) / rep);
  var Pi1 = (Pi0 + vec3<f32>(1.0)) - rep * floor((Pi0 + vec3<f32>(1.0)) / rep);
  Pi0 = mod289_3(Pi0);
  Pi1 = mod289_3(Pi1);
  let Pf0 = fract(P);
  let Pf1 = Pf0 - vec3<f32>(1.0);
  let ix = vec4<f32>(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  let iy = vec4<f32>(Pi0.yy, Pi1.yy);
  let iz0 = Pi0.zzzz;
  let iz1 = Pi1.zzzz;

  let ixy = permute(permute(ix) + iy);
  let ixy0 = permute(ixy + iz0);
  let ixy1 = permute(ixy + iz1);

  var gx0 = ixy0 * (1.0 / 7.0);
  var gy0 = fract(floor(gx0) * (1.0 / 7.0)) - vec4<f32>(0.5);
  gx0 = fract(gx0);
  let gz0 = vec4<f32>(0.5) - abs(gx0) - abs(gy0);
  let sz0 = step(gz0, vec4<f32>(0.0));
  gx0 = gx0 - sz0 * (step(vec4<f32>(0.0), gx0) - vec4<f32>(0.5));
  gy0 = gy0 - sz0 * (step(vec4<f32>(0.0), gy0) - vec4<f32>(0.5));

  var gx1 = ixy1 * (1.0 / 7.0);
  var gy1 = fract(floor(gx1) * (1.0 / 7.0)) - vec4<f32>(0.5);
  gx1 = fract(gx1);
  let gz1 = vec4<f32>(0.5) - abs(gx1) - abs(gy1);
  let sz1 = step(gz1, vec4<f32>(0.0));
  gx1 = gx1 - sz1 * (step(vec4<f32>(0.0), gx1) - vec4<f32>(0.5));
  gy1 = gy1 - sz1 * (step(vec4<f32>(0.0), gy1) - vec4<f32>(0.5));

  var g000 = vec3<f32>(gx0.x, gy0.x, gz0.x);
  var g100 = vec3<f32>(gx0.y, gy0.y, gz0.y);
  var g010 = vec3<f32>(gx0.z, gy0.z, gz0.z);
  var g110 = vec3<f32>(gx0.w, gy0.w, gz0.w);
  var g001 = vec3<f32>(gx1.x, gy1.x, gz1.x);
  var g101 = vec3<f32>(gx1.y, gy1.y, gz1.y);
  var g011 = vec3<f32>(gx1.z, gy1.z, gz1.z);
  var g111 = vec3<f32>(gx1.w, gy1.w, gz1.w);

  let norm0 = taylor_inv_sqrt(vec4<f32>(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 = g000 * norm0.x;
  g010 = g010 * norm0.y;
  g100 = g100 * norm0.z;
  g110 = g110 * norm0.w;
  let norm1 = taylor_inv_sqrt(vec4<f32>(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 = g001 * norm1.x;
  g011 = g011 * norm1.y;
  g101 = g101 * norm1.z;
  g111 = g111 * norm1.w;

  let n000 = dot(g000, Pf0);
  let n100 = dot(g100, vec3<f32>(Pf1.x, Pf0.y, Pf0.z));
  let n010 = dot(g010, vec3<f32>(Pf0.x, Pf1.y, Pf0.z));
  let n110 = dot(g110, vec3<f32>(Pf1.x, Pf1.y, Pf0.z));
  let n001 = dot(g001, vec3<f32>(Pf0.x, Pf0.y, Pf1.z));
  let n101 = dot(g101, vec3<f32>(Pf1.x, Pf0.y, Pf1.z));
  let n011 = dot(g011, vec3<f32>(Pf0.x, Pf1.y, Pf1.z));
  let n111 = dot(g111, Pf1);

  let fade_xyz = fade3(Pf0);
  let n_z = mix(vec4<f32>(n000, n100, n010, n110), vec4<f32>(n001, n101, n011, n111), fade_xyz.z);
  let n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  return 2.2 * mix(n_yz.x, n_yz.y, fade_xyz.x);
}

// perlin3d.glsl L66-73 (noiseEval)
fn noise_perlin(p: vec3<f32>, seed: f32) -> f32 {
  let seed_offset = vec3<f32>(
    hash11(seed * 0.1031 + 4.0),
    hash11(seed * 0.1137 + 5.0),
    hash11(seed * 0.0973 + 6.0)
  ) * 256.0;
  return pnoise3_core(p + seed_offset, vec3<f32>(289.0)) * 0.5 + 0.5;
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/simplex3d.glsl -> noise_simplex(p, seed)
// ---------------------------------------------------------------------

// simplex3d.glsl L5-59 (_snoise3). Permutation/gradient constants copied
// exactly (1/6, 1/3, 0.142857142857 = 1/7, etc.) — this is the fiddliest
// port in the file, see task report for the specific mechanics that needed
// care (mod289 reuse, swizzle-repeat patterns, scalar/vector arithmetic).
fn snoise3_core(v: vec3<f32>) -> f32 {
  let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);

  var i = floor(v + vec3<f32>(dot(v, C.yyy)));
  let x0 = v - i + vec3<f32>(dot(i, C.xxx));

  let g = step(x0.yzx, x0.xyz);
  let l = vec3<f32>(1.0) - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);

  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;

  i = mod289_3(i);
  let p = permute(permute(permute(
      vec4<f32>(i.z) + vec4<f32>(0.0, i1.z, i2.z, 1.0))
      + vec4<f32>(i.y) + vec4<f32>(0.0, i1.y, i2.y, 1.0))
      + vec4<f32>(i.x) + vec4<f32>(0.0, i1.x, i2.x, 1.0));

  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;

  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);

  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = vec4<f32>(1.0) - abs(x) - abs(y);

  let b0 = vec4<f32>(x.xy, y.xy);
  let b1 = vec4<f32>(x.zw, y.zw);

  let s0 = floor(b0) * 2.0 + vec4<f32>(1.0);
  let s1 = floor(b1) * 2.0 + vec4<f32>(1.0);
  let sh = -step(h, vec4<f32>(0.0));

  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;

  var p0 = vec3<f32>(a0.xy, h.x);
  var p1 = vec3<f32>(a0.zw, h.y);
  var p2 = vec3<f32>(a1.xy, h.z);
  var p3 = vec3<f32>(a1.zw, h.w);

  let norm = taylor_inv_sqrt(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;

  var m = max(vec4<f32>(0.5) - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
  m = m * m;
  return 105.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// simplex3d.glsl L61-68 (noiseEval)
fn noise_simplex(p: vec3<f32>, seed: f32) -> f32 {
  let seed_offset = vec3<f32>(
    hash11(seed * 0.1031 + 1.0),
    hash11(seed * 0.1137 + 2.0),
    hash11(seed * 0.0973 + 3.0)
  ) * 256.0;
  return snoise3_core(p + seed_offset) * 0.5 + 0.5;
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/fbm.glsl -> noise_fbm(p, octaves, persistence,
// lacunarity, base, seed). v2's fbm calls a base `noiseEval` injected by the
// shader assembler; here that dispatch is explicit via eval_base_noise.
// ---------------------------------------------------------------------

// Dispatch helper for fbm's per-octave base noise (matching v2's
// assembler-selected base — fbm never recurses into sdf or fbm itself).
// `base` uses the same NoiseType discriminants as noise_type (0/1/2/5/6/7
// meaningful here). Worley's base case has no `GpuLayer` in scope to read a
// per-layer worley_mode from, so it hardcodes mode 0u (F1).
fn eval_base_noise(base: u32, p: vec3<f32>, seed: f32) -> f32 {
  switch (base) {
    case 0u: { return noise_value(p, seed); }
    case 1u: { return noise_perlin(p, seed); }
    case 2u: { return noise_simplex(p, seed); }
    case 5u: { return noise_worley(p, seed, 0u); }
    case 6u: { return noise_voronoi(p, seed); }
    case 7u: { return noise_white(p, seed); }
    default: { return noise_value(p, seed); }
  }
}

// fbm.glsl L9-26 (noiseEval)
fn noise_fbm(p_in: vec3<f32>, octaves: u32, persistence: f32, lacunarity: f32, base: u32, seed: f32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var max_value = 0.0;
  var p = p_in;

  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    if (i >= octaves) {
      break;
    }
    value = value + eval_base_noise(base, p * frequency, seed) * amplitude;
    max_value = max_value + amplitude;
    amplitude = amplitude * persistence;
    frequency = frequency * lacunarity;
    // Per-octave rotation to break axis alignment (fbm.glsl L22).
    p = rot_x(0.5) * rot_y(0.3) * p;
  }

  return value / max_value;
}

// ---------------------------------------------------------------------
// SDF: src/shaders/noise/sdf_sphere.glsl -> sdf_sphere(p, radius, softness)
// ---------------------------------------------------------------------

// sdf_sphere.glsl L6-9 (noiseEval)
fn sdf_sphere(p: vec3<f32>, radius: f32, softness: f32) -> f32 {
  let sd = length(p) - radius;
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// True for noise_type values whose eval_noise is a signed-distance shape
// (4=SdfSphere, 8..12=box/cone/capsule/cylinder/plume) rather than a
// procedural noise field — mirrors layer.rs's NoiseType::is_sdf.
fn is_sdf(t: u32) -> bool {
  return t == 4u || t >= 8u;
}

// sdf_box.glsl L6-12 (noiseEval). Box half-extent = sdf_radius on all 3 axes.
fn sdf_box(p: vec3<f32>, radius: f32, softness: f32) -> f32 {
  let q = abs(p) - vec3<f32>(radius);
  let outside = length(max(q, vec3<f32>(0.0)));
  let inside = min(max(q.x, max(q.y, q.z)), 0.0);
  let sd = outside + inside;
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// sdf_cone.glsl L7-13 (noiseEval). Capped cone along +Y, height = 2*radius,
// base radius = radius; `h` floors at 1e-4 to avoid divide-by-zero at
// radius=0.
fn sdf_cone(p: vec3<f32>, radius: f32, softness: f32) -> f32 {
  let h = max(radius, 1e-4);
  let d2 = length(p.xz) - radius * (1.0 - (p.y + h) / (2.0 * h));
  let dy = abs(p.y) - h;
  let sd = max(d2, dy);
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// sdf_capsule.glsl L9-14 (noiseEval). Capsule along +Y; `height` is the
// half-height of the straight segment between the two end caps.
fn sdf_capsule(p: vec3<f32>, radius: f32, softness: f32, height: f32) -> f32 {
  let h = max(height, 1e-4);
  let cy = clamp(p.y, -h, h);
  let sd = length(vec3<f32>(p.x, p.y - cy, p.z)) - radius;
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// sdf_cylinder.glsl L9-17 (noiseEval). Flat-capped cylinder along +Y;
// `height` is the half-height.
fn sdf_cylinder(p: vec3<f32>, radius: f32, softness: f32, height: f32) -> f32 {
  let h = max(height, 1e-4);
  let dx = length(p.xz) - radius;
  let dy = abs(p.y) - h;
  let outside = length(vec2<f32>(max(dx, 0.0), max(dy, 0.0)));
  let inside = min(max(dx, dy), 0.0);
  let sd = outside + inside;
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// sdf_plume.glsl L9-16 (noiseEval). Tapered capsule along +Y (radius shrinks
// linearly base->top to 15%, flame silhouette); `height` is the half-height.
fn sdf_plume(p: vec3<f32>, radius: f32, softness: f32, height: f32) -> f32 {
  let h = max(height, 1e-4);
  let t = clamp((p.y + h) / (2.0 * h), 0.0, 1.0);
  let rr = radius * (1.0 - 0.85 * t);
  let cy = clamp(p.y, -h, h);
  let sd = length(vec3<f32>(p.x, p.y - cy, p.z)) - rr;
  return 1.0 - smoothstep(0.0, max(softness, 1e-4), sd);
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/worley3d.glsl -> noise_worley(p, seed, mode)
// worley_mode: 0 = F1, 1 = F2, 2 = F2-F1 (matches v2's u_worleyMode /
// TS WorleyMode enum order, src/types/noise.ts).
// ---------------------------------------------------------------------

// worley3d.glsl L7-25 (_worley3) — 3x3x3 cell search, returns vec2(F1, F2).
fn worley_f1f2(p: vec3<f32>, seed: f32) -> vec2<f32> {
  let ip = floor(p);
  let fp = fract(p);

  var f1 = 999.0;
  var f2 = 999.0;

  for (var k: i32 = -1; k <= 1; k = k + 1) {
    for (var j: i32 = -1; j <= 1; j = j + 1) {
      for (var i: i32 = -1; i <= 1; i = i + 1) {
        let cell = vec3<f32>(f32(i), f32(j), f32(k));
        let cell_point = cell + hash33(ip + cell + vec3<f32>(seed));
        let d = length(cell_point - fp);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  return vec2<f32>(f1, f2);
}

// worley3d.glsl L27-32 (noiseEval)
fn noise_worley(p: vec3<f32>, seed: f32, mode: u32) -> f32 {
  let f = worley_f1f2(p, seed);
  if (mode == 0u) {
    return clamp(1.0 - f.x * 1.5, 0.0, 1.0);
  } else if (mode == 1u) {
    return clamp(1.0 - f.y * 1.1, 0.0, 1.0);
  }
  return clamp((f.y - f.x) * 2.0, 0.0, 1.0);
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/voronoi3d.glsl -> noise_voronoi(p, seed)
// ---------------------------------------------------------------------

// voronoi3d.glsl L4-6 (_voronoiPoint)
fn voronoi_point(cell: vec3<f32>, seed: f32) -> vec3<f32> {
  return cell + hash33(cell + vec3<f32>(seed * 0.1));
}

// voronoi3d.glsl L8-36 (noiseEval). v2 also computes `fp = fract(p)` and a
// `minPoint` that are assigned but never read (the returned edge value only
// depends on minDist/secondDist) — dropped here as dead code.
fn noise_voronoi(p: vec3<f32>, seed: f32) -> f32 {
  let ip = floor(p);

  var min_dist = 999.0;
  var second_dist = 999.0;

  for (var k: i32 = -1; k <= 1; k = k + 1) {
    for (var j: i32 = -1; j <= 1; j = j + 1) {
      for (var i: i32 = -1; i <= 1; i = i + 1) {
        let cell = ip + vec3<f32>(f32(i), f32(j), f32(k));
        let cell_point = voronoi_point(cell, seed);
        let d = length(cell_point - p);
        if (d < min_dist) {
          second_dist = min_dist;
          min_dist = d;
        } else if (d < second_dist) {
          second_dist = d;
        }
      }
    }
  }

  // Smooth cell edges (voronoi3d.glsl L34-35).
  let edge = second_dist - min_dist;
  return clamp(edge * 2.5, 0.0, 1.0);
}

// ---------------------------------------------------------------------
// Noise: src/shaders/noise/white3d.glsl -> noise_white(p, seed)
// ---------------------------------------------------------------------

// white3d.glsl L4-6 (noiseEval)
fn noise_white(p: vec3<f32>, seed: f32) -> f32 {
  return hash13(floor(p) + vec3<f32>(seed * 0.91));
}

// ---------------------------------------------------------------------
// Remap/feather/bezier: src/shaders/generation/layer_gen.frag.glsl
// ---------------------------------------------------------------------

// layer_gen.frag.glsl L93-95
fn saturate01(v: f32) -> f32 {
  return clamp(v, 0.0, 1.0);
}

// layer_gen.frag.glsl L97-102
fn cubic_bezier_point(p1: vec2<f32>, p2: vec2<f32>, t: f32) -> vec2<f32> {
  let omt = 1.0 - t;
  return 3.0 * omt * omt * t * p1
    + 3.0 * omt * t * t * p2
    + t * t * t * vec2<f32>(1.0);
}

// layer_gen.frag.glsl L104-116
fn evaluate_bezier_curve(curve: vec4<f32>, x: f32) -> f32 {
  let p1 = curve.xy;
  let p2 = curve.zw;
  var lo = 0.0;
  var hi = 1.0;
  for (var i: i32 = 0; i < 10; i = i + 1) {
    let mid = 0.5 * (lo + hi);
    let bx = cubic_bezier_point(p1, p2, mid).x;
    if (bx < x) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return cubic_bezier_point(p1, p2, 0.5 * (lo + hi)).y;
}

// layer_gen.frag.glsl L118-122 (applyRemapCurve) — fix round 1: this is now
// the ONE remap function the loop calls, matching v2 exactly: normalize v
// into [0,1] via in_min/in_max (v2's u_remapInput), bezier-warp it, then
// rescale into out_min/out_max (v2's u_remapOutput). (Fix round 1 removed
// the separate `remap()` pre-pass a prior draft inserted before this —
// v2 has only this one function, no linear pre-remap.)
fn apply_remap_curve(v: f32, L: GpuLayer) -> f32 {
  let t0 = saturate01((v - L.in_min) / max(L.in_max - L.in_min, 0.0001));
  let t1 = evaluate_bezier_curve(L.remap_curve, t0);
  return mix(L.out_min, L.out_max, t1);
}

// layer_gen.frag.glsl L124-136
fn feather_mask_box(volume_pos: vec3<f32>, feather_width: vec3<f32>) -> f32 {
  let widths = max(feather_width, vec3<f32>(0.0));
  if (widths.x <= 0.0001 && widths.y <= 0.0001 && widths.z <= 0.0001) {
    return 1.0;
  }

  let edge_dist = min(volume_pos, vec3<f32>(1.0) - volume_pos);
  var axis_mask = vec3<f32>(1.0);

  if (widths.x > 0.0001) {
    axis_mask.x = saturate01(edge_dist.x / widths.x);
  }
  if (widths.y > 0.0001) {
    axis_mask.y = saturate01(edge_dist.y / widths.y);
  }
  if (widths.z > 0.0001) {
    axis_mask.z = saturate01(edge_dist.z / widths.z);
  }

  return min(axis_mask.x, min(axis_mask.y, axis_mask.z));
}

// layer_gen.frag.glsl L138-140
fn ellipsoid_radius_along_dir(dir: vec3<f32>, radii: vec3<f32>) -> f32 {
  return 1.0 / max(length(dir / max(radii, vec3<f32>(0.0001))), 0.0001);
}

// layer_gen.frag.glsl L142-157
fn feather_mask_sphere(volume_pos: vec3<f32>, feather_width: vec3<f32>) -> f32 {
  let widths = clamp(feather_width, vec3<f32>(0.0), vec3<f32>(0.499));
  if (widths.x <= 0.0001 && widths.y <= 0.0001 && widths.z <= 0.0001) {
    return 1.0;
  }

  let centered = volume_pos - vec3<f32>(0.5);
  let dist = length(centered);
  if (dist <= 0.0001) {
    return 1.0;
  }

  let dir = centered / dist;
  let outer_radii = vec3<f32>(0.5);
  let inner_radii = max(outer_radii - widths, vec3<f32>(0.0005));
  let outer_dist = ellipsoid_radius_along_dir(dir, outer_radii);
  let inner_dist = min(outer_dist, ellipsoid_radius_along_dir(dir, inner_radii));

  return 1.0 - saturate01((dist - inner_dist) / max(outer_dist - inner_dist, 0.0001));
}

// layer_gen.frag.glsl L159-166 (applyFeather). feather_shape/feather_curve
// come from the current layer, per the brief's Step 3 signature
// `apply_feather(uvw, v, L)`.
fn apply_feather(volume_pos: vec3<f32>, density: f32, L: GpuLayer) -> f32 {
  var mask: f32;
  if (L.feather_shape == 1u) {
    mask = feather_mask_sphere(volume_pos, L.feather.xyz);
  } else {
    mask = feather_mask_box(volume_pos, L.feather.xyz);
  }
  mask = evaluate_bezier_curve(L.feather_curve, saturate01(mask));
  return density * mask;
}

// ---------------------------------------------------------------------
// Blend: src/shaders/common/blend_modes.glsl
// ---------------------------------------------------------------------

// blend_modes.glsl L4
fn blend_normal(base: f32, layer: f32) -> f32 {
  return layer;
}

// blend_modes.glsl L5
fn blend_add(base: f32, layer: f32) -> f32 {
  return clamp(base + layer, 0.0, 1.0);
}

// blend_modes.glsl L6
fn blend_multiply(base: f32, layer: f32) -> f32 {
  return base * layer;
}

// blend_modes.glsl L7
fn blend_screen(base: f32, layer: f32) -> f32 {
  return 1.0 - (1.0 - base) * (1.0 - layer);
}

// blend_modes.glsl L8-12
fn blend_overlay(base: f32, layer: f32) -> f32 {
  if (base < 0.5) {
    return 2.0 * base * layer;
  }
  return 1.0 - 2.0 * (1.0 - base) * (1.0 - layer);
}

// blend_modes.glsl L13
fn blend_subtract(base: f32, layer: f32) -> f32 {
  return clamp(base - layer, 0.0, 1.0);
}

// blend_modes.glsl L14-18 (blendSmoothMin). NOTE: this uses `+ k*h*(1-h)`,
// the opposite sign from math_utils.glsl's generic `smin` (`- k*h*(1-h)`,
// see smin() above) — that is how each function reads in its own v2 source
// file, kept faithfully distinct rather than unified.
fn blend_smooth_min(base: f32, layer: f32) -> f32 {
  let k = 0.1;
  let h = clamp(0.5 + 0.5 * (layer - base) / k, 0.0, 1.0);
  return mix(base, layer, h) + k * h * (1.0 - h);
}

// blend_modes.glsl L21-30 (applyBlend)
fn apply_blend(mode: i32, base: f32, layer: f32) -> f32 {
  switch (mode) {
    case 0: { return blend_normal(base, layer); }
    case 1: { return blend_add(base, layer); }
    case 2: { return blend_multiply(base, layer); }
    case 3: { return blend_screen(base, layer); }
    case 4: { return blend_overlay(base, layer); }
    case 5: { return blend_subtract(base, layer); }
    case 6: { return blend_smooth_min(base, layer); }
    default: { return layer; }
  }
}

// ---------------------------------------------------------------------
// GpuLayer: mirrors v3/src/layer.rs `GpuLayer` (#[repr(C)], size 304, see
// `gpu_layer_std430_layout` test there) field-for-field. All-vec4/f32/u32
// fields pack tightly with natural 4-byte scalar alignment, so this
// struct's storage-buffer layout matches the Rust byte layout with no
// explicit @align/@size annotations needed.
// ---------------------------------------------------------------------

struct GpuLayer {
  rot0: vec4<f32>,          // 0   (rotation column 0, .xyz; .w pad)
  rot1: vec4<f32>,          // 16  (rotation column 1)
  rot2: vec4<f32>,          // 32  (rotation column 2)
  scale: vec4<f32>,         // 48  (.xyz = scale, .w pad)
  offset: vec4<f32>,        // 64  (.xyz = offset, .w pad)
  remap_curve: vec4<f32>,   // 80
  feather_curve: vec4<f32>, // 96
  feather: vec4<f32>,       // 112 (.xyz = feather x/y/z, .w pad)
  amplitude: f32,           // 128
  seed: f32,
  opacity: f32,
  in_min: f32,
  in_max: f32,
  out_min: f32,
  out_max: f32,
  sdf_radius: f32,          // 144
  sdf_softness: f32,
  sdf_height: f32,
  persistence: f32,
  lacunarity: f32,          // 160
  noise_type: u32,
  blend_mode: u32,
  invert: u32,
  worley_mode: u32,         // 176
  feather_shape: u32,
  octaves: u32,
  fbm_base: u32,
  distortion_type: u32,      // 204..208
  distortion_strength: f32,  // 208
  distortion_frequency: f32, // 212
  distortion_swirl: f32,     // 216
  _pad_distort: f32,         // 220..224
  // distortion-improvements cycle 4 task 1 (append-only, 0..224 unchanged):
  drot0: vec4<f32>,          // 224 (warp-space rotation column 0)
  drot1: vec4<f32>,          // 240 (warp-space rotation column 1)
  drot2: vec4<f32>,          // 256 (warp-space rotation column 2)
  warp_noise: u32,           // 272
  distortion_octaves: u32,   // 276
  // distortion-offset cycle task 1 (append-only, 0..280 unchanged; the two
  // former _pad_di0/1 scalars are now live fields, plus one more appended):
  distortion_offset_x: f32,  // 280 (was _pad_di0)
  distortion_offset_y: f32,  // 284 (was _pad_di1)
  distortion_offset_z: f32,  // 288
  _pad_do0: f32,             // 292
  _pad_do1: f32,             // 296
  _pad_do2: f32,             // 300..304 (pad to 16-byte multiple)
};

// dim_x/dim_y/dim_z replace cubic `res` (v3 non-cubic-volume cycle, Task 1); aspect_x/y/z
// (`anim::aspect_from_dims` on the CPU side) correct sample_noise_at's uvw so a non-cubic
// volume's proportions stay true instead of stretching with the voxel grid. At dims=[n,n,n]
// (aspect=[1,1,1]) generation is byte-identical to the old cubic path. _pad0.._pad2 keep the
// struct a 16-byte multiple (mirrors v3/src/layer.rs `GenParams`, 48 bytes, same field order).
struct GenParams {
  dim_x: u32,
  dim_y: u32,
  dim_z: u32,
  layer_count: u32,
  aspect_x: f32,
  aspect_y: f32,
  aspect_z: f32,
  anim_phase: f32,
  anim_evolutions: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

// ---------------------------------------------------------------------
// Bindings (group 0)
// ---------------------------------------------------------------------

@group(0) @binding(0) var vol: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> params: GenParams;
@group(0) @binding(2) var<storage, read> layers: array<GpuLayer>;
@group(0) @binding(3) var ramp_lut: texture_2d<f32>;
@group(0) @binding(4) var ramp_samp: sampler;

// eval_noise(L, p): dispatches on L.noise_type. 0=value,1=perlin,2=simplex,
// 3=fbm,4=sdf_sphere,5=worley,6=voronoi,7=white,8=sdf_box,9=sdf_cone,
// 10=sdf_capsule,11=sdf_cylinder,12=sdf_plume; default (and 3/fbm) reads
// the extra fields off L (octaves/persistence/lacunarity/fbm_base for fbm;
// sdf_radius/sdf_softness[/sdf_height] for the SDF shapes; worley_mode for
// worley) since WGSL has no global uniforms to fall back on.
fn eval_noise(L: GpuLayer, p: vec3<f32>) -> f32 {
  switch (L.noise_type) {
    case 0u: { return noise_value(p, L.seed); }
    case 1u: { return noise_perlin(p, L.seed); }
    case 2u: { return noise_simplex(p, L.seed); }
    case 3u: { return noise_fbm(p, L.octaves, L.persistence, L.lacunarity, L.fbm_base, L.seed); }
    case 4u: { return sdf_sphere(p, L.sdf_radius, L.sdf_softness); }
    case 5u: { return noise_worley(p, L.seed, L.worley_mode); }
    case 6u: { return noise_voronoi(p, L.seed); }
    case 7u: { return noise_white(p, L.seed); }
    case 8u: { return sdf_box(p, L.sdf_radius, L.sdf_softness); }
    case 9u: { return sdf_cone(p, L.sdf_radius, L.sdf_softness); }
    case 10u: { return sdf_capsule(p, L.sdf_radius, L.sdf_softness, L.sdf_height); }
    case 11u: { return sdf_cylinder(p, L.sdf_radius, L.sdf_softness, L.sdf_height); }
    case 12u: { return sdf_plume(p, L.sdf_radius, L.sdf_softness, L.sdf_height); }
    default: { return noise_value(p, L.seed); }
  }
}

// layer_gen.frag.glsl L27-42 (animatedDomainOffset). Domain-shift applied
// only to non-SDF (periodic noise) sources so the tiling blend's seams stay
// hidden while the noise field slowly evolves over time; `seed` here is
// `L.seed` (already folded with global_seed at pack time, per app.rs
// pack_for_gpu), matching v2's `u_seed`.
const TAU: f32 = 6.28318530718;
const ANIM_RADIUS: f32 = 4.0;

fn animated_domain_offset(seed: f32, anim_phase: f32, anim_evolutions: f32) -> vec3<f32> {
  let angle = anim_phase * anim_evolutions * TAU;
  let axis_a = normalize(vec3<f32>(
    hash11(seed * 0.031 + 21.0) * 2.0 - 1.0,
    hash11(seed * 0.037 + 22.0) * 2.0 - 1.0,
    hash11(seed * 0.041 + 23.0) * 2.0 - 1.0));
  let axis_b = normalize(vec3<f32>(
    hash11(seed * 0.043 + 24.0) * 2.0 - 1.0,
    hash11(seed * 0.047 + 25.0) * 2.0 - 1.0,
    hash11(seed * 0.053 + 26.0) * 2.0 - 1.0));
  return (axis_a * cos(angle) + axis_b * sin(angle)) * ANIM_RADIUS;
}

// Distortion: src/shaders/distortion/{domain_warp,curl,swirl,polar}.glsl,
// plus Turbulence (new, cycle 4 distortion-improvements task 1 — not a v2
// port).
//
// Root-fix (task 1): v2's shader assembler picked the layer's own
// `noiseEval` as the warp source for domain_warp/curl, which for an SDF
// layer (e.g. a cone) is a flat 0/1 field with ~zero gradient -> ~zero
// displacement, i.e. "distortion does nothing on SDF shapes". `warp_field`
// below always reads a real noise field (`L.warp_noise`, independent of the
// layer's own `noise_type`) so every distortion type has a usable gradient
// regardless of what the layer itself renders.
fn warp_field(L: GpuLayer, p: vec3<f32>) -> f32 {
  return eval_base_noise(L.warp_noise, p, L.seed);
}

// apply_distortion(L, p): dispatches on L.distortion_type. 0=None is an
// identity no-op (v2's IDENTITY_DISTORTION) returned before any rotation
// math runs. For the active types (1=DomainWarp, 2=Curl, 3=Swirl, 4=Polar,
// 5=Turbulence) the sample point is first rotated into "warp space" by
// `L.drot{0,1,2}` (the packed `distortion_rotation`, independent of the
// layer's own rotation) so the distortion can be oriented on its own axis;
// the effect (a verbatim port of its GLSL source for 1-4, uniforms
// u_warpStrength/u_warpFrequency/u_swirlAmount -> L.distortion_strength/
// distortion_frequency/distortion_swirl) runs on the rotated point `q`, then
// the result is rotated back by `transpose(drot)` (drot is orthonormal, so
// its transpose is its inverse) before returning.
fn apply_distortion(L: GpuLayer, p: vec3<f32>) -> vec3<f32> {
  if (L.distortion_type == 0u) {
    // None: v2's IDENTITY_DISTORTION (`applyDistortion(p) { return p; }`).
    return p;
  }
  let drot = mat3x3<f32>(L.drot0.xyz, L.drot1.xyz, L.drot2.xyz);
  var q = drot * p;
  // Scrolls where the warp field is *sampled from* (keyframable) without
  // altering the returned distorted position — an offset of [0,0,0] is a
  // no-op (distortion-offset cycle task 1).
  let ofs = vec3<f32>(L.distortion_offset_x, L.distortion_offset_y, L.distortion_offset_z);
  switch (L.distortion_type) {
    case 1u: {
      // domain_warp.glsl L9-18.
      if (L.distortion_strength < 0.001) {
        return p;
      }
      let wp = (q + ofs) * L.distortion_frequency;
      let nx = warp_field(L, wp + vec3<f32>(0.0, 1.7, 9.2));
      let ny = warp_field(L, wp + vec3<f32>(8.3, 2.8, 4.1));
      let nz = warp_field(L, wp + vec3<f32>(4.0, 3.1, 6.7));
      let warp = (vec3<f32>(nx, ny, nz) - vec3<f32>(0.5)) * 2.0 * L.distortion_strength;
      q = q + warp;
    }
    case 2u: {
      // curl.glsl L6-24.
      if (L.distortion_strength < 0.001) {
        return p;
      }
      let eps: f32 = 0.01;
      let n1 = warp_field(L, q + ofs + vec3<f32>(eps, 0.0, 0.0));
      let n2 = warp_field(L, q + ofs - vec3<f32>(eps, 0.0, 0.0));
      let n3 = warp_field(L, q + ofs + vec3<f32>(0.0, eps, 0.0));
      let n4 = warp_field(L, q + ofs - vec3<f32>(0.0, eps, 0.0));
      let n5 = warp_field(L, q + ofs + vec3<f32>(0.0, 0.0, eps));
      let n6 = warp_field(L, q + ofs - vec3<f32>(0.0, 0.0, eps));
      let inv2eps = 1.0 / (2.0 * eps);
      let curl = vec3<f32>(
        (n4 - n3 - n6 + n5) * inv2eps,
        (n5 - n6 - n2 + n1) * inv2eps,
        (n2 - n1 - n3 + n4) * inv2eps
      );
      q = q + curl * L.distortion_strength;
    }
    case 3u: {
      // swirl.glsl L7-13.
      let angle = q.y * L.distortion_swirl * L.distortion_strength * 6.28318;
      let cos_a = cos(angle);
      let sin_a = sin(angle);
      let x = q.x * cos_a - q.z * sin_a;
      let z = q.x * sin_a + q.z * cos_a;
      q = vec3<f32>(x, q.y, z);
    }
    case 4u: {
      // polar.glsl L7-14.
      if (L.distortion_strength < 0.001) {
        return p;
      }
      let centered = q.xy - vec2<f32>(0.5);
      let radius = length(centered) * 2.0;
      let angle = atan2(centered.y, centered.x) / 6.28318 + 0.5;
      let polar = vec3<f32>(angle, radius, q.z);
      q = mix(q, polar, L.distortion_strength);
    }
    case 5u: {
      // Turbulence: multi-octave warp_field accumulation (fbm-like warp,
      // new for task 1 — not a v2 port). Each octave samples warp_field at
      // 3 offset points (same offsets as domain_warp) to build a
      // pseudo-curl displacement vector, doubling frequency and halving
      // amplitude per octave (mirrors noise_fbm's persistence/lacunarity
      // shape but fixed at 2.0/0.5 since there's no per-layer control here).
      if (L.distortion_strength < 0.001) {
        return p;
      }
      var freq = L.distortion_frequency;
      var amp = 1.0;
      var off = vec3<f32>(0.0, 0.0, 0.0);
      let octaves = clamp(L.distortion_octaves, 1u, 8u);
      for (var o: u32 = 0u; o < 8u; o = o + 1u) {
        if (o >= octaves) {
          break;
        }
        let wp = (q + ofs) * freq;
        off = off + (vec3<f32>(
          warp_field(L, wp + vec3<f32>(0.0, 1.7, 9.2)),
          warp_field(L, wp + vec3<f32>(8.3, 2.8, 4.1)),
          warp_field(L, wp + vec3<f32>(4.0, 3.1, 6.7))
        ) - vec3<f32>(0.5)) * 2.0 * amp;
        freq = freq * 2.0;
        amp = amp * 0.5;
      }
      q = q + off * L.distortion_strength;
    }
    default: {
      // Unreachable (distortion_type == 0u already returned above); kept so
      // the switch is exhaustive over u32.
    }
  }
  return transpose(drot) * q;
}

// layer_gen.frag.glsl L44-67 (sampleNoiseAtVolumePos) — fix round 1. Per-
// source-type position transform: SDF sources (is_sdf(noise_type) — sphere
// plus box/cone/capsule/cylinder/plume, L44-46/L48-54) center the volume
// first so offset=[0,0,0] puts the shape at uvw=0.5, and skip domain
// animation entirely (an SDF shape has no tiling seams to hide); noise
// sources (L55-59) scale+offset directly in [0,1] volume space, then
// rotate, then apply animatedDomainOffset() (L59, cycle-4 task 2). Both
// branches then run v2's `applyDistortion(p)` (L63) — wired below as
// `apply_distortion`.
fn sample_noise_at(L: GpuLayer, uvw: vec3<f32>) -> f32 {
  let rot = mat3x3<f32>(L.rot0.xyz, L.rot1.xyz, L.rot2.xyz);
  // Per-axis aspect (anim::aspect_from_dims on the CPU side): at [1,1,1] (cubic dims) this is a
  // no-op multiply, so cubic generation stays byte-identical to before non-cubic dims existed.
  let asp = vec3<f32>(params.aspect_x, params.aspect_y, params.aspect_z);
  var p: vec3<f32>;
  if (is_sdf(L.noise_type)) {
    // SDF_SOURCE branch (layer_gen.frag.glsl L48-54).
    p = ((uvw - vec3<f32>(0.5)) * asp) * L.scale.xyz + L.offset.xyz;
    p = rot * p;
  } else {
    // non-SDF branch (layer_gen.frag.glsl L56-59).
    p = (uvw * asp) * L.scale.xyz + L.offset.xyz;
    p = rot * p;
    p = p + animated_domain_offset(L.seed, params.anim_phase, params.anim_evolutions);
  }
  p = apply_distortion(L, p);
  return eval_noise(L, p);
}

// layer_gen.frag.glsl L69-91 (sampleNoiseTileable) — fix round 1. 8-corner
// trilinear blend of sample_noise_at so periodic noise tiles seamlessly
// across the volume boundary (tileSize = 1.0, matching v2 exactly).
fn sample_noise_tileable(L: GpuLayer, uvw: vec3<f32>) -> f32 {
  let blend = clamp(uvw, vec3<f32>(0.0), vec3<f32>(1.0));

  let n000 = sample_noise_at(L, uvw);
  let n100 = sample_noise_at(L, uvw - vec3<f32>(1.0, 0.0, 0.0));
  let n010 = sample_noise_at(L, uvw - vec3<f32>(0.0, 1.0, 0.0));
  let n110 = sample_noise_at(L, uvw - vec3<f32>(1.0, 1.0, 0.0));
  let n001 = sample_noise_at(L, uvw - vec3<f32>(0.0, 0.0, 1.0));
  let n101 = sample_noise_at(L, uvw - vec3<f32>(1.0, 0.0, 1.0));
  let n011 = sample_noise_at(L, uvw - vec3<f32>(0.0, 1.0, 1.0));
  let n111 = sample_noise_at(L, uvw - vec3<f32>(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, blend.x);
  let nx10 = mix(n010, n110, blend.x);
  let nx01 = mix(n001, n101, blend.x);
  let nx11 = mix(n011, n111, blend.x);

  let nxy0 = mix(nx00, nx10, blend.y);
  let nxy1 = mix(nx01, nx11, blend.y);

  return mix(nxy0, nxy1, blend.z);
}

// ---------------------------------------------------------------------
// Per-voxel layer stack — fix round 1: op order now matches v2's `main`
// (layer_gen.frag.glsl L168-192) exactly: sample (tileable, or single-shot
// for SDF sources bypassing the tiling blend per L170-177) -> applyRemapCurve
// -> amplitude -> invert -> feather -> clamp. Then (v3-only, v2 has no
// multi-layer loop — this is the per-layer compositing this cycle adds):
// blend into density with opacity mix, and painter's-over ramp color
// composite.
// ---------------------------------------------------------------------

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.dim_x || gid.y >= params.dim_y || gid.z >= params.dim_z) {
    return;
  }
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5)) /
    vec3<f32>(f32(params.dim_x), f32(params.dim_y), f32(params.dim_z));
  var density = 0.0;
  var color = vec3<f32>(0.0);
  let n = params.layer_count;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let L = layers[i];

    // layer_gen.frag.glsl L169-177: SDF sources sample once (no tiling
    // blend); everything else goes through the 8-corner tileable blend.
    var v: f32;
    if (is_sdf(L.noise_type)) {
      v = sample_noise_at(L, uvw);
    } else {
      v = sample_noise_tileable(L, uvw);
    }

    v = apply_remap_curve(v, L);       // L180: n = applyRemapCurve(n);
    v = v * L.amplitude;               // L183: n *= u_amplitude;
    if (L.invert != 0u) {              // L186: if (u_invert) n = 1.0 - n;
      v = 1.0 - v;
    }
    v = apply_feather(uvw, v, L);      // L189: n = applyFeather(volumePos, n);
    v = clamp(v, 0.0, 1.0);            // L191: n = clamp(n, 0.0, 1.0);

    let blended = apply_blend(i32(L.blend_mode), density, v);
    density = mix(density, blended, L.opacity);
    let c = textureSampleLevel(ramp_lut, ramp_samp, vec2<f32>(v, (f32(i) + 0.5) / f32(n)), 0.0);
    let a = c.a * L.opacity;
    color = c.rgb * a + color * (1.0 - a);
  }
  textureStore(vol, vec3<i32>(gid), vec4<f32>(color, density));
}
