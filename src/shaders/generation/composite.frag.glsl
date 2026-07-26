#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_accumulator;
uniform sampler2D u_layerOutput;
uniform float u_opacity;
uniform int u_blendMode;
uniform float u_temperature;

// accumulateHeat(float,float,float) injected via HEAT_ACCUM_GLSL (ShaderCompiler)

void main() {
  float base = texture(u_accumulator, vUv).r;
  float heatIn = texture(u_accumulator, vUv).g;
  float layer = texture(u_layerOutput, vUv).r;

  float blended = applyBlend(u_blendMode, base, layer);
  float density = mix(base, blended, u_opacity);

  // Heat is derived, not its own noise field: density (post-opacity, the same
  // value just written to .r this layer) weighted by this layer's temperature,
  // accumulated on top of whatever heat prior layers deposited.
  float heat = accumulateHeat(heatIn, density, u_temperature);

  fragColor = vec4(density, heat, 0.0, 1.0);
}
