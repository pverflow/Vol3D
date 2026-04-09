#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler3D u_volume;
uniform vec3 u_cameraPos;
uniform vec3 u_cameraForward;
uniform vec3 u_cameraRight;
uniform vec3 u_cameraUp;
uniform vec3 u_volumeSize;
uniform float u_aspect;
uniform float u_tanHalfFov;
uniform float u_density;
uniform bool u_showTilePreview;
uniform float u_tilePreviewDensity;
uniform int u_stepCount;
uniform float u_exposure;
uniform vec3 u_lightDir;

const vec3 BACKGROUND_COLOR = vec3(0.0);
const float EXTINCTION_SCALE = 12.0;

vec2 intersectAABB(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
  vec3 tMin = (bMin - ro) / rd;
  vec3 tMax = (bMax - ro) / rd;
  vec3 t1 = min(tMin, tMax);
  vec3 t2 = max(tMin, tMax);
  float tNear = max(max(t1.x, t1.y), t1.z);
  float tFar  = min(min(t2.x, t2.y), t2.z);
  return vec2(tNear, tFar);
}

bool sampleScene(vec3 worldPos, out vec3 volumePos, out float densityMul) {
  vec3 previewMin = u_showTilePreview ? -u_volumeSize : vec3(0.0);
  vec3 previewMax = u_showTilePreview ? u_volumeSize * 2.0 : u_volumeSize;
  if (any(lessThan(worldPos, previewMin)) || any(greaterThan(worldPos, previewMax))) {
    return false;
  }

  vec3 local = worldPos / u_volumeSize;
  vec3 cell = floor(local);
  volumePos = fract(local);

  bool isCenter = all(equal(cell, vec3(0.0)));
  densityMul = isCenter ? 1.0 : u_tilePreviewDensity;
  return true;
}

void main() {
  vec2 screen = vUv * 2.0 - 1.0;
  vec3 rd = normalize(
    u_cameraForward
    + screen.x * u_cameraRight * u_aspect * u_tanHalfFov
    + screen.y * u_cameraUp * u_tanHalfFov
  );
  vec3 ro = u_cameraPos;

  vec2 hit = u_showTilePreview
    ? intersectAABB(ro, rd, -u_volumeSize, u_volumeSize * 2.0)
    : intersectAABB(ro, rd, vec3(0.0), u_volumeSize);
  if (hit.x > hit.y || hit.y < 0.0) {
    fragColor = vec4(BACKGROUND_COLOR, 1.0);
    return;
  }

  float tStart = max(hit.x, 0.0);
  float tEnd = hit.y;
  float stepSize = (tEnd - tStart) / float(max(u_stepCount, 16));

  float transmittance = 1.0;
  vec3 accumulatedColor = vec3(0.0);
  vec3 cloudColor = vec3(0.95, 0.97, 1.0);
  vec3 shadowColor = vec3(0.08, 0.09, 0.12);

  float t = tStart + stepSize * 0.5;

  for (int i = 0; i < 256; i++) {
    if (i >= u_stepCount || t > tEnd) break;

    vec3 worldPos = ro + rd * t;
    vec3 volumePos;
    float densityMul;
    if (sampleScene(worldPos, volumePos, densityMul)) {
      float sampleValue = texture(u_volume, volumePos).r;
      float density = sampleValue * (u_density * densityMul);

      if (density > 0.001) {
        // Simple lighting: sample slightly toward light
        vec3 lightWorldPos = worldPos + u_lightDir * 0.05;
        float shadow = 1.0;
        vec3 lightVolumePos;
        float lightDensityMul;
        if (sampleScene(lightWorldPos, lightVolumePos, lightDensityMul)) {
          float lightSample = texture(u_volume, lightVolumePos).r;
          shadow = 1.0 - lightSample * lightDensityMul * 0.75;
        }

        float alpha = 1.0 - exp(-density * stepSize * EXTINCTION_SCALE);
        vec3 voxelColor = mix(shadowColor, cloudColor, clamp(shadow, 0.0, 1.0));
        accumulatedColor += voxelColor * alpha * transmittance;
        transmittance *= (1.0 - alpha);
      }
    }

    t += stepSize;
    if (transmittance < 0.01) break;
  }

  vec3 col = BACKGROUND_COLOR * transmittance + accumulatedColor * u_exposure;
  col = pow(max(col, 0.0), vec3(0.4545)); // gamma

  fragColor = vec4(col, 1.0);
}
