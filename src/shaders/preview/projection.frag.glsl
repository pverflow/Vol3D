#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler3D u_volume;
uniform int u_sliceAxis;     // 0=X, 1=Y, 2=Z
uniform int u_projMode;      // 0=average, 1=max
uniform float u_exposure;
uniform int u_steps;
uniform float u_planeAspect;
uniform float u_screenAspect;
uniform float u_cutoff;
uniform float u_contrast;
uniform sampler2D u_colorRamp;
uniform bool u_colorRampEnabled;

bool fitPlaneUv(vec2 uv, out vec2 planeUv) {
  planeUv = uv;
  if (u_screenAspect > u_planeAspect) {
    planeUv.x = (uv.x - 0.5) * (u_screenAspect / u_planeAspect) + 0.5;
  } else {
    planeUv.y = (uv.y - 0.5) * (u_planeAspect / u_screenAspect) + 0.5;
  }
  return all(greaterThanEqual(planeUv, vec2(0.0))) && all(lessThanEqual(planeUv, vec2(1.0)));
}

void main() {
  vec2 planeUv;
  if (!fitPlaneUv(vUv, planeUv)) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float acc = 0.0;
  float maxVal = 0.0;
  float heatAcc = 0.0;
  float heatAtMax = 0.0;

  int steps = max(u_steps, 8);
  float invSteps = 1.0 / float(steps);

  for (int i = 0; i < 256; i++) {
    if (i >= steps) break;
    float t = (float(i) + 0.5) * invSteps;
    vec3 uvw;
    if (u_sliceAxis == 0) uvw = vec3(t, planeUv.x, planeUv.y);
    else if (u_sliceAxis == 1) uvw = vec3(planeUv.x, t, planeUv.y);
    else uvw = vec3(planeUv.x, planeUv.y, t);

    vec2 rg = texture(u_volume, uvw).rg;
    float v = applyDensityShaping(rg.r, u_cutoff, u_contrast);
    acc += v;
    heatAcc += rg.g;
    if (v > maxVal) {
      maxVal = v;
      heatAtMax = rg.g;
    }
  }

  float result = (u_projMode == 0) ? acc * invSteps : maxVal;
  float heat = (u_projMode == 0) ? heatAcc * invSteps : heatAtMax;
  result = clamp(result * u_exposure, 0.0, 1.0);

  vec3 bg = vec3(0.05, 0.05, 0.1);
  vec3 col;
  if (u_colorRampEnabled) {
    // Smoke + glow (VFX-1 UX fix): dark smoke grey from projected density,
    // plus additive fire emission from the ramp looked up by projected heat.
    const float EMISSION_GAIN = 3.0;
    vec3 smoke = mix(vec3(0.02), vec3(0.18), result);
    vec4 ramp = texture(u_colorRamp, vec2(heat, 0.5));
    vec3 emission = ramp.rgb * ramp.a * EMISSION_GAIN;
    col = smoke + emission;
  } else {
    col = mix(bg, vec3(1.0, 1.0, 1.0), result);
  }
  fragColor = vec4(col, 1.0);
}
