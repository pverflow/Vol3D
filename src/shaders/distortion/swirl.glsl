// --- Swirl / twist distortion ---
// Rotates XZ plane around Y axis proportional to Y height

uniform float u_warpStrength;
uniform float u_swirlAmount;

vec3 applyDistortion(vec3 p) {
  float angle = p.y * u_swirlAmount * u_warpStrength * 6.28318;
  float cosA = cos(angle), sinA = sin(angle);
  float x = p.x * cosA - p.z * sinA;
  float z = p.x * sinA + p.z * cosA;
  return vec3(x, p.y, z);
}
