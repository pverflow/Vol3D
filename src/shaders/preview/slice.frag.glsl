#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler3D u_volume;
uniform int u_sliceAxis;      // 0=X, 1=Y, 2=Z
uniform float u_slicePos;     // [0..1]
uniform float u_exposure;
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

  vec3 uvw;
  if (u_sliceAxis == 0) {
    uvw = vec3(u_slicePos, planeUv.x, planeUv.y);
  } else if (u_sliceAxis == 1) {
    uvw = vec3(planeUv.x, u_slicePos, planeUv.y);
  } else {
    uvw = vec3(planeUv.x, planeUv.y, u_slicePos);
  }

  vec2 rg = texture(u_volume, uvw).rg;
  float v = applyDensityShaping(rg.r, u_cutoff, u_contrast);
  v = clamp(v * u_exposure, 0.0, 1.0);

  vec3 bg = vec3(0.05, 0.05, 0.1);
  vec3 col;
  if (u_colorRampEnabled) {
    // Smoke + glow (VFX-1 UX fix): dark smoke grey from shaped density,
    // plus additive fire emission from the ramp looked up by heat.
    const float EMISSION_GAIN = 3.0;
    vec3 smoke = mix(vec3(0.02), vec3(0.18), v);
    vec4 ramp = texture(u_colorRamp, vec2(rg.g, 0.5));
    vec3 emission = ramp.rgb * ramp.a * EMISSION_GAIN;
    col = smoke + emission;
  } else {
    // Apply a subtle false-color gradient for readability
    col = mix(bg, vec3(1.0, 1.0, 1.0), v);
  }
  fragColor = vec4(col, 1.0);
}
