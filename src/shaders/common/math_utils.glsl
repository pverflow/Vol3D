// --- Math utilities shared across all shaders ---

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

// Rotation matrices
mat3 rotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c);
}
mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c);
}
mat3 rotZ(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c,-s,0.0, s,c,0.0, 0.0,0.0,1.0);
}

// Remap value from [inMin,inMax] to [outMin,outMax]
float remap(float v, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (outMax - outMin) * clamp((v - inMin) / (inMax - inMin + 0.0001), 0.0, 1.0);
}

// Smooth minimum (for soft Voronoi blending)
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
