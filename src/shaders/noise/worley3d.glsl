// --- Worley / Cellular 3D noise ---
// u_worleyMode: 0=F1, 1=F2, 2=F2-F1
// Returns [0,1]

uniform int u_worleyMode;

vec2 _worley3(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);

  float F1 = 999.0, F2 = 999.0;

  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 cell = vec3(float(i), float(j), float(k));
        vec3 cellPoint = cell + hash33(ip + cell + u_seed);
        float d = length(cellPoint - fp);
        if (d < F1) { F2 = F1; F1 = d; }
        else if (d < F2) { F2 = d; }
      }
    }
  }
  return vec2(F1, F2);
}

float noiseEval(vec3 p) {
  vec2 f = _worley3(p);
  if (u_worleyMode == 0) return clamp(1.0 - f.x * 1.5, 0.0, 1.0);
  if (u_worleyMode == 1) return clamp(1.0 - f.y * 1.1, 0.0, 1.0);
  return clamp((f.y - f.x) * 2.0, 0.0, 1.0);
}
