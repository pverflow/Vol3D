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

  float v = texture(u_volume, uvw).r;
  v = clamp(v * u_exposure, 0.0, 1.0);

  // Apply a subtle false-color gradient for readability
  vec3 col = mix(vec3(0.05, 0.05, 0.1), vec3(1.0, 1.0, 1.0), v);
  fragColor = vec4(col, 1.0);
}
