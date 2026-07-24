// --- SDF cone source ---
// Approximate capped cone along +Y, height = 2*radius, base radius = radius.
// field = 1 - smoothstep(0, softness, signedDistance). Must mirror sdfField.ts coneField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;

float noiseEval(vec3 p) {
  float h = max(u_sdfRadius, 1e-4);  // floor avoids divide-by-zero at radius=0
  float d2 = length(p.xz) - u_sdfRadius * (1.0 - (p.y + h) / (2.0 * h));
  float dy = abs(p.y) - h;
  float sd = max(d2, dy);
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), sd);
}
