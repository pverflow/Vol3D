// --- SDF capsule source ---
// Capsule along +Y; u_sdfHeight is the half-height of the straight segment
// between the two end caps. field = 1 - smoothstep(0, softness, signedDistance).
// Must mirror sdfField.ts capsuleField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;
uniform float u_sdfHeight;

float noiseEval(vec3 p) {
  float h = max(u_sdfHeight, 1e-4);
  float cy = clamp(p.y, -h, h);
  float d = length(vec3(p.x, p.y - cy, p.z)) - u_sdfRadius;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), d);
}
