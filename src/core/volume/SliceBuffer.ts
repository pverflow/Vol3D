// Ping-pong 2D FBOs for per-slice layer accumulation

export interface FBO {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

interface ColorFormat {
  internalFormat: number
  type: number
  usingFloat: boolean
}

export class SliceBuffer {
  private gl: WebGL2RenderingContext
  readonly resolution: number
  readonly usingFloat: boolean
  private accumulators: [FBO, FBO]
  private layerFbo: FBO
  // RGBA8 target the final (possibly float) accumulator is blitted into before
  // readPixels(), since readPixels() reads UNSIGNED_BYTE and you can't read a
  // float framebuffer as bytes directly. Only allocated when accumulators are
  // float; null (and unused) when they're already RGBA8. Removed in Task 3
  // once the live generation path stops reading back per-slice.
  private resolveFbo: FBO | null
  private pingIndex = 0

  constructor(gl: WebGL2RenderingContext, resolution: number) {
    this.gl = gl
    this.resolution = resolution

    const format = this.chooseAccumulatorFormat()
    this.usingFloat = format.usingFloat

    this.accumulators = [
      this.createFBO('Accumulator A', format.internalFormat, format.type),
      this.createFBO('Accumulator B', format.internalFormat, format.type),
    ]
    this.layerFbo = this.createFBO('Layer Output', gl.RGBA8, gl.UNSIGNED_BYTE)
    this.resolveFbo = this.usingFloat ? this.createFBO('Resolve', gl.RGBA8, gl.UNSIGNED_BYTE) : null
  }

  // Decide the accumulator color format once: RGBA16F/HALF_FLOAT if
  // EXT_color_buffer_float is available AND a real FBO built with it is
  // complete, else fall back to RGBA8/UNSIGNED_BYTE. Probes with a throwaway
  // 4x4 FBO so the decision doesn't depend on the real resolution.
  private chooseAccumulatorFormat(): ColorFormat {
    const { gl } = this

    if (gl.getExtension('EXT_color_buffer_float')) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null)
      gl.bindTexture(gl.TEXTURE_2D, null)

      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      gl.deleteFramebuffer(fb)
      gl.deleteTexture(tex)

      if (status === gl.FRAMEBUFFER_COMPLETE) {
        return { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT, usingFloat: true }
      }
    }

    return { internalFormat: gl.RGBA8, type: gl.UNSIGNED_BYTE, usingFloat: false }
  }

  private createFBO(label: string, internalFormat: number, type: number): FBO {
    const { gl, resolution } = this

    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, resolution, resolution, 0, gl.RGBA, type, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)

    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fb)
      gl.deleteTexture(tex)
      throw new Error(`[WebGL] ${label} framebuffer is incomplete (status: 0x${status.toString(16)})`)
    }

    return { framebuffer: fb, texture: tex }
  }

  get accumulatorRead(): FBO { return this.accumulators[this.pingIndex] }
  get accumulatorWrite(): FBO { return this.accumulators[1 - this.pingIndex] }
  get layerOutput(): FBO { return this.layerFbo }

  swapAccumulators() { this.pingIndex = 1 - this.pingIndex }

  beginSlice() {
    this.pingIndex = 0
    this.clearFbo(this.accumulatorRead)
    this.clearFbo(this.accumulatorWrite)
    this.clearFbo(this.layerOutput)
  }

  private clearFbo(fbo: FBO) {
    const { gl } = this
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer)
    gl.viewport(0, 0, this.resolution, this.resolution)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // Read back pixels from the accumulator as Uint8Array (RGBA). If the
  // accumulator is a float target, blit it into the RGBA8 resolve FBO first —
  // readPixels(..., UNSIGNED_BYTE) on a float framebuffer is invalid.
  readPixels(): Uint8Array {
    const { gl, resolution } = this
    const data = new Uint8Array(resolution * resolution * 4)
    const source = this.usingFloat ? this.resolveAccumulator() : this.accumulatorRead

    gl.bindFramebuffer(gl.FRAMEBUFFER, source.framebuffer)
    gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return data
  }

  private resolveAccumulator(): FBO {
    const { gl, resolution } = this
    const resolve = this.resolveFbo!

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accumulatorRead.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolve.framebuffer)
    gl.blitFramebuffer(0, 0, resolution, resolution, 0, 0, resolution, resolution, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)

    return resolve
  }

  destroy() {
    const { gl } = this
    const fbos = this.resolveFbo ? [...this.accumulators, this.layerFbo, this.resolveFbo] : [...this.accumulators, this.layerFbo]
    for (const fbo of fbos) {
      gl.deleteFramebuffer(fbo.framebuffer)
      gl.deleteTexture(fbo.texture)
    }
  }
}
