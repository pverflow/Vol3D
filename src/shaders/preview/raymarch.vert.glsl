#version 300 es

out vec2 vUv;

void main() {
  vec2 pos = vec2(
    float((gl_VertexID & 1) << 2) - 1.0,
    float((gl_VertexID & 2) << 1) - 1.0
  );
  vUv = pos * 0.5 + 0.5;

  gl_Position = vec4(pos, 0.0, 1.0);
}
