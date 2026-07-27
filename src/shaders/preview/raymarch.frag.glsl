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
uniform float u_cutoff;
uniform float u_contrast;

const vec3 BACKGROUND_COLOR = vec3(0.0);
const float EXTINCTION_SCALE = 12.0;
const vec3 SMOKE_SHADOW = vec3(0.015, 0.015, 0.02);
const vec3 SMOKE_LIT = vec3(0.16, 0.16, 0.18);
const float EMISSION_GAIN = 3.0;

// Dense-vs-sparse switch (VFX-1 Task 4). Returns [colorRGB, density] (VFX-2).
// When u_sparseEnabled is false this is EXACTLY texture(u_volume, p) — the
// dense path. sampleSparse is the shared helper injected by
// ShaderCompiler.injectShared (see sparseSample.ts).
vec4 sampleVolume(vec3 p) {
  if (u_sparseEnabled) return sampleSparse(p);
  return texture(u_volume, p);
}

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

  float t = tStart + stepSize * 0.5;

  for (int i = 0; i < 256; i++) {
    if (i >= u_stepCount || t > tEnd) break;

    vec3 worldPos = ro + rd * t;
    vec3 volumePos;
    float densityMul;
    if (sampleScene(worldPos, volumePos, densityMul)) {
      if (u_sparseEnabled) {
        // Empty-macrocell skip (perf; correctness comes first — see
        // sampleSparse for the byte-exact reconstruction this reuses).
        // ind.a<0.5 means NO brick was packed for this macrocell, i.e. every
        // voxel in it is guaranteed zero (packFrame only packs a brick when
        // at least one voxel exceeds the active threshold) — so it's safe to
        // jump straight to its far edge instead of marching through it one
        // fine step at a time. Reuses intersectAABB's slab test (same math
        // already used for the outer volume box) against the macrocell's own
        // box, in the same volumePos-local frame sampleScene produced; rd
        // scaled by u_volumeSize is this frame's ray direction in that space
        // because volumePos = fract(worldPos / u_volumeSize) is linear in
        // worldPos between tile seams.
        vec3 mc = floor(volumePos * u_macroDims);
        vec4 ind = texture(u_indirection, (mc + 0.5) / u_macroDims);
        if (ind.a < 0.5) {
          vec3 rdLocal = rd / u_volumeSize;
          vec2 exitT = intersectAABB(volumePos, rdLocal, mc / u_macroDims, (mc + 1.0) / u_macroDims);
          t += max(stepSize, exitT.y + 1e-4);
          continue;
        }
      }

      vec4 texel = sampleVolume(volumePos);              // [colorRGB, density]
      float sampleValue = applyDensityShaping(texel.a, u_cutoff, u_contrast);
      float density = sampleValue * (u_density * densityMul);
      if (density > 0.001) {
        vec3 lightWorldPos = worldPos + u_lightDir * 0.05;
        float shadow = 1.0;
        vec3 lightVolumePos; float lightDensityMul;
        if (sampleScene(lightWorldPos, lightVolumePos, lightDensityMul)) {
          float lightSample = applyDensityShaping(sampleVolume(lightVolumePos).a, u_cutoff, u_contrast);
          shadow = 1.0 - lightSample * lightDensityMul * 0.75;
        }
        float alpha = 1.0 - exp(-density * stepSize * EXTINCTION_SCALE);
        // Faint smoke ambient so a dense-but-uncolored voxel isn't pure black.
        vec3 smoke = mix(SMOKE_SHADOW, SMOKE_LIT, clamp(shadow, 0.0, 1.0));
        vec3 emission = texel.rgb * EMISSION_GAIN;
        vec3 voxelColor = smoke + emission;
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
