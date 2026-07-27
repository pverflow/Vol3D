#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_accumulator;
uniform sampler2D u_layerOutput;
uniform sampler2D u_layerRamp;   // per-layer color LUT (256x1 RGBA8), VFX-2
uniform float u_opacity;
uniform int u_blendMode;

void main() {
  vec4 acc = texture(u_accumulator, vUv);   // [colorRGB, density]
  float base = acc.a;
  float v = texture(u_layerOutput, vUv).r;  // this layer's own value 0..1

  // Density / shape — UNCHANGED math, now on the alpha channel.
  float blended = applyBlend(u_blendMode, base, v);
  float density = mix(base, blended, u_opacity);

  // Color — independent painter's "over" of this layer's ramp(value).
  vec4 c = texture(u_layerRamp, vec2(v, 0.5));
  float a = c.a * u_opacity;
  vec3 rgb = c.rgb * a + acc.rgb * (1.0 - a);

  fragColor = vec4(rgb, density);
}
