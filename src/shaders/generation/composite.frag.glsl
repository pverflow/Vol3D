#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_accumulator;
uniform sampler2D u_layerOutput;
uniform float u_opacity;
uniform int u_blendMode;

void main() {
  float base = texture(u_accumulator, vUv).r;
  float layer = texture(u_layerOutput, vUv).r;

  float blended = applyBlend(u_blendMode, base, layer);
  float result = mix(base, blended, u_opacity);

  fragColor = vec4(result, result, result, 1.0);
}
