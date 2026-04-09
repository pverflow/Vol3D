#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

// --- Per-layer uniforms ---
uniform vec3 u_scale;
uniform float u_amplitude;
uniform vec3 u_offset;
uniform mat3 u_rotation;
uniform float u_seed;
uniform float u_sliceZ;    // current Z slice [0..1]
uniform vec2 u_remapInput;
uniform vec2 u_remapOutput;
uniform vec4 u_remapCurve;
uniform vec3 u_featherWidth;
uniform int u_featherShape;
uniform vec4 u_featherCurve;
uniform float u_animPhase;
uniform float u_animEvolutions;
uniform bool u_invert;

// Noise type: worley mode (injected below via noiseEval)
// Distortion (injected below via applyDistortion or identity)

const float ANIM_RADIUS = 4.0;

vec3 animatedDomainOffset() {
  float angle = u_animPhase * u_animEvolutions * 6.28318530718;
  vec3 axisA = normalize(vec3(
    hash11(u_seed * 0.031 + 21.0) * 2.0 - 1.0,
    hash11(u_seed * 0.037 + 22.0) * 2.0 - 1.0,
    hash11(u_seed * 0.041 + 23.0) * 2.0 - 1.0
  ));
  vec3 axisB = normalize(vec3(
    hash11(u_seed * 0.043 + 24.0) * 2.0 - 1.0,
    hash11(u_seed * 0.047 + 25.0) * 2.0 - 1.0,
    hash11(u_seed * 0.053 + 26.0) * 2.0 - 1.0
  ));
  return (axisA * cos(angle) + axisB * sin(angle)) * ANIM_RADIUS;
}

float sampleNoiseAtVolumePos(vec3 volumePos) {
  vec3 p = volumePos;

  // Apply scale, offset, rotation
  p = p * u_scale + u_offset;
  p = u_rotation * p;
  p += animatedDomainOffset();

  // Apply distortion (function injected by shader assembler)
  p = applyDistortion(p);

  // Evaluate noise (function injected by shader assembler)
  return noiseEval(p);
}

float sampleNoiseTileable(vec3 volumePos) {
  const float tileSize = 1.0;
  vec3 blend = clamp(volumePos / tileSize, 0.0, 1.0);

  float n000 = sampleNoiseAtVolumePos(volumePos);
  float n100 = sampleNoiseAtVolumePos(volumePos - vec3(tileSize, 0.0, 0.0));
  float n010 = sampleNoiseAtVolumePos(volumePos - vec3(0.0, tileSize, 0.0));
  float n110 = sampleNoiseAtVolumePos(volumePos - vec3(tileSize, tileSize, 0.0));
  float n001 = sampleNoiseAtVolumePos(volumePos - vec3(0.0, 0.0, tileSize));
  float n101 = sampleNoiseAtVolumePos(volumePos - vec3(tileSize, 0.0, tileSize));
  float n011 = sampleNoiseAtVolumePos(volumePos - vec3(0.0, tileSize, tileSize));
  float n111 = sampleNoiseAtVolumePos(volumePos - vec3(tileSize, tileSize, tileSize));

  float nx00 = mix(n000, n100, blend.x);
  float nx10 = mix(n010, n110, blend.x);
  float nx01 = mix(n001, n101, blend.x);
  float nx11 = mix(n011, n111, blend.x);

  float nxy0 = mix(nx00, nx10, blend.y);
  float nxy1 = mix(nx01, nx11, blend.y);

  return mix(nxy0, nxy1, blend.z);
}

float saturate01(float v) {
  return clamp(v, 0.0, 1.0);
}

vec2 cubicBezierPoint(vec2 p1, vec2 p2, float t) {
  float omt = 1.0 - t;
  return 3.0 * omt * omt * t * p1
    + 3.0 * omt * t * t * p2
    + t * t * t * vec2(1.0);
}

float evaluateBezierCurve(vec4 curve, float x) {
  vec2 p1 = curve.xy;
  vec2 p2 = curve.zw;
  float lo = 0.0;
  float hi = 1.0;
  for (int i = 0; i < 10; i++) {
    float mid = 0.5 * (lo + hi);
    float bx = cubicBezierPoint(p1, p2, mid).x;
    if (bx < x) lo = mid;
    else hi = mid;
  }
  return cubicBezierPoint(p1, p2, 0.5 * (lo + hi)).y;
}

float applyRemapCurve(float v) {
  float t = saturate01((v - u_remapInput.x) / max(u_remapInput.y - u_remapInput.x, 0.0001));
  t = evaluateBezierCurve(u_remapCurve, t);
  return mix(u_remapOutput.x, u_remapOutput.y, t);
}

float featherMaskBox(vec3 volumePos) {
  vec3 widths = max(u_featherWidth, vec3(0.0));
  if (widths.x <= 0.0001 && widths.y <= 0.0001 && widths.z <= 0.0001) return 1.0;

  vec3 edgeDist = min(volumePos, 1.0 - volumePos);
  vec3 axisMask = vec3(1.0);

  if (widths.x > 0.0001) axisMask.x = saturate01(edgeDist.x / widths.x);
  if (widths.y > 0.0001) axisMask.y = saturate01(edgeDist.y / widths.y);
  if (widths.z > 0.0001) axisMask.z = saturate01(edgeDist.z / widths.z);

  return min(axisMask.x, min(axisMask.y, axisMask.z));
}

float ellipsoidRadiusAlongDir(vec3 dir, vec3 radii) {
  return 1.0 / max(length(dir / max(radii, vec3(0.0001))), 0.0001);
}

float featherMaskSphere(vec3 volumePos) {
  vec3 widths = clamp(u_featherWidth, vec3(0.0), vec3(0.499));
  if (widths.x <= 0.0001 && widths.y <= 0.0001 && widths.z <= 0.0001) return 1.0;

  vec3 centered = volumePos - 0.5;
  float dist = length(centered);
  if (dist <= 0.0001) return 1.0;

  vec3 dir = centered / dist;
  vec3 outerRadii = vec3(0.5);
  vec3 innerRadii = max(outerRadii - widths, vec3(0.0005));
  float outerDist = ellipsoidRadiusAlongDir(dir, outerRadii);
  float innerDist = min(outerDist, ellipsoidRadiusAlongDir(dir, innerRadii));

  return 1.0 - saturate01((dist - innerDist) / max(outerDist - innerDist, 0.0001));
}

float applyFeather(vec3 volumePos, float density) {
  float mask = u_featherShape == 1
    ? featherMaskSphere(volumePos)
    : featherMaskBox(volumePos);

  mask = evaluateBezierCurve(u_featherCurve, saturate01(mask));
  return density * mask;
}

void main() {
  vec3 volumePos = vec3(vUv, u_sliceZ);
  float n = sampleNoiseTileable(volumePos);

  // Remap
  n = applyRemapCurve(n);

  // Amplitude
  n *= u_amplitude;

  // Invert
  if (u_invert) n = 1.0 - n;

  // Spatial feather / shaping
  n = applyFeather(volumePos, n);

  n = clamp(n, 0.0, 1.0);
  fragColor = vec4(n, n, n, 1.0);
}
