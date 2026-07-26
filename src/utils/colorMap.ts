import { NoiseType } from '../types/index'

export const NOISE_COLORS: Record<NoiseType, string> = {
  [NoiseType.Perlin]:  '#4a9eff',
  [NoiseType.Simplex]: '#7c6aff',
  [NoiseType.Worley]:  '#ff8c42',
  [NoiseType.Voronoi]: '#c44dff',
  [NoiseType.Value]:   '#2dd4a0',
  [NoiseType.White]:   '#a0a0b0',
  [NoiseType.FBM]:     '#ff4d6d',
  [NoiseType.SdfSphere]: '#4dd8c4',
  [NoiseType.SdfBox]:    '#e0c341',
  [NoiseType.SdfCone]:   '#e05d8f',
  [NoiseType.SdfPlume]:    '#ff7a3d',
  [NoiseType.SdfCapsule]:  '#5dc9e0',
  [NoiseType.SdfCylinder]: '#9be05d',
}

export const NOISE_LABELS: Record<NoiseType, string> = {
  [NoiseType.Perlin]:  'Perlin',
  [NoiseType.Simplex]: 'Simplex',
  [NoiseType.Worley]:  'Worley',
  [NoiseType.Voronoi]: 'Voronoi',
  [NoiseType.Value]:   'Value',
  [NoiseType.White]:   'White',
  [NoiseType.FBM]:     'FBM',
  [NoiseType.SdfSphere]: 'SDF Sphere',
  [NoiseType.SdfBox]:    'SDF Box',
  [NoiseType.SdfCone]:   'SDF Cone',
  [NoiseType.SdfPlume]:    'SDF Plume',
  [NoiseType.SdfCapsule]:  'SDF Capsule',
  [NoiseType.SdfCylinder]: 'SDF Cylinder',
}
