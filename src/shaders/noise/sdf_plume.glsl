// --- SDF plume source ---
// Tapered capsule along +Y (radius shrinks linearly base->top, flame
// silhouette); u_sdfHeight is the half-height. field = 1 - smoothstep(0,
// softness, signedDistance). Must mirror sdfField.ts plumeField exactly.
uniform float u_sdfRadius;
uniform float u_sdfSoftness;
uniform float u_sdfHeight;

float noiseEval(vec3 p) {
  float h = max(u_sdfHeight, 1e-4);
  float t = clamp((p.y + h) / (2.0 * h), 0.0, 1.0);
  float rr = u_sdfRadius * (1.0 - 0.85 * t);
  float cy = clamp(p.y, -h, h);
  float d = length(vec3(p.x, p.y - cy, p.z)) - rr;
  return 1.0 - smoothstep(0.0, max(u_sdfSoftness, 1e-4), d);
}
