export type Resolution = 32 | 64 | 128 | 256 | 512
export type SliceCount = 16 | 32 | 64 | 128 | 256 | 512

export enum ExportFormat {
  PNGSequence = 'png_sequence',
  SpriteSheet = 'sprite_sheet',
  RawR8 = 'raw_r8',
  RawRGBA8 = 'raw_rgba8',
  RawR16F = 'raw_r16f',
  RawR32F = 'raw_r32f',
}

export interface VolumeSettings {
  resolution: Resolution
  depth: SliceCount
  customSliceCount: boolean
  globalSeed: number
  cutoff: number
  contrast: number
}

export interface ExportConfig {
  format: ExportFormat
  filenameBase: string
  flipY: boolean
}
