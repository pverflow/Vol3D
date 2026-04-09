import {
  NoiseType, WorleyMode, BlendMode, DistortionType,
  PreviewMode, SliceAxis, ProjectionMode, FeatherShape,
} from '../types/index'
import type { Layer, VolumeSettings, PreviewSettings, CameraState, AnimationSettings } from '../types/index'
import { uid } from '../utils/uid'

export function defaultLayer(name?: string, noiseType: NoiseType = NoiseType.Perlin): Layer {
  return {
    id: uid(),
    name: name ?? 'Layer',
    visible: true,
    locked: false,
    solo: false,
    blendMode: BlendMode.Normal,
    opacity: 1.0,
    invert: false,
    noise: {
      type: noiseType,
      worleyMode: WorleyMode.F1,
      fbm: {
        baseNoise: NoiseType.Simplex,
        octaves: 4,
        persistence: 0.5,
        lacunarity: 2.0,
      },
      scale: [3.0, 3.0, 3.0],
      amplitude: 1.0,
      offset: [0.0, 0.0, 0.0],
      rotation: [0.0, 0.0, 0.0],
      seed: 0.0,
    },
    distortion: {
      type: DistortionType.None,
      strength: 0.3,
      warpOctaves: 2,
      warpFrequency: 2.0,
      swirlAmount: 1.0,
    },
    remap: {
      inputMin: 0.0,
      inputMax: 1.0,
      outputMin: 0.0,
      outputMax: 1.0,
      remapCurve: [0.25, 0.25, 0.75, 0.75],
      featherX: 0.0,
      featherY: 0.0,
      featherZ: 0.0,
      featherShape: FeatherShape.Box,
      featherCurve: [0.25, 0.25, 0.75, 0.75],
    },
  }
}

export interface AppState {
  layers: Layer[]
  selected: string | null
  settings: VolumeSettings
  preview: PreviewSettings
  animation: AnimationSettings
  camera: CameraState
  generating: boolean
  progress: number
  dirty: boolean
}

export function defaultState(): AppState {
  return {
    layers: [defaultLayer('Base Cloud', NoiseType.FBM)],
    selected: null,
    settings: {
      resolution: 64,
      depth: 64,
      customSliceCount: false,
      globalSeed: 0,
      cutoff: 0.35,
      contrast: 1.5,
    },
    preview: {
      mode: PreviewMode.Raymarched,
      sliceAxis: SliceAxis.Z,
      slicePosition: 0.5,
      projectionMode: ProjectionMode.Max,
      density: 1.5,
      stepCount: 64,
      exposure: 1.0,
      showTilePreview: false,
      tilePreviewDensity: 0.45,
    },
    animation: {
      phase: 0,
      loopSeconds: 4,
      evolutions: 1,
      playing: false,
    },
    camera: {
      azimuth: 0.5,
      elevation: 0.3,
      distance: 2.5,
      panX: 0,
      panY: 0,
      dragMode: 'grab',
    },
    generating: false,
    progress: 0,
    dirty: true,
  }
}
