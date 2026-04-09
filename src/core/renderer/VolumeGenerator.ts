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
  private onProgress: ProgressCallback | null = null
  private onComplete: (() => void) | null = null

  constructor(gl: WebGL2RenderingContext, compiler: ShaderCompiler, resolution: number) {
    this.gl = gl
    this.compiler = compiler
    this.sliceBuffer = new SliceBuffer(gl, resolution)

    // Empty VAO for fullscreen triangle
    this.vao = gl.createVertexArray()!
  }

  generate(
    layers: Layer[],
    volume: VolumeTexture,
    globalSeed: number,
    cutoff: number,
    contrast: number,
    animPhase: number,
    animEvolutions: number,
    onProgress?: ProgressCallback,
    onComplete?: () => void
  ) {
    // Cancel any in-progress generation
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    this.onProgress = onProgress ?? null
    this.onComplete = onComplete ?? null

    const activeLayers = layers.filter(l => l.visible)
    const resolution = volume.resolution
    const totalSlices = volume.depth

    // Process slices in chunks across frames
    const SLICES_PER_FRAME = resolution <= 64 ? resolution : 8
    let currentSlice = 0

    const processChunk = () => {
      const end = Math.min(currentSlice + SLICES_PER_FRAME, totalSlices)

      for (let z = currentSlice; z < end; z++) {
        this.generateSlice(z, resolution, totalSlices, activeLayers, globalSeed, animPhase, animEvolutions)

        // Read back and upload to 3D texture
        const rgba = this.sliceBuffer.readPixels()
        const red = extractAdjustedRedSlice(rgba, resolution, cutoff, contrast)
        volume.uploadSlice(z, red)
      }

      currentSlice = end
      const progress = currentSlice / totalSlices
      this.onProgress?.(progress)

      if (currentSlice < totalSlices) {
        this.rafId = requestAnimationFrame(processChunk)
      } else {
        this.rafId = null
        this.onComplete?.()
      }
    }

    this.rafId = requestAnimationFrame(processChunk)
  }

  generateFrameData(
    layers: Layer[],
    resolution: number,
    depth: number,
    globalSeed: number,
    cutoff: number,
    contrast: number,
    animPhase: number,
    animEvolutions: number,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }

    const activeLayers = layers.filter(l => l.visible)
    const frame = new Uint8Array(resolution * resolution * depth)
    const SLICES_PER_FRAME = resolution <= 64 ? resolution : 8
    let currentSlice = 0

    return new Promise((resolve) => {
      const processChunk = () => {
        const end = Math.min(currentSlice + SLICES_PER_FRAME, depth)

        for (let z = currentSlice; z < end; z++) {
          this.generateSlice(z, resolution, depth, activeLayers, globalSeed, animPhase, animEvolutions)
          const rgba = this.sliceBuffer.readPixels()
          const red = extractAdjustedRedSlice(rgba, resolution, cutoff, contrast)
          frame.set(red, z * resolution * resolution)
        }

        currentSlice = end
        onProgress?.(currentSlice / depth)

        if (currentSlice < depth) {
          this.rafId = requestAnimationFrame(processChunk)
        } else {
          this.rafId = null
          resolve(frame)
        }
      }

      this.rafId = requestAnimationFrame(processChunk)
    })
  }

  private generateSlice(
    z: number,
    resolution: number,
    depth: number,
    layers: Layer[],
    globalSeed: number,
    animPhase: number,
    animEvolutions: number
  ) {
    const { gl, compiler, sliceBuffer } = this
    const sliceZ = (z + 0.5) / depth

    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, resolution, resolution)

    // Clear accumulator for this slice
    sliceBuffer.beginSlice()

    for (const layer of layers) {
      const noiseType = layer.noise.type
      const fbmBase = layer.noise.fbm?.baseNoise ?? NoiseType.Simplex
      const distType = layer.distortion.type

      // --- Layer generation pass ---
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

      if (noiseType === NoiseType.FBM || noiseType === NoiseType.Worley) {
        const fbm = layer.noise.fbm
        if (fbm) {
          compiler.setUniformi(genProg, 'u_octaves', fbm.octaves)
          compiler.setUniform(genProg, 'u_persistence', fbm.persistence)
          compiler.setUniform(genProg, 'u_lacunarity', fbm.lacunarity)
        }
      }
      if (noiseType === NoiseType.Worley) {
        const wMode = layer.noise.worleyMode === 'f1' ? 0 : layer.noise.worleyMode === 'f2' ? 1 : 2
        compiler.setUniformi(genProg, 'u_worleyMode', wMode)
      }

      // Distortion uniforms
      compiler.setUniform(genProg, 'u_warpStrength', layer.distortion.strength)
      compiler.setUniform(genProg, 'u_warpFrequency', layer.distortion.warpFrequency)
      compiler.setUniform(genProg, 'u_swirlAmount', layer.distortion.swirlAmount)

      gl.drawArrays(gl.TRIANGLES, 0, 3)

      // --- Composite pass ---
      const compProg = compiler.buildCompositeShader()
      gl.useProgram(compProg.program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, sliceBuffer.accumulatorWrite.framebuffer)

      // Bind textures
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.layerOutput.texture)
      compiler.setUniformi(compProg, 'u_accumulator', 1)
      compiler.setUniformi(compProg, 'u_layerOutput', 0)

      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, sliceBuffer.accumulatorRead.texture)

      compiler.setUniform(compProg, 'u_opacity', layer.opacity)
      compiler.setUniformi(compProg, 'u_blendMode', BLEND_MODE_INDEX[layer.blendMode])

      gl.drawArrays(gl.TRIANGLES, 0, 3)

      // Swap: accumulator is now the output we just wrote
      sliceBuffer.swapAccumulators()
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
  }
}

function applyVolumeAdjustments(value: number, cutoff: number, contrast: number): number {
  const thresholded = Math.max((value - cutoff) / Math.max(1 - cutoff, 0.0001), 0)
  const contrasted = (thresholded - 0.5) * contrast + 0.5
  return Math.max(0, Math.min(1, contrasted))
}

function extractAdjustedRedSlice(rgba: Uint8Array, resolution: number, cutoff: number, contrast: number): Uint8Array {
  const red = new Uint8Array(resolution * resolution)
  for (let i = 0; i < red.length; i++) {
    const normalized = rgba[i * 4] / 255
    red[i] = Math.round(applyVolumeAdjustments(normalized, cutoff, contrast) * 255)
  }
  return red
}

