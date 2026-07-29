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
// Task 1): 0 = Value, 1 = Perlin, 2 = Simplex, 3 = Fbm, 4 = SdfSphere.
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

// hash.glsl L16-20 (ported for fidelity/completeness; not currently called —
// v2's worley/distortion noise types are out of scope for this task, see
// GpuLayer.worley_mode/distortion_type which are carried but unused here).
fn hash33(p3_in: vec3<f32>) -> vec3<f32> {
  var p3 = fract(p3_in * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 = p3 + vec3<f32>(dot(p3, p3.yxz + vec3<f32>(33.33)));
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// hash.glsl L22-26 (see hash33 note above — unused today, ported for parity).
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

// math_utils.glsl L24-26. NOTE: not called by the layer loop — v2 itself
// never calls this generic remap() from layer_gen.frag.glsl either (that
// file has its own inline in/out-range math inside applyRemapCurve, see
// apply_remap_curve below); grepping v2's shader sources confirms this
// function has no callers there today. Ported for parity with
// math_utils.glsl only, same as smin/rot_z/hash33/hash23 above.
fn remap(v: f32, in_min: f32, in_max: f32, out_min: f32, out_max: f32) -> f32 {
  return out_min + (out_max - out_min) * clamp((v - in_min) / (in_max - in_min + 0.0001), 0.0, 1.0);
}

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

// Dispatch helper for fbm's per-octave base noise (value/perlin/simplex
// only, matching v2's assembler-selected base — fbm never recurses into sdf
// or fbm itself). `base` uses the same NoiseType discriminants as
// noise_type (0/1/2 meaningful here).
fn eval_base_noise(base: u32, p: vec3<f32>, seed: f32) -> f32 {
  switch (base) {
    case 0u: { return noise_value(p, seed); }
    case 1u: { return noise_perlin(p, seed); }
    case 2u: { return noise_simplex(p, seed); }
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
// GpuLayer: mirrors v3/src/layer.rs `GpuLayer` (#[repr(C)], size 208, see
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
  distortion_type: u32,     // 204..208
};

struct GenParams {
  res: u32,
  layer_count: u32,
  global_seed: f32,
  anim_phase: f32,
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
// 3=fbm,4=sdf_sphere; default (and 3/fbm) reads the extra fields off L
// (octaves/persistence/lacunarity/fbm_base for fbm; sdf_radius/sdf_softness
// for sdf_sphere) since WGSL has no global uniforms to fall back on.
fn eval_noise(L: GpuLayer, p: vec3<f32>) -> f32 {
  switch (L.noise_type) {
    case 0u: { return noise_value(p, L.seed); }
    case 1u: { return noise_perlin(p, L.seed); }
    case 2u: { return noise_simplex(p, L.seed); }
    case 3u: { return noise_fbm(p, L.octaves, L.persistence, L.lacunarity, L.fbm_base, L.seed); }
    case 4u: { return sdf_sphere(p, L.sdf_radius, L.sdf_softness); }
    default: { return noise_value(p, L.seed); }
  }
}

// layer_gen.frag.glsl L44-67 (sampleNoiseAtVolumePos) — fix round 1. Per-
// source-type position transform: SDF sources (noise_type 4u = SdfSphere,
// the only SDF type today, L44-46/L48-54) center the volume first so
// offset=[0,0,0] puts the shape at uvw=0.5, and skip domain animation
// entirely (an SDF shape has no tiling seams to hide); noise sources
// (L55-59) scale+offset directly in [0,1] volume space, then rotate.
// v2's `p += animatedDomainOffset();` (L59) is intentionally NOT ported —
// it's coupled to per-frame animation state (u_animPhase/u_animEvolutions),
// deferred to cycle 4. v2's `applyDistortion(p)` (L63, both branches) is
// likewise not ported — distortion_type isn't wired to any distortion
// function this cycle (same "out of scope" carve-out as Worley, see
// GpuLayer.worley_mode/distortion_type).
fn sample_noise_at(L: GpuLayer, uvw: vec3<f32>) -> f32 {
  let rot = mat3x3<f32>(L.rot0.xyz, L.rot1.xyz, L.rot2.xyz);
  var p: vec3<f32>;
  if (L.noise_type == 4u) {
    // SDF_SOURCE branch (layer_gen.frag.glsl L48-54).
    p = (uvw - vec3<f32>(0.5)) * L.scale.xyz + L.offset.xyz;
    p = rot * p;
  } else {
    // non-SDF branch (layer_gen.frag.glsl L56-59).
    p = uvw * L.scale.xyz + L.offset.xyz;
    p = rot * p;
    // TODO(cycle-4): animatedDomainOffset() — animation-coupled domain
    // shift (layer_gen.frag.glsl L59), deferred.
  }
  // TODO(distortion, out of scope this cycle): applyDistortion(p) (L63).
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
  if (gid.x >= params.res || gid.y >= params.res || gid.z >= params.res) {
    return;
  }
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5)) / f32(params.res);
  var density = 0.0;
  var color = vec3<f32>(0.0);
  let n = params.layer_count;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let L = layers[i];

    // layer_gen.frag.glsl L169-177: SDF sources sample once (no tiling
    // blend); everything else goes through the 8-corner tileable blend.
    var v: f32;
    if (L.noise_type == 4u) {
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
