// Rendered-flipbook export (VFX-0 Task 5): bakes the COLORED raymarch preview
// over the animation loop into a sprite-sheet PNG (+ optional PNG-sequence
// zip) + a JSON metadata sidecar. This is deliberately separate from
// ExportManager — that exporter reads back raw slice/volume data, this one
// renders the on-screen shaded look frame-by-frame into an offscreen target.
//
// Always uses a dedicated VolumeGenerator + VolumeTexture sized at the
// FULL-res settings (never the drag proxy, never the on-screen `volume` or
// the animation cache's generator) so baking can't race or clobber either.
import { ShaderCompiler } from '../renderer/ShaderCompiler'
import { VolumeGenerator } from '../renderer/VolumeGenerator'
import { VolumeTexture } from '../volume/VolumeTexture'
import { saveBytes, saveText } from '../../platform/fileAccess'
import type { AnimationSettings, CameraState, FlipbookConfig, Layer, VolumeSettings } from '../../types/index'
import { flipbookCell, flipbookRows } from './flipbookGrid'

// Render hook supplied by Viewport: paint the colored raymarch (camera +
// ramp LUT + cutoff/contrast/density/etc — the same uniforms renderRaymarched
// uses on-screen) for `vol` into `fbo` at `w`×`h`, using the frozen `params`
// snapshot instead of live camera/state reads. Factored out of
// Viewport.renderRaymarched so on-screen rendering is untouched.
export type FlipbookRenderToTarget = (fbo: WebGLFramebuffer, w: number, h: number, vol: VolumeTexture, params: RaymarchParams) => void

export interface FlipbookDeps {
  gl: WebGL2RenderingContext
  compiler: ShaderCompiler
  renderToTarget: FlipbookRenderToTarget
}

// Frozen render-time uniforms for one bake (VFX-0 Task 5 fix): everything
// Viewport.setRaymarchUniforms would otherwise read live from
// this.camera.getMatrices()/this.state.get('preview'|'settings') on every
// frame. Captured ONCE at bake start (see Viewport.snapshotRaymarchParams)
// so a mid-bake camera drag or Properties tweak can't change frames already
// baked or still to come — every frame in one sprite sheet renders with the
// exact same camera/shading. `colorRampTexture` is a bake-owned GL texture
// (built from a snapshot of preview.colorRamp, not the shared live LUT
// texture) that FlipbookExporter.bake deletes when done.
export interface RaymarchParams {
  eye: Float32Array
  forward: Float32Array
  right: Float32Array
  up: Float32Array
  aspect: number
  cutoff: number
  contrast: number
  density: number
  stepCount: number
  exposure: number
  showTilePreview: boolean
  tilePreviewDensity: number
  colorRampEnabled: boolean
  colorRampTexture: WebGLTexture
}

export interface FlipbookMetadata {
  frames: number
  fps: number
  cols: number
  rows: number
  tileRes: number
  dims: { resolution: number; depth: number }
  camera: CameraState
}

export class FlipbookExporter {
  constructor(private readonly deps: FlipbookDeps) {}

