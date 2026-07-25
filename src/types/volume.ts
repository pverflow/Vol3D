export type Resolution = 32 | 64 | 128 | 256 | 512
export type SliceCount = 16 | 32 | 64 | 128 | 256 | 512

export enum ExportFormat {
  PNGSequence = 'png_sequence',
  SpriteSheet = 'sprite_sheet',
  RawR8 = 'raw_r8',
  RawRGBA8 = 'raw_rgba8',
  RawR32F = 'raw_r32f',
  // Rendered-flipbook export (VFX-0 Task 5) — bakes the colored raymarch
  // over the animation loop, not raw slice data. Routed separately in
  // Viewport.handleExport (never reaches ExportManager's switch).
  Flipbook = 'flipbook',
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
  format: Exclude<ExportFormat, ExportFormat.Flipbook>
  filenameBase: string
  flipY: boolean
}

// Rendered-flipbook export config (VFX-0 Task 5): bakes the colored raymarch
// over `frames` animation-loop steps into a sprite sheet (+ optional PNG
// sequence) + a JSON metadata sidecar. `fps` is metadata only — playback
// speed for whatever consumes the sheet, not used by the bake itself.
export interface FlipbookConfig {
  format: ExportFormat.Flipbook
  filenameBase: string
  frames: number
  fps: number
  tileRes: number
  cols: number
  pngSequence: boolean
}

export type ExportRequest = ExportConfig | FlipbookConfig

export const EXPORT_FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: ExportFormat.PNGSequence, label: 'PNG Sequence (ZIP)' },
  { value: ExportFormat.SpriteSheet, label: 'Sprite Sheet (PNG)' },
  { value: ExportFormat.RawR8, label: 'Raw R8 (grayscale bytes)' },
  { value: ExportFormat.RawRGBA8, label: 'Raw RGBA8' },
  { value: ExportFormat.RawR32F, label: 'Raw R32F (float)' },
  { value: ExportFormat.Flipbook, label: 'Flipbook (Rendered Sprite Sheet)' },
]
