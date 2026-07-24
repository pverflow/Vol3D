// TS mirror of the SDF field GLSL. field = 1 - smoothstep(0, softness, signedDistance).
// GLSL snippets MUST use identical signed-distance formulas.
type Vec3 = [number, number, number]
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-6)))
  return t * t * (3 - 2 * t)
}
const field = (sd: number, softness: number) => 1 - smoothstep(0, Math.max(softness, 1e-4), sd)

export function sphereField(p: Vec3, radius: number, softness: number): number {
  const len = Math.hypot(p[0], p[1], p[2])
  return field(len - radius, softness)
}
export function boxField(p: Vec3, radius: number, softness: number): number {
  const q = [Math.abs(p[0]) - radius, Math.abs(p[1]) - radius, Math.abs(p[2]) - radius]
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0))
  const inside = Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0)
  return field(outside + inside, softness)
}
export function coneField(p: Vec3, radius: number, softness: number): number {
  // simple capped cone along +Y, height = 2*radius, base radius = radius
  const h = Math.max(radius, 1e-4)  // floor avoids divide-by-zero at radius=0
  const d2 = Math.hypot(p[0], p[2]) - radius * (1 - (p[1] + h) / (2 * h))
  const dy = Math.abs(p[1]) - h
  const sd = Math.max(d2, dy)
  return field(sd, softness)
}
