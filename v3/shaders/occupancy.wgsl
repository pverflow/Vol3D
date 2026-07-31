// Occupancy overlay (v3 cycle 5, Task 1).
//
// One invocation per macrocell: scans the cell's 8³ voxels of the generated
// volume and stores the max alpha (density) into a coarse r32float 3D texture.
// The raymarch (Task 2) samples this to skip empty macrocells. No CPU readback.
//
// The inner loop's `8u` extent is hardcoded to match `anim::MACRO = 8` — keep
// the two in sync.

@group(0) @binding(0) var vol: texture_3d<f32>;
// r32float, not r8unorm: R8Unorm is NOT a WebGPU storage-texture format (web build fails).
// R32Float is storage-write-capable in core WebGPU. Non-filterable; Task 2 samples with a
// NEAREST sampler + Texture{ sample_type: Float{ filterable: false } }.
@group(0) @binding(1) var occ: texture_storage_3d<r32float, write>;
struct OccParams { res: u32, macro_dim: u32, _p0: u32, _p1: u32 };
@group(0) @binding(2) var<uniform> P: OccParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) mc: vec3<u32>) {
  if (mc.x >= P.macro_dim || mc.y >= P.macro_dim || mc.z >= P.macro_dim) { return; }
  let base = mc * 8u; // MACRO=8
  var m = 0.0;
  for (var z = 0u; z < 8u; z = z + 1u) {
    for (var y = 0u; y < 8u; y = y + 1u) {
      for (var x = 0u; x < 8u; x = x + 1u) {
        let v = base + vec3<u32>(x, y, z);
        if (v.x < P.res && v.y < P.res && v.z < P.res) {
          m = max(m, textureLoad(vol, vec3<i32>(v), 0).a);
        }
      }
    }
  }
  textureStore(occ, vec3<i32>(mc), vec4<f32>(m, 0.0, 0.0, 1.0));
}
