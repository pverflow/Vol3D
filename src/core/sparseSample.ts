// GLSL mirror of the sparse brick-atlas layout defined in brickPack.ts
// (VFX-1 Task 4). MUST reproduce reconstruct()/slotToXYZ EXACTLY:
//   - macrocell index = floor(volumePos * macroDims)              (slotToXYZ's inverse: which macrocell a position falls in)
//   - indirection texel at that macrocell = (slot xyz / 255, active flag) (packFrame's indirection write)
//   - atlas voxel = slot*BRICK + (voxel's local index within the brick)   (AtlasBuilder.data()'s placement)
// Both the atlas and indirection textures are NEAREST-filtered (BrickCache),
// and every lookup below samples an exact texel center, so this reproduces
// reconstruct()'s per-voxel byte values precisely (no cross-brick bleed).
import { BRICK_SIZE } from './constants'

// Injected into every preview fragment shader (raymarch/slice/projection)
// alongside SHADING_GLSL — see ShaderCompiler.injectShared.
export const SPARSE_SAMPLE_GLSL = `
uniform sampler3D u_atlas;
uniform sampler3D u_indirection;
uniform vec3 u_macroDims;
uniform vec3 u_atlasDimsBricks;
uniform bool u_sparseEnabled;

// Interpolated from BRICK_SIZE (core/constants.ts) — brick edge length in
// voxels — so the two can never drift out of sync.
const float SPARSE_BRICK = ${BRICK_SIZE.toFixed(1)};

// [colorRGB, density] at \`volumePos\` (same normalized [0,1)^3 volume-local
// coord the dense \`texture(u_volume, volumePos)\` call takes) via the sparse
// brick atlas. Empty macrocells (no packed brick) return vec4(0.0) —
// reconstruct() substitutes exact zero for those too (bytes below
// SPARSE_ACTIVE_THRESHOLD are already lost at pack time), so this is not a new
// source of error. (VFX-2: the atlas is RGBA8, so the color channels carry the
// per-voxel color that composited into the brick.)
vec4 sampleSparse(vec3 volumePos) {
  vec3 mc = floor(volumePos * u_macroDims);
  vec4 ind = texture(u_indirection, (mc + 0.5) / u_macroDims);
  if (ind.a < 0.5) return vec4(0.0);

  // Slot bytes round-trip exactly through the RGBA8 texture (0..255 over
  // 256 levels): +0.5 before floor undoes the /255 normalization safely.
  vec3 slot = floor(ind.rgb * 255.0 + 0.5);
  vec3 local = fract(volumePos * u_macroDims);
  vec3 voxel = clamp(floor(local * SPARSE_BRICK), vec3(0.0), vec3(SPARSE_BRICK - 1.0));
  vec3 atlasVoxel = slot * SPARSE_BRICK + voxel;
  vec3 atlasUvw = (atlasVoxel + 0.5) / (u_atlasDimsBricks * SPARSE_BRICK);
  return texture(u_atlas, atlasUvw);   // [colorRGB, density]
}
`
