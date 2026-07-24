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
}

// True for source types whose noiseEval is a signed-distance-based shape
// (reads u_sdfRadius/u_sdfSoftness) rather than a procedural noise field.
export function isSdfSource(t: NoiseType): boolean {
  return t === NoiseType.SdfSphere || t === NoiseType.SdfBox || t === NoiseType.SdfCone
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
}

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
}
