import { NoiseType } from '../types/index'

export const NOISE_COLORS: Record<NoiseType, string> = {
  [NoiseType.Perlin]:  '#4a9eff',
  [NoiseType.Simplex]: '#7c6aff',
  [NoiseType.Worley]:  '#ff8c42',
  [NoiseType.Voronoi]: '#c44dff',
  [NoiseType.Value]:   '#2dd4a0',
  [NoiseType.White]:   '#a0a0b0',
  [NoiseType.FBM]:     '#ff4d6d',
}

export const NOISE_LABELS: Record<NoiseType, string> = {
  [NoiseType.Perlin]:  'Perlin',
  [NoiseType.Simplex]: 'Simplex',
  [NoiseType.Worley]:  'Worley',
  [NoiseType.Voronoi]: 'Voronoi',
  [NoiseType.Value]:   'Value',
  [NoiseType.White]:   'White',
  [NoiseType.FBM]:     'FBM',
}
