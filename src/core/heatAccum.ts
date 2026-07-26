// Derived-heat accumulation (VFX-1 Task 2): heat is not its own noise field —
// it's density-weighted temperature, accumulated per-layer during compositing
// exactly like density is. Mirrored in GLSL (HEAT_ACCUM_GLSL) so the CPU and
// shader math can never drift apart.
export function accumulateHeat(heatIn: number, densityContribution: number, temperature: number): number {
  return Math.max(0, Math.min(1, heatIn + densityContribution * temperature))
}

export const HEAT_ACCUM_GLSL = `
float accumulateHeat(float heatIn, float densityContribution, float temperature) {
  return clamp(heatIn + densityContribution * temperature, 0.0, 1.0);
}
`
