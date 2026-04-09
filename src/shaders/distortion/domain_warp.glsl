// --- Domain Warp distortion ---
// Warps the sample position using another noise evaluation.
// u_warpStrength: warp amount (0..2)
// u_warpFrequency: frequency of the warp noise

uniform float u_warpStrength;
uniform float u_warpFrequency;
uniform int u_warpOctaves;

vec3 applyDistortion(vec3 p) {
  if (u_warpStrength < 0.001) return p;
  vec3 wp = p * u_warpFrequency;
  // Sample offset noise in 3 directions (cheap multi-axis warp)
  float nx = _baseNoiseEval(wp + vec3(0.0, 1.7, 9.2));
  float ny = _baseNoiseEval(wp + vec3(8.3, 2.8, 4.1));
  float nz = _baseNoiseEval(wp + vec3(4.0, 3.1, 6.7));
  vec3 warp = (vec3(nx, ny, nz) - 0.5) * 2.0 * u_warpStrength;
  return p + warp;
}
