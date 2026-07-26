// --- SDF cylinder source ---
// Flat-capped cylinder along +Y; u_sdfHeight is the half-height.
// field = 1 - smoothstep(0, softness, signedDistance). Must mirror
// sdfField.ts cylinderField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;
uniform float u_sdfHeight;

float noiseEval(vec3 p) {
  float h = max(u_sdfHeight, 1e-4);
  float dx = length(p.xz) - u_sdfRadius;
  float dy = abs(p.y) - h;
  float outside = length(vec2(max(dx, 0.0), max(dy, 0.0)));
  float inside = min(max(dx, dy), 0.0);
  float sd = outside + inside;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), sd);
}
