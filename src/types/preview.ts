export enum PreviewMode {
  Raymarched = 'raymarched',
  Slice = 'slice',
  Projection = 'projection',
}

export enum SliceAxis {
  X = 'x',
  Y = 'y',
  Z = 'z',
}

export enum ProjectionMode {
  Average = 'average',
  Max = 'max',
}

export interface PreviewSettings {
  mode: PreviewMode
  sliceAxis: SliceAxis
  slicePosition: number    // 0..1 normalized
  projectionMode: ProjectionMode
  density: number
  stepCount: number        // shared raymarch/projection sampling steps
  exposure: number
  showTilePreview: boolean
  tilePreviewDensity: number
}

export interface AnimationSettings {
  phase: number            // normalized 0..1 loop position
  loopSeconds: number
  evolutions: number
  playing: boolean
}

export interface CameraState {
  azimuth: number
  elevation: number
  distance: number
  panX: number
  panY: number
  dragMode: 'orbit' | 'grab'
}
