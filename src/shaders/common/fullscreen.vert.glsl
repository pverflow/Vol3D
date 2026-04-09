#version 300 es
// Full-screen triangle: no vertex buffer needed, just gl.drawArrays(gl.TRIANGLES, 0, 3)
out vec2 vUv;

void main() {
  // Generate clip-space triangle covering entire screen
  vec2 pos = vec2(
    float((gl_VertexID & 1) << 2) - 1.0,
    float((gl_VertexID & 2) << 1) - 1.0
  );
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
