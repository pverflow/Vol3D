// GPU-resident sparse animation cache (VFX-1 Task 2).
// One shared RG8 3D "atlas" texture holds every active brick used across the
// whole animation loop (built once from Task 1's AtlasBuilder); one RGBA8 3D
// "indirection" texture per frame maps each macrocell to its brick's slot in
// the atlas (or "empty"). Task 4 samples both per raymarch step: look up the
// indirection texel for the current macrocell, then sample the atlas at the
// brick's slot offset + local position.
import { BRICK_SIZE, ANIMATION_CACHE_BUDGET_BYTES } from '../constants'
import { AtlasBuilder, macroDims } from './brickPack'

export class BrickCache {
  private readonly gl: WebGL2RenderingContext
  private atlasTex: WebGLTexture | null = null
  private indirTextures: WebGLTexture[] = []
  private _atlasDimsInBricks: [number, number, number] = [0, 0, 0]
  private _macroDims: [number, number, number] = [0, 0, 0]

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  get frameCount(): number {
    return this.indirTextures.length
  }

  get atlasDimsInBricks(): [number, number, number] {
    return this._atlasDimsInBricks
  }

  get macroDims(): [number, number, number] {
    return this._macroDims
  }

  // Brick budget that fits both the VRAM budget and this GPU's
  // MAX_3D_TEXTURE_SIZE — callers construct their AtlasBuilder with this
  // *before* packing (slot->xyz placement is fixed at pack time, see
  // brickPack.ts, so the cap can't be applied retroactively in build()).
  static computeMaxBricks(
    gl: WebGL2RenderingContext,
    budgetBytes: number = ANIMATION_CACHE_BUDGET_BYTES,
    brick: number = BRICK_SIZE
  ): number {
    const bytesPerBrick = brick * brick * brick * 2
    const byBudget = Math.max(1, Math.floor(budgetBytes / bytesPerBrick))
    const maxTexSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number
    const bpaLimit = Math.max(1, Math.floor(maxTexSize / brick))
    const byGL = bpaLimit * bpaLimit * bpaLimit
    return Math.min(byBudget, byGL)
  }

  // Uploads the atlas + one indirection texture per frame. Frees any
  // previously built textures first, so calling build() again (e.g. on a
  // volume/resolution change) never leaks the old GPU resources.
  build(builder: AtlasBuilder, indirections: Uint8Array[], res: number, depth: number): void {
    const { gl } = this
    this.destroy()

    const brick = BRICK_SIZE
    const bpa = builder.bricksPerAxis
    const maxTexSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number
    if (bpa * brick > maxTexSize) {
      // The AtlasBuilder was sized for a larger GPU than this one. Slot->xyz
      // placement is fixed at pack time (see brickPack.ts), so this can't be
      // silently shrunk here — fail loud instead of uploading a corrupt or
      // truncated atlas. Callers must re-pack using
      // BrickCache.computeMaxBricks(gl) as the brick budget.
      throw new Error(
        `BrickCache: atlas (${bpa * brick}^3 texels) exceeds this GPU's MAX_3D_TEXTURE_SIZE ` +
          `(${maxTexSize}). Re-pack with BrickCache.computeMaxBricks(gl) as the brick budget.`
      )
    }

    this._atlasDimsInBricks = builder.atlasDimsInBricks
    this._macroDims = macroDims(res, depth)

    // Guard texture creation: if anything below throws (e.g. GPU OOM on a
    // large atlas), clean up whatever was already created instead of leaking
    // it — the caller is left with a cleanly-empty cache, not a half-built one.
    try {
      const [ax, ay, az] = this._atlasDimsInBricks
      const atlasTex = gl.createTexture()
      if (!atlasTex) throw new Error('BrickCache: failed to create atlas texture')
      this.atlasTex = atlasTex
      gl.bindTexture(gl.TEXTURE_3D, atlasTex)
      // NEAREST, not LINEAR: bricks are packed edge-to-edge in the atlas, so
      // trilinear filtering would blend across unrelated neighboring bricks
      // at brick boundaries. v1 accepts blocky sampling within a brick;
      // Task 4 can add per-brick-local trilinear (clamping the sample to the
      // brick's own footprint) if that seam visibly matters.
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      gl.texImage3D(
        gl.TEXTURE_3D, 0, gl.RG8,
        ax * brick, ay * brick, az * brick,
        0, gl.RG, gl.UNSIGNED_BYTE, builder.data()
      )
      gl.bindTexture(gl.TEXTURE_3D, null)

      const [mx, my, mz] = this._macroDims
      for (const indirection of indirections) {
        const tex = gl.createTexture()
        if (!tex) throw new Error('BrickCache: failed to create indirection texture')
        gl.bindTexture(gl.TEXTURE_3D, tex)
        // NEAREST: indirection texels are an exact slot lookup, not a value
        // to interpolate.
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
        gl.texImage3D(
          gl.TEXTURE_3D, 0, gl.RGBA8,
          mx, my, mz,
          0, gl.RGBA, gl.UNSIGNED_BYTE, indirection
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
        this.indirTextures.push(tex)
      }
    } catch (err) {
      this.destroy()
      throw err
    }
  }

  // Binds the shared atlas at `atlasUnit` and frame `index`'s indirection
  // texture at `indirUnit`.
  bindForFrame(index: number, atlasUnit: number, indirUnit: number): void {
    const { gl } = this
    const tex = this.indirTextures[index]
    if (!tex) throw new Error(`BrickCache: no indirection texture for frame ${index} (frameCount=${this.frameCount})`)
    gl.activeTexture(gl.TEXTURE0 + atlasUnit)
    gl.bindTexture(gl.TEXTURE_3D, this.atlasTex)
    gl.activeTexture(gl.TEXTURE0 + indirUnit)
    gl.bindTexture(gl.TEXTURE_3D, tex)
  }

  destroy(): void {
    const { gl } = this
    if (this.atlasTex) gl.deleteTexture(this.atlasTex)
    this.atlasTex = null
    for (const tex of this.indirTextures) gl.deleteTexture(tex)
    this.indirTextures = []
    this._atlasDimsInBricks = [0, 0, 0]
    this._macroDims = [0, 0, 0]
  }
}
