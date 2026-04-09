// Ping-pong 2D FBOs for per-slice layer accumulation

export interface FBO {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

export class SliceBuffer {
  private gl: WebGL2RenderingContext
  readonly resolution: number
  private accumulators: [FBO, FBO]
  private layerFbo: FBO
  private pingIndex = 0

  constructor(gl: WebGL2RenderingContext, resolution: number) {
    this.gl = gl
    this.resolution = resolution
    this.accumulators = [this.createFBO('Accumulator A'), this.createFBO('Accumulator B')]
    this.layerFbo = this.createFBO('Layer Output')
  }

  private createFBO(label: string): FBO {
    const { gl, resolution } = this

    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, resolution, resolution, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
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

  // Clear accumulator to black
  clearAccumulator() {
    this.beginSlice()
  }

  // Read back pixels from the accumulator as Uint8Array (RGBA)
  readPixels(): Uint8Array {
    const { gl, resolution } = this
    const data = new Uint8Array(resolution * resolution * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumulatorRead.framebuffer)
    gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return data
  }

  destroy() {
    const { gl } = this
    for (const fbo of [...this.accumulators, this.layerFbo]) {
      gl.deleteFramebuffer(fbo.framebuffer)
      gl.deleteTexture(fbo.texture)
    }
  }
}
