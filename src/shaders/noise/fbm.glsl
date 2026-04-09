// --- Fractal Brownian Motion wrapper ---
// Calls noiseEval() from the base noise snippet loaded before this file.
// u_octaves, u_persistence, u_lacunarity are set as uniforms.

uniform int u_octaves;
uniform float u_persistence;
uniform float u_lacunarity;

float noiseEval(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  float maxValue = 0.0;

  for (int i = 0; i < 8; i++) {
    if (i >= u_octaves) break;
    value += _baseNoiseEval(p * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= u_persistence;
    frequency *= u_lacunarity;
    // Per-octave rotation to break axis alignment
    p = rotX(0.5) * rotY(0.3) * p;
  }

  return value / maxValue;
}
