// --- Polar coordinate transform ---
// Maps Cartesian (x,y) to polar (radius, angle) before noise sampling.
// z is preserved.

uniform float u_warpStrength;

vec3 applyDistortion(vec3 p) {
  if (u_warpStrength < 0.001) return p;
  vec2 centered = p.xy - 0.5;
  float radius = length(centered) * 2.0;
  float angle = atan(centered.y, centered.x) / 6.28318 + 0.5;
  vec3 polar = vec3(angle, radius, p.z);
  return mix(p, polar, u_warpStrength);
}
