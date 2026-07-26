export enum NoiseType {
  Perlin = 'perlin',
  Simplex = 'simplex',
  Worley = 'worley',
  Voronoi = 'voronoi',
  Value = 'value',
  White = 'white',
  FBM = 'fbm',
  SdfSphere = 'sdf_sphere',
  SdfBox = 'sdf_box',
  SdfCone = 'sdf_cone',
  SdfPlume = 'sdf_plume',
  SdfCapsule = 'sdf_capsule',
  SdfCylinder = 'sdf_cylinder',
}

// True for source types whose noiseEval is a signed-distance-based shape
// (reads u_sdfRadius/u_sdfSoftness[/u_sdfHeight]) rather than a procedural
// noise field.
export function isSdfSource(t: NoiseType): boolean {
  return t === NoiseType.SdfSphere || t === NoiseType.SdfBox || t === NoiseType.SdfCone
    || t === NoiseType.SdfPlume || t === NoiseType.SdfCapsule || t === NoiseType.SdfCylinder
}

export enum WorleyMode {
  F1 = 'f1',
  F2 = 'f2',
  F2F1 = 'f2f1',
}

export interface FBMConfig {
  baseNoise: NoiseType
  octaves: number       // 1-8
  persistence: number   // amplitude scale per octave
  lacunarity: number    // frequency scale per octave
}

export interface SdfConfig {
  radius: number
  softness: number
  height: number
}

// Single source of truth for the SDF radius/softness/height default —
// referenced by defaultLayer, state migration/preset validation fallbacks,
// the renderer's missing-sdf fallback, and the PropertiesPanel slider reset
// value. `height` only affects the elongated shapes (plume/capsule/cylinder);
// sphere/box/cone ignore it.
export const DEFAULT_SDF: SdfConfig = { radius: 0.3, softness: 0.1, height: 1.0 }

export interface NoiseConfig {
  type: NoiseType
  worleyMode: WorleyMode
  fbm: FBMConfig
  sdf?: SdfConfig
  scale: [number, number, number]
  amplitude: number
  offset: [number, number, number]
  rotation: [number, number, number]  // Euler XYZ degrees
  seed: number
  temperature?: number  // DEPRECATED (VFX-2): superseded by per-layer colorRamp; ignored by generation.
}
