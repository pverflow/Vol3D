import { ShaderCompiler } from './ShaderCompiler'
import { VolumeTexture } from '../volume/VolumeTexture'
import { SliceBuffer } from '../volume/SliceBuffer'
import { NoiseType, BlendMode, FeatherShape } from '../../types/index'
import type { Layer } from '../../types/index'
import { deg2rad, mat3FromEuler } from '../../utils/mathUtils'

const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  [BlendMode.Normal]: 0,
  [BlendMode.Add]: 1,
  [BlendMode.Multiply]: 2,
  [BlendMode.Screen]: 3,
  [BlendMode.Overlay]: 4,
  [BlendMode.Subtract]: 5,
}

export type ProgressCallback = (progress: number) => void

export class VolumeGenerator {
  private gl: WebGL2RenderingContext
  private compiler: ShaderCompiler
  private sliceBuffer: SliceBuffer
  private vao: WebGLVertexArrayObject
  private rafId: number | null = null
  // Scratch FBO reused every slice/every generate() call to attach a volume
  // layer as a render target. Never holds a permanent attachment.
  private volumeTargetFbo: WebGLFramebuffer

  // One-time capability probe (Task 3): can we render directly into a layer
  // of an R8 3D texture? True on effectively all WebGL2 implementations (R8
  // is a core-required color-renderable format), checked defensively so a
  // broken driver falls back cleanly instead of producing a black volume.
  readonly canRenderToVolume: boolean

  constructor(gl: WebGL2RenderingContext, compiler: ShaderCompiler, resolution: number) {
    this.gl = gl
    this.compiler = compiler
    this.sliceBuffer = new SliceBuffer(gl, resolution)

    // Empty VAO for fullscreen triangle
    this.vao = gl.createVertexArray()!
    this.volumeTargetFbo = gl.createFramebuffer()!
    this.canRenderToVolume = this.probeCanRenderToVolume()
  }

  private probeCanRenderToVolume(): boolean {
    const { gl } = this
    const tex = gl.createTexture()
    if (!tex) return false

    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 4, 4, 4, 0, gl.RED, gl.UNSIGNED_BYTE, null)
    gl.bindTexture(gl.TEXTURE_3D, null)

