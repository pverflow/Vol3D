@group(0) @binding(0) var vol: texture_storage_3d<rgba8unorm, write>;
struct Params { res: u32, iso: f32, noise_scale: f32, _pad: f32 };
@group(0) @binding(1) var<uniform> P: Params;

fn hash3(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  return fract(sin(dot(q, vec3<f32>(17.0, 59.4, 15.0))) * 43758.5453);
}
fn valueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = hash3(i + vec3<f32>(0.,0.,0.)); let c100 = hash3(i + vec3<f32>(1.,0.,0.));
  let c010 = hash3(i + vec3<f32>(0.,1.,0.)); let c110 = hash3(i + vec3<f32>(1.,1.,0.));
  let c001 = hash3(i + vec3<f32>(0.,0.,1.)); let c101 = hash3(i + vec3<f32>(1.,0.,1.));
  let c011 = hash3(i + vec3<f32>(0.,1.,1.)); let c111 = hash3(i + vec3<f32>(1.,1.,1.));
  let x00 = mix(c000, c100, u.x); let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x); let x11 = mix(c011, c111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.res || gid.y >= P.res || gid.z >= P.res) { return; }
  let uvw = (vec3<f32>(gid) + 0.5) / f32(P.res);
  let p = uvw * 2.0 - 1.0;
  let sphere = 1.0 - length(p);
  let n = valueNoise(uvw * P.noise_scale);
  var density = sphere + (n - 0.5) * 0.6;
  density = clamp(density - P.iso, 0.0, 1.0);
  let cool = vec3<f32>(0.1, 0.3, 0.9);
  let warm = vec3<f32>(1.0, 0.55, 0.1);
  let color = mix(cool, warm, clamp(density * 1.5, 0.0, 1.0));
  textureStore(vol, vec3<i32>(gid), vec4<f32>(color, density));
}
