// --- Curl noise distortion ---
// Computes divergence-free curl of the noise field via finite differences.

uniform float u_warpStrength;

vec3 applyDistortion(vec3 p) {
  if (u_warpStrength < 0.001) return p;
  const float eps = 0.01;
  float n1 = _baseNoiseEval(p + vec3(eps, 0.0, 0.0));
  float n2 = _baseNoiseEval(p - vec3(eps, 0.0, 0.0));
  float n3 = _baseNoiseEval(p + vec3(0.0, eps, 0.0));
  float n4 = _baseNoiseEval(p - vec3(0.0, eps, 0.0));
  float n5 = _baseNoiseEval(p + vec3(0.0, 0.0, eps));
  float n6 = _baseNoiseEval(p - vec3(0.0, 0.0, eps));

  float inv2eps = 1.0 / (2.0 * eps);
  vec3 curl = vec3(
    (n4 - n3 - n6 + n5) * inv2eps,
    (n5 - n6 - n2 + n1) * inv2eps,
    (n2 - n1 - n3 + n4) * inv2eps
  );

  return p + curl * u_warpStrength;
}
