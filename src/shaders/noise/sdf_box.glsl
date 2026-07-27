// --- SDF box source ---
// field = 1 - smoothstep(0, softness, signedDistance). Must mirror sdfField.ts boxField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;

float noiseEval(vec3 p) {
  vec3 q = abs(p) - vec3(u_sdfRadius);
  float outside = length(max(q, 0.0));
  float inside = min(max(q.x, max(q.y, q.z)), 0.0);
  float sd = outside + inside;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), sd);
}
