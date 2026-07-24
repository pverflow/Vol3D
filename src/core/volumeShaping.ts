// Single source of truth for global density shaping (cutoff + contrast).
// In v1 this ran on the CPU during generation, baking the result into the R8
// volume. In v2 the volume stores RAW density and this shaping is applied at
// PREVIEW time (see SHADING_GLSL) and re-applied at EXPORT time (via this fn),
// so dragging cutoff/contrast requires no regeneration.

export function applyDensityShaping(value: number, cutoff: number, contrast: number): number {
  const thresholded = Math.max((value - cutoff) / Math.max(1 - cutoff, 0.0001), 0)
  const contrasted = (thresholded - 0.5) * contrast + 0.5
  return Math.max(0, Math.min(1, contrasted))
}

// GLSL mirror of applyDensityShaping — MUST stay numerically identical.
// Concatenated into preview shaders (Task 3). Operates on a float density.
export const SHADING_GLSL = `
float applyDensityShaping(float v, float cutoff, float contrast) {
  float thresholded = max((v - cutoff) / max(1.0 - cutoff, 0.0001), 0.0);
  float contrasted = (thresholded - 0.5) * contrast + 0.5;
  return clamp(contrasted, 0.0, 1.0);
}
`
