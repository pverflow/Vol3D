import type { NoiseConfig } from './noise'

export enum BlendMode {
  Normal = 'normal',
  Add = 'add',
  Multiply = 'multiply',
  Screen = 'screen',
  Overlay = 'overlay',
  Subtract = 'subtract',
}

export enum DistortionType {
  None = 'none',
  DomainWarp = 'domain_warp',
  Curl = 'curl',
  Swirl = 'swirl',
  Polar = 'polar',
}

export enum FeatherShape {
  Box = 'box',
  Sphere = 'sphere',
}

export type BezierCurve = [number, number, number, number]

export interface DistortionConfig {
  type: DistortionType
  strength: number
  warpOctaves: number
  warpFrequency: number
  swirlAmount: number
}

export interface RemapConfig {
  inputMin: number
  inputMax: number
  outputMin: number
  outputMax: number
  remapCurve: BezierCurve
  featherX: number
  featherY: number
  featherZ: number
  featherShape: FeatherShape
  featherCurve: BezierCurve
}

export interface Layer {
  id: string
  name: string
  visible: boolean
  locked: boolean
  solo: boolean
  blendMode: BlendMode
  opacity: number    // 0..1
  noise: NoiseConfig
  distortion: DistortionConfig
  remap: RemapConfig
  invert: boolean
}
