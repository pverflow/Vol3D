import { VolumeTexture } from '../volume/VolumeTexture'
import { ExportFormat } from '../../types/index'
import { saveBytes } from '../../platform/fileAccess'

export class ExportManager {
  private gl: WebGL2RenderingContext
  private volume: VolumeTexture

  constructor(gl: WebGL2RenderingContext, volume: VolumeTexture) {
    this.gl = gl
    this.volume = volume
  }

  async export(format: ExportFormat, filename: string, flipY: boolean): Promise<void> {
    switch (format) {
      case ExportFormat.PNGSequence:
        return this.exportPNGSequence(filename, flipY)
      case ExportFormat.SpriteSheet:
        return this.exportSpriteSheet(filename, flipY)
      case ExportFormat.RawR8:
        return this.exportRaw(filename, 'r8')
      case ExportFormat.RawRGBA8:
        return this.exportRaw(filename, 'rgba8')
      case ExportFormat.RawR32F:
        return this.exportRaw(filename, 'r32f')
      default:
        return this.exportPNGSequence(filename, flipY)
    }
  }

  private readSlice(z: number, flipY: boolean): Uint8Array {
    const { gl, volume } = this
    const res = volume.resolution

    // Create a temporary FBO to read from the 3D texture slice
    const fb = gl.createFramebuffer()!
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, volume.texture, 0, z)
      gl.readBuffer(gl.COLOR_ATTACHMENT0)

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Export framebuffer is incomplete for slice ${z} (status ${status})`)
      }

      const data = new Uint8Array(res * res * 4)
      gl.readPixels(0, 0, res, res, gl.RGBA, gl.UNSIGNED_BYTE, data)

      if (flipY) {
        // Flip rows
        const row = new Uint8Array(res * 4)
        for (let y = 0; y < Math.floor(res / 2); y++) {
          const top = y * res * 4
          const bot = (res - 1 - y) * res * 4
          row.set(data.subarray(top, top + res * 4))
          data.copyWithin(top, bot, bot + res * 4)
          data.set(row, bot)
        }
      }

      return data
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fb)
    }
  }

  private async exportPNGSequence(filename: string, flipY: boolean): Promise<void> {
    const { volume } = this
    const res = volume.resolution
    const depth = volume.depth
    const { zip } = await import('fflate')

    const files: Record<string, Uint8Array> = {}

    for (let z = 0; z < depth; z++) {
      const rgba = this.readSlice(z, flipY)
      const canvas = document.createElement('canvas')
      canvas.width = res
      canvas.height = res
      const ctx = this.getCanvas2DContext(canvas)
      const imageData = new ImageData(new Uint8ClampedArray(rgba), res, res)
      ctx.putImageData(imageData, 0, 0)

      const blob = await this.canvasToBlob(canvas)
      const arrBuf = await blob.arrayBuffer()
      const zStr = String(z).padStart(4, '0')
      files[`${filename}/slice_${zStr}.png`] = new Uint8Array(arrBuf)
    }

    return new Promise((resolve, reject) => {
      zip(files, { level: 0 }, (err, data) => {
        if (err) return reject(err)
        void saveBytes(data, {
          suggestedName: `${filename}.zip`,
          mime: 'application/zip',
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        }).then((saved) => {
          if (!saved) return resolve()
          resolve()
        }, reject)
      })
    })
  }

  private async exportSpriteSheet(filename: string, flipY: boolean): Promise<void> {
    const { volume } = this
    const res = volume.resolution
    const depth = volume.depth
    const cols = Math.ceil(Math.sqrt(depth))
    const rows = Math.ceil(depth / cols)

    const canvas = document.createElement('canvas')
    canvas.width = res * cols
    canvas.height = res * rows
    const ctx = this.getCanvas2DContext(canvas)

    for (let z = 0; z < depth; z++) {
      const rgba = this.readSlice(z, flipY)
      const sliceCanvas = document.createElement('canvas')
      sliceCanvas.width = res
      sliceCanvas.height = res
      const sc = this.getCanvas2DContext(sliceCanvas)
      sc.putImageData(new ImageData(new Uint8ClampedArray(rgba), res, res), 0, 0)

      const col = z % cols
      const row = Math.floor(z / cols)
      ctx.drawImage(sliceCanvas, col * res, row * res)
    }

    const blob = await this.canvasToBlob(canvas)
    const arrBuf = await blob.arrayBuffer() as ArrayBuffer
    await saveBytes(new Uint8Array(arrBuf), {
      suggestedName: `${filename}_spritesheet.png`,
      mime: 'image/png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
  }

  private async exportRaw(filename: string, mode: 'r8' | 'rgba8' | 'r32f'): Promise<void> {
    const { volume } = this
    const res = volume.resolution
    const depth = volume.depth
    const channels = mode === 'rgba8' ? 4 : 1
    const isFloat = mode === 'r32f'
    const out = isFloat
      ? new Float32Array(res * res * depth * channels)
      : new Uint8Array(res * res * depth * channels)

    for (let z = 0; z < depth; z++) {
      const rgba = this.readSlice(z, false)
      const offset = z * res * res * channels
      if (mode === 'r8') {
        for (let i = 0; i < res * res; i++) {
          (out as Uint8Array)[offset + i] = rgba[i * 4]  // red channel
        }
      } else if (mode === 'rgba8') {
        (out as Uint8Array).set(rgba, offset)
      } else {
        // r32f: normalize [0,255] -> [0,1]
        for (let i = 0; i < res * res; i++) {
          (out as Float32Array)[offset + i] = rgba[i * 4] / 255.0
        }
      }
    }

    const ext = isFloat ? 'raw' : 'raw'
    const mime = 'application/octet-stream'
    const suffix = mode === 'rgba8' ? '_rgba8' : mode === 'r32f' ? '_r32f' : '_r8'
    const buffer = out.buffer as ArrayBuffer
    await saveBytes(new Uint8Array(buffer), {
      suggestedName: `${filename}${suffix}_${res}x${res}x${depth}.${ext}`,
      mime,
      filters: [{ name: 'Raw Volume Data', extensions: [ext] }],
    })
  }

  private getCanvas2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('2D canvas context is unavailable during export')
    }
    return ctx
  }

  private async canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob) return blob

    const dataUrl = canvas.toDataURL('image/png')
    const [, base64 = ''] = dataUrl.split(',', 2)
    if (!base64) {
      throw new Error('Failed to encode exported PNG image')
    }

    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }

    return new Blob([bytes], { type: 'image/png' })
  }
}
