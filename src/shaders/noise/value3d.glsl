// --- Value 3D noise (trilinear interpolation of random values) ---
// Returns [0,1]

float _valueLattice(vec3 ip) {
  return hash13(ip + u_seed * 0.37);
}

float noiseEval(vec3 p) {
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  vec3 u = fp * fp * (3.0 - 2.0 * fp); // smoothstep

  float v000 = _valueLattice(ip);
  float v100 = _valueLattice(ip + vec3(1.0, 0.0, 0.0));
  float v010 = _valueLattice(ip + vec3(0.0, 1.0, 0.0));
  float v110 = _valueLattice(ip + vec3(1.0, 1.0, 0.0));
  float v001 = _valueLattice(ip + vec3(0.0, 0.0, 1.0));
  float v101 = _valueLattice(ip + vec3(1.0, 0.0, 1.0));
  float v011 = _valueLattice(ip + vec3(0.0, 1.0, 1.0));
  float v111 = _valueLattice(ip + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
    mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y),
    u.z
  );
}