    const fb = gl.createFramebuffer()
    let ok = false
    if (fb) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 0)
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.deleteFramebuffer(fb)
    }
    gl.deleteTexture(tex)
    return ok
  }

  // Live path: writes RAW density directly into the volume's 3D texture,
  // slice by slice, with no CPU readback and no baked cutoff/contrast
  // (Task 3 — shaping moved to preview-time uniforms / export-time re-apply).
  // Falls back to the v1-shaped readback+upload structure (minus the baked
  // shaping) if the direct-render probe failed.
  generate(
    layers: Layer[],
    volume: VolumeTexture,
    globalSeed: number,
    animPhase: number,
    animEvolutions: number,
    onProgress?: ProgressCallback,
    onComplete?: () => void
  ) {
    const { resolution, depth } = volume
    const activeLayers = layers.filter(l => l.visible)

    const renderSlice: (z: number) => void = this.canRenderToVolume
      ? (z) => this.generateSliceLive(z, depth, activeLayers, globalSeed, animPhase, animEvolutions, volume)
      : (z) => {
          this.generateSlice(z, resolution, depth, activeLayers, globalSeed, animPhase, animEvolutions)
          const rgba = this.sliceBuffer.readPixels()
          volume.uploadSlice(z, extractRedSlice(rgba, resolution))
        }

    this.runSliceLoop(resolution, depth, renderSlice, onProgress, onComplete)
  }

  // Cache/animation path: still needs CPU bytes (frames are cached as
  // Uint8Array and re-uploaded via VolumeTexture.uploadVolume), so it always
  // reads back. Now outputs RAW density too — no baked cutoff/contrast.
  generateFrameData(
    layers: Layer[],
    resolution: number,
    depth: number,
    globalSeed: number,
    animPhase: number,
    animEvolutions: number,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    const frame = new Uint8Array(resolution * resolution * depth)
    const activeLayers = layers.filter(l => l.visible)

    return new Promise((resolve) => {
      const renderSlice = (z: number) => {
        this.generateSlice(z, resolution, depth, activeLayers, globalSeed, animPhase, animEvolutions)
        const rgba = this.sliceBuffer.readPixels()
        frame.set(extractRedSlice(rgba, resolution), z * resolution * resolution)
      }
      this.runSliceLoop(resolution, depth, renderSlice, onProgress, () => resolve(frame))
    })
  }

  // Shared chunked scheduler: cancels any in-flight loop, then walks slices
  // SLICES_PER_FRAME at a time across rAF ticks, invoking `renderSlice(z)` for
  // each slice — either the direct-to-volume render or the render+readback
  // action, depending on the caller.
  private runSliceLoop(
    resolution: number,
    depth: number,
    renderSlice: (z: number) => void,
    onProgress?: ProgressCallback,
    onComplete?: () => void
  ): void {
    // Cancel any in-progress generation
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    // Process slices in chunks across frames
    const SLICES_PER_FRAME = resolution <= 64 ? resolution : 8
    let currentSlice = 0

    const processChunk = () => {
      if (this.gl.isContextLost()) { this.rafId = null; return }

      const end = Math.min(currentSlice + SLICES_PER_FRAME, depth)

      for (let z = currentSlice; z < end; z++) {
        renderSlice(z)
      }

      currentSlice = end
      onProgress?.(currentSlice / depth)

      if (currentSlice < depth) {
        this.rafId = requestAnimationFrame(processChunk)
      } else {
        this.rafId = null
        onComplete?.()
      }
    }

    this.rafId = requestAnimationFrame(processChunk)
  }

  // Layer-generation pass: evaluates one layer's noise+distortion into
  // sliceBuffer.layerOutput (a 2D FBO). Shared by both the accumulator-only
  // path and the direct-to-volume path.
  private runLayerGenPass(
    layer: Layer,
    sliceZ: number,
    globalSeed: number,
    animPhase: number,
    animEvolutions: number
  ) {
    const { gl, compiler, sliceBuffer } = this
    const noiseType = layer.noise.type
    const fbmBase = layer.noise.fbm?.baseNoise ?? NoiseType.Simplex
    const distType = layer.distortion.type

    const genProg = compiler.buildLayerGenShader(noiseType, fbmBase, distType)
    gl.useProgram(genProg.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, sliceBuffer.layerOutput.framebuffer)

    // Upload uniforms
    const rot = mat3FromEuler(
      deg2rad(layer.noise.rotation[0]),
      deg2rad(layer.noise.rotation[1]),
      deg2rad(layer.noise.rotation[2])
    )
    compiler.setUniformMat3(genProg, 'u_rotation', rot)
    compiler.setUniform(genProg, 'u_scale', layer.noise.scale[0], layer.noise.scale[1], layer.noise.scale[2])
    compiler.setUniform(genProg, 'u_amplitude', layer.noise.amplitude)
    compiler.setUniform(genProg, 'u_offset', layer.noise.offset[0], layer.noise.offset[1], layer.noise.offset[2])
    compiler.setUniform(genProg, 'u_seed', layer.noise.seed + globalSeed)
    compiler.setUniform(genProg, 'u_sliceZ', sliceZ)
    compiler.setUniform(genProg, 'u_remapInput', layer.remap.inputMin, layer.remap.inputMax)
    compiler.setUniform(genProg, 'u_remapOutput', layer.remap.outputMin, layer.remap.outputMax)
    compiler.setUniform(genProg, 'u_remapCurve', ...layer.remap.remapCurve)
    compiler.setUniform(genProg, 'u_featherWidth', layer.remap.featherX, layer.remap.featherY, layer.remap.featherZ)
    compiler.setUniformi(genProg, 'u_featherShape', layer.remap.featherShape === FeatherShape.Sphere ? 1 : 0)
    compiler.setUniform(genProg, 'u_featherCurve', ...layer.remap.featherCurve)
    compiler.setUniform(genProg, 'u_animPhase', animPhase)
    compiler.setUniform(genProg, 'u_animEvolutions', animEvolutions)
    compiler.setUniformBool(genProg, 'u_invert', layer.invert)

    if (noiseType === NoiseType.FBM) {
      const fbm = layer.noise.fbm
      if (fbm) {
        compiler.setUniformi(genProg, 'u_octaves', fbm.octaves)
        compiler.setUniform(genProg, 'u_persistence', fbm.persistence)
        compiler.setUniform(genProg, 'u_lacunarity', fbm.lacunarity)
      }
    }
    if (noiseType === NoiseType.Worley || (noiseType === NoiseType.FBM && fbmBase === NoiseType.Worley)) {
      const wMode = layer.noise.worleyMode === 'f1' ? 0 : layer.noise.worleyMode === 'f2' ? 1 : 2
      compiler.setUniformi(genProg, 'u_worleyMode', wMode)
    }

    // Distortion uniforms
    compiler.setUniform(genProg, 'u_warpStrength', layer.distortion.strength)
    compiler.setUniform(genProg, 'u_warpFrequency', layer.distortion.warpFrequency)
    compiler.setUniform(genProg, 'u_swirlAmount', layer.distortion.swirlAmount)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Composite pass: blends sliceBuffer.layerOutput onto sliceBuffer.accumulatorRead
  // and draws into whatever framebuffer `bindTarget` binds (the ping-pong
  // accumulator for intermediate layers, or a volume layer for the final
  // layer of the live path). Output is RAW density — no shaping here.
  private runCompositePass(layer: Layer, bindTarget: () => void) {
    const { gl, compiler, sliceBuffer } = this
    const compProg = compiler.buildCompositeShader()
    gl.useProgram(compProg.program)
    bindTarget()

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.layerOutput.texture)
    compiler.setUniformi(compProg, 'u_accumulator', 1)
    compiler.setUniformi(compProg, 'u_layerOutput', 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.accumulatorRead.texture)

    compiler.setUniform(compProg, 'u_opacity', layer.opacity)
    compiler.setUniformi(compProg, 'u_blendMode', BLEND_MODE_INDEX[layer.blendMode])

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Accumulator-only path (v1 structure): composites every layer through the
  // 2D ping-pong accumulator, leaving the final result in accumulatorRead for
  // the caller to read back. Used by generateFrameData() always, and by
  // generate() when canRenderToVolume is false.
  private generateSlice(
    z: number,
    resolution: number,
    depth: number,
    layers: Layer[],
    globalSeed: number,
    animPhase: number,
    animEvolutions: number
  ) {
    const { gl, sliceBuffer } = this
    const sliceZ = (z + 0.5) / depth

    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, resolution, resolution)
    sliceBuffer.beginSlice()

    for (const layer of layers) {
      this.runLayerGenPass(layer, sliceZ, globalSeed, animPhase, animEvolutions)
      this.runCompositePass(layer, () => gl.bindFramebuffer(gl.FRAMEBUFFER, sliceBuffer.accumulatorWrite.framebuffer))
      sliceBuffer.swapAccumulators()
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
  }

  // Direct-to-volume path (Task 3): identical layer-gen + composite passes,
  // but the LAST active layer's composite draw targets the volume's own
  // layer z directly via bindAsRenderTarget — no readPixels, no CPU shaping,
  // no uploadSlice. If there are no active (visible) layers, the volume
  // layer is cleared to zero density directly instead.
  private generateSliceLive(
    z: number,
    depth: number,
    layers: Layer[],
    globalSeed: number,
    animPhase: number,
    animEvolutions: number,
    volume: VolumeTexture
  ) {
    const { gl, sliceBuffer } = this
    const resolution = volume.resolution
    const sliceZ = (z + 0.5) / depth

    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, resolution, resolution)
    sliceBuffer.beginSlice()

    if (layers.length === 0) {
      volume.bindAsRenderTarget(this.volumeTargetFbo, z)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      layers.forEach((layer, i) => {
        const isLast = i === layers.length - 1
        this.runLayerGenPass(layer, sliceZ, globalSeed, animPhase, animEvolutions)
        this.runCompositePass(layer, () =>
          isLast
            ? volume.bindAsRenderTarget(this.volumeTargetFbo, z)
            : gl.bindFramebuffer(gl.FRAMEBUFFER, sliceBuffer.accumulatorWrite.framebuffer)
        )
        if (!isLast) sliceBuffer.swapAccumulators()
      })
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindVertexArray(null)
  }

  cancel() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  resize(resolution: number) {
    this.cancel()
    this.sliceBuffer.destroy()
    this.sliceBuffer = new SliceBuffer(this.gl, resolution)
  }

  destroy() {
    this.cancel()
    this.sliceBuffer.destroy()
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteFramebuffer(this.volumeTargetFbo)
  }
}

// Extract the red channel of an RGBA readback into a single-channel buffer.
// No shaping applied — the volume (and animation cache) now stores RAW
// density; cutoff/contrast are applied at preview-time (shaders) and
// export-time (ExportManager) instead.
function extractRedSlice(rgba: Uint8Array, resolution: number): Uint8Array {
  const red = new Uint8Array(resolution * resolution)
  for (let i = 0; i < red.length; i++) {
    red[i] = rgba[i * 4]
  }
  return red
}
