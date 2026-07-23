import type { Resolution, SliceCount } from '../../types/index'

export class VolumeTexture {
  readonly texture: WebGLTexture
  readonly resolution: number
  readonly depth: number
  private gl: WebGL2RenderingContext

  constructor(gl: WebGL2RenderingContext, resolution: Resolution, depth: SliceCount) {
    this.gl = gl
    this.resolution = resolution
    this.depth = depth

    const tex = gl.createTexture()
    if (!tex) throw new Error('Failed to create 3D texture')
    this.texture = tex

    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT)

    // Allocate storage
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.R8,
      resolution, resolution, depth,
      0, gl.RED, gl.UNSIGNED_BYTE, null
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
  }

  // Upload a single Z-slice from a Uint8Array (resolution x resolution, 1 channel)
  uploadSlice(z: number, data: Uint8Array) {
    const { gl, resolution } = this
    gl.bindTexture(gl.TEXTURE_3D, this.texture)
    gl.texSubImage3D(
      gl.TEXTURE_3D, 0,
      0, 0, z,
      resolution, resolution, 1,
      gl.RED, gl.UNSIGNED_BYTE, data
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
  }

  uploadVolume(data: Uint8Array) {
    const { gl, resolution, depth } = this
    gl.bindTexture(gl.TEXTURE_3D, this.texture)
    gl.texSubImage3D(
      gl.TEXTURE_3D, 0,
      0, 0, 0,
      resolution, resolution, depth,
      gl.RED, gl.UNSIGNED_BYTE, data
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
  }

  bind(unit: number) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit)
    this.gl.bindTexture(this.gl.TEXTURE_3D, this.texture)
  }

  // Attach Z-layer `z` of this 3D texture as COLOR_ATTACHMENT0 of `fb` so a
  // fragment shader can render raw density directly into that slice (Task 3
  // live generation path). Returns the framebuffer completeness status —
  // caller checks against gl.FRAMEBUFFER_COMPLETE. Mirrors the pattern in
  // ExportManager.readSlice.
  bindAsRenderTarget(fb: WebGLFramebuffer, z: number): number {
    const { gl } = this
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.texture, 0, z)
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  }

  destroy() {
    this.gl.deleteTexture(this.texture)
  }
}
