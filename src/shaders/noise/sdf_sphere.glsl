// --- SDF sphere source ---
// field = 1 - smoothstep(0, softness, signedDistance). Must mirror sdfField.ts sphereField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;

float noiseEval(vec3 p) {
  float sd = length(p) - u_sdfRadius;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), sd);
}