  async bake(
    config: FlipbookConfig,
    layers: Layer[],
    settings: VolumeSettings,
    animation: AnimationSettings,
    camera: CameraState,
    renderParams: RaymarchParams,
    onProgress?: (p: number) => void,
  ): Promise<void> {
    const { gl, compiler, renderToTarget } = this.deps
    const frames = Math.max(1, Math.floor(config.frames))
    const cols = Math.max(1, Math.floor(config.cols))
    const rows = flipbookRows(frames, cols)
    const tileRes = Math.max(1, Math.floor(config.tileRes))

    // Allocate canvases and tracking objects outside try (no GL resources);
    // all GL-owned resources (generator, bakeVolume, target, contexts) are
    // allocated inside try so the finally cleanup covers allocation failures.
    const sheet = document.createElement('canvas')
    sheet.width = cols * tileRes
    sheet.height = rows * tileRes

    const frameCanvas = document.createElement('canvas')
    frameCanvas.width = tileRes
    frameCanvas.height = tileRes
    const pngFiles: Record<string, Uint8Array> = {}

    let generator: VolumeGenerator | null = null
    let bakeVolume: VolumeTexture | null = null
    let target: { fbo: WebGLFramebuffer; texture: WebGLTexture } | null = null
    let sheetCtx: CanvasRenderingContext2D | null = null
    let frameCtx: CanvasRenderingContext2D | null = null

    try {
      // Allocate all GL-owned resources inside try block so finally cleanup
      // runs even if any allocation throws (e.g., createRenderTarget FBO
      // creation fails, or get2dContext unavailable).
      generator = new VolumeGenerator(gl, compiler, settings.resolution)
      bakeVolume = new VolumeTexture(gl, settings.resolution, settings.depth)
      target = createRenderTarget(gl, tileRes)
      sheetCtx = get2dContext(sheet)
      frameCtx = config.pngSequence ? get2dContext(frameCanvas) : null

      for (let i = 0; i < frames; i++) {
        const phase = i / frames
        const frameData = await generator.generateFrameData(
          layers,
          settings.resolution,
          settings.depth,
          settings.globalSeed,
          phase,
          animation.evolutions,
        )
        bakeVolume.uploadVolume(frameData)

        renderToTarget(target.fbo, tileRes, tileRes, bakeVolume, renderParams)
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
        const pixels = new Uint8Array(tileRes * tileRes * 4)
        gl.readPixels(0, 0, tileRes, tileRes, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        // WebGL readPixels is bottom-up; flip so the sheet matches the
        // top-down orientation the canvas (and the on-screen viewport) show.
        flipRowsY(pixels, tileRes, tileRes)

        const imageData = new ImageData(new Uint8ClampedArray(pixels), tileRes, tileRes)
        const { x, y } = flipbookCell(i, cols)
        sheetCtx.putImageData(imageData, x * tileRes, y * tileRes)

        if (config.pngSequence && frameCtx) {
          frameCtx.putImageData(imageData, 0, 0)
          const blob = await canvasToPngBlob(frameCanvas)
          const buf = new Uint8Array(await blob.arrayBuffer())
          pngFiles[`${config.filenameBase}/frame_${String(i).padStart(4, '0')}.png`] = buf
        }

        onProgress?.((i + 1) / frames)
      }

      const sheetBlob = await canvasToPngBlob(sheet)
      const sheetBytes = new Uint8Array(await sheetBlob.arrayBuffer())
      await saveBytes(sheetBytes, {
        suggestedName: `${config.filenameBase}_flipbook.png`,
        mime: 'image/png',
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      })

      if (config.pngSequence) {
        const { zip } = await import('fflate')
        const zipped = await new Promise<Uint8Array>((resolve, reject) => {
          zip(pngFiles, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)))
        })
        await saveBytes(zipped, {
          suggestedName: `${config.filenameBase}_flipbook_frames.zip`,
          mime: 'application/zip',
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        })
      }

      const metadata: FlipbookMetadata = {
        frames,
        fps: config.fps,
        cols,
        rows,
        tileRes,
        dims: { resolution: settings.resolution, depth: settings.depth },
        camera,
      }
      await saveText(JSON.stringify(metadata, null, 2), {
        suggestedName: `${config.filenameBase}_flipbook.json`,
        mime: 'application/json',
        filters: [{ name: 'JSON Metadata', extensions: ['json'] }],
      })
    } finally {
      // Null-guard each resource: only delete what was actually created.
      if (generator) generator.destroy()
      if (bakeVolume) bakeVolume.destroy()
      if (target) {
        gl.deleteFramebuffer(target.fbo)
        gl.deleteTexture(target.texture)
      }
      // renderParams.colorRampTexture was built just for this bake (see
      // Viewport.snapshotRaymarchParams) — ownership passes to us here.
      gl.deleteTexture(renderParams.colorRampTexture)
    }
  }
}

function createRenderTarget(gl: WebGL2RenderingContext, tileRes: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
  const texture = gl.createTexture()
  if (!texture) throw new Error('Failed to create flipbook render-target texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tileRes, tileRes, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const fbo = gl.createFramebuffer()
  if (!fbo) {
    gl.deleteTexture(texture)
    throw new Error('Failed to create flipbook render-target framebuffer')
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(texture)
    throw new Error(`Flipbook render-target framebuffer incomplete (status ${status})`)
  }
  return { fbo, texture }
}

// In-place vertical flip of a tightly-packed RGBA8 buffer.
function flipRowsY(data: Uint8Array, width: number, height: number): void {
  const rowBytes = width * 4
  const row = new Uint8Array(rowBytes)
  for (let y = 0; y < Math.floor(height / 2); y++) {
    const top = y * rowBytes
    const bottom = (height - 1 - y) * rowBytes
    row.set(data.subarray(top, top + rowBytes))
    data.copyWithin(top, bottom, bottom + rowBytes)
    data.set(row, bottom)
  }
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context is unavailable during flipbook export')
  return ctx
}

// Mirrors ExportManager's toBlob-with-toDataURL-fallback pattern.
async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob) return blob

  const dataUrl = canvas.toDataURL('image/png')
  const [, base64 = ''] = dataUrl.split(',', 2)
  if (!base64) {
    throw new Error('Failed to encode flipbook PNG image')
  }

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return new Blob([bytes], { type: 'image/png' })
}
