export function deg2rad(deg: number): number {
  return deg * (Math.PI / 180)
}

// Build a column-major mat3 from Euler XYZ rotations (in radians)
export function mat3FromEuler(rx: number, ry: number, rz: number): Float32Array {
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)

  // Rx * Ry * Rz (column-major for WebGL)
  return new Float32Array([
    cy * cz,                  cy * sz,                  -sy,
    sx * sy * cz - cx * sz,   sx * sy * sz + cx * cz,   sx * cy,
    cx * sy * cz + sx * sz,   cx * sy * sz - sx * cz,   cx * cy,
  ])
}
