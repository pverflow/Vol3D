export enum NoiseType {
  Perlin = 'perlin',
  Simplex = 'simplex',
  Worley = 'worley',
  Voronoi = 'voronoi',
  Value = 'value',
  White = 'white',
  FBM = 'fbm',
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

export interface NoiseConfig {
  type: NoiseType
  worleyMode: WorleyMode
  fbm: FBMConfig
  scale: [number, number, number]
  amplitude: number
  offset: [number, number, number]
  rotation: [number, number, number]  // Euler XYZ degrees
  seed: number
}
