import { WebGLContext } from '../../core/renderer/WebGLContext'
import { ShaderCompiler } from '../../core/renderer/ShaderCompiler'
import type { CompiledProgram } from '../../core/renderer/ShaderCompiler'
import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import { BrickCache } from '../../core/volume/BrickCache'
import { CameraController } from './CameraController'
import { AnimationController } from './AnimationController'
import { ViewportOverlay } from './ViewportOverlay'
import type { StateManager } from '../../state/StateManager'
import { shouldRegenerateOnSettings } from '../../state/StateManager'
import type { AnimationSettings, ExportRequest, FlipbookConfig, Resolution, SliceCount, VolumeSettings } from '../../types/index'
import { PreviewMode, SliceAxis, ProjectionMode, ExportFormat } from '../../types/index'
import { REGEN_DEBOUNCE_MS, RAYMARCH_TAN_HALF_FOV, LIGHT_DIR } from '../../core/constants'
import { proxyDimension } from './proxyDimension'
import { buildRampLUT } from '../../core/colorRamp'
import type { ColorRamp } from '../../core/colorRamp'
import type { RaymarchParams } from '../../core/export/FlipbookExporter'

const AXIS_MAP: Record<SliceAxis, number> = { x: 0, y: 1, z: 2 }
const PREVIEW_MODE_ORDER: PreviewMode[] = [PreviewMode.Raymarched, PreviewMode.Slice, PreviewMode.Projection]
const RAMP_LUT_SIZE = 256
const RAMP_LUT_TEXTURE_UNIT = 1
// Sparse brick cache (VFX-1 Task 4): dedicated units so they never collide
// with u_volume (0) or the color-ramp LUT (1).
const SPARSE_ATLAS_TEXTURE_UNIT = 2
const SPARSE_INDIRECTION_TEXTURE_UNIT = 3

export class Viewport {
  readonly el: HTMLElement
  readonly canvas: HTMLCanvasElement
  private ctx: WebGLContext
  private compiler: ShaderCompiler
  private generator: VolumeGenerator
  private cacheGenerator: VolumeGenerator
  // Dedicated generator for the sparse-cache bake (VFX-1 Task 3) — separate
  // from cacheGenerator so the bake's chunked-rAF loop never contends with
  // the dense per-frame cache build's own loop (VolumeGenerator only tracks
  // one in-flight loop per instance; see AnimationController's doc comment).
  private sparseCacheGenerator: VolumeGenerator
  // GPU-resident sparse brick atlas + per-frame indirection textures
  // (VFX-1 Task 3). Built by AnimationController.buildSparseCache(); not yet
  // sampled by any render path (T4/T5) — owned here so it can be freed on
  // destroy/context-restore like every other GL resource.
  private brickCache: BrickCache
  private volume: VolumeTexture
  // Low-res drag proxy (Task 4): a second, cheap VolumeTexture + its own
  // VolumeGenerator (own SliceBuffer sized at proxy resolution) so dragging
  // a generation-affecting control never has to resize/reallocate the
  // full-res generator's buffers. Regenerated in place of `volume` while
  // `interacting` is true; never used for export or the animation cache.
  private proxyGenerator: VolumeGenerator
  private proxyVolume: VolumeTexture
  // True while a generation-affecting control (Slider/BezierCurveEditor in
  // PropertiesPanel) is being dragged — see setInteracting().
  private interacting = false
  // True once proxyVolume holds a completed generation for its current
  // dimensions — gates the preview so it never samples an empty/stale proxy.
  private proxyReady = false
  // True from the moment a drag ends until the settle (full-res) generation
  // that follows it completes — keeps the preview on the (still-fresh)
  // proxy instead of flashing back to the stale pre-drag full-res volume.
  private settling = false
  private camera: CameraController
  private animation: AnimationController
  private overlay: ViewportOverlay
  private state: StateManager
  private rafId: number | null = null
  private vao: WebGLVertexArrayObject
  // Density -> RGBA color-ramp LUT texture (VFX-0 Task 3): a 256x1 RGBA8
  // texture rebuilt from `preview.colorRamp` only when that slice changes
  // (see the `preview` subscription below), not every frame.
  private lutTexture: WebGLTexture
  private lastColorRamp: ColorRamp
  private dirtyTimer: number | null = null
  private exportInProgress = false
  private readonly listeners = new AbortController()
  private resizeObserver!: ResizeObserver
  private unsubscribes: Array<() => void> = []
  private readonly previewRenderers: Record<PreviewMode, (w: number, h: number) => void>
  // Last settings seen by the subscription below, so it can tell whether a
  // change actually needs regeneration (resolution/depth/globalSeed) versus
  // a preview-only shading tweak (cutoff/contrast) that the render loop
  // already picks up live via u_cutoff/u_contrast — no regen needed.
  private lastSettings: VolumeSettings
  // TEST HOOK (VFX-1 Task 4 parity smoke) — not read by any real UI path.
  // When set, every render binds brickCache frame `sparseTestFrame` and
  // samples it sparsely (u_sparseEnabled=true) instead of the normal dense
  // volume, so a Playwright parity test can screenshot a baked sparse frame
  // next to the dense render of the same phase. T5 wires real sparse
  // playback through AnimationController; this hook can be removed then.
  private sparseTestFrame: number | null = null

  constructor(state: StateManager) {
    this.state = state

    this.el = document.createElement('div')
    this.el.className = 'viewport'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'viewport-canvas'
    this.el.appendChild(this.canvas)

    // Overlay controls
    this.overlay = new ViewportOverlay(state)
    this.el.appendChild(this.overlay.el)

    // WebGL setup
    this.ctx = new WebGLContext(this.canvas)
    const { gl } = this.ctx
    gl.getExtension('EXT_color_buffer_float')

    this.compiler = new ShaderCompiler(gl)

    const settings = state.get('settings')
    this.lastSettings = settings
    this.volume = new VolumeTexture(gl, settings.resolution as Resolution, settings.depth as SliceCount)
    this.generator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.cacheGenerator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.sparseCacheGenerator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.brickCache = new BrickCache(gl)

    const proxyRes = proxyDimension(settings.resolution)
    this.proxyVolume = new VolumeTexture(gl, proxyRes as Resolution, proxyDimension(settings.depth) as SliceCount)
    this.proxyGenerator = new VolumeGenerator(gl, this.compiler, proxyRes)
    this.animation = new AnimationController({
      state,
      cacheGenerator: this.cacheGenerator,
      sparseGenerator: this.sparseCacheGenerator,
      brickCache: this.brickCache,
      gl,
      getVolume: () => this.volume,
      onNeedsGeneration: () => this.scheduleGeneration(),
    })

    this.camera = new CameraController(this.canvas, state.get('camera'), (cam) => {
      state.update('camera', cam)
    })
    this.camera.setVolumeDepth(settings.resolution, settings.depth)

    this.lastColorRamp = state.get('preview').colorRamp
    this.lutTexture = this.createLutTexture(this.lastColorRamp)

    this.vao = gl.createVertexArray()!

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(this.el)

    // State subscriptions
    this.unsubscribes.push(state.subscribe('layers', () => {
      this.animation.invalidateAnimationCache()
      this.scheduleGeneration()
    }))
    this.unsubscribes.push(state.subscribe('settings', (s) => {
      const prev = this.lastSettings
      this.lastSettings = s
      this.camera.setVolumeDepth(s.resolution, s.depth)
      if (s.resolution !== this.volume.resolution || s.depth !== this.volume.depth) {
        this.resizeVolume(s)
      }
      if (shouldRegenerateOnSettings(prev, s)) {
        this.animation.invalidateAnimationCache()
        this.scheduleGeneration()
      }
    }))
    this.unsubscribes.push(state.subscribe('preview', (p) => {
      // Rebuild the LUT only when the colorRamp slice itself changed
      // (reference check — every other preview.* update leaves it
      // untouched), not on every unrelated preview tweak.
      if (p.colorRamp !== this.lastColorRamp) {
        this.lastColorRamp = p.colorRamp
        this.uploadRampLUT(p.colorRamp)
      }
    }))
    this.unsubscribes.push(state.subscribe('animation', (anim) => this.animation.handleAnimationChange(anim as AnimationSettings)))
    this.unsubscribes.push(state.subscribe('camera', (cam) => {
      this.camera.updateCamera(cam as typeof cam)
    }))

    // Export handler
    window.addEventListener('vol3d-export', (e: Event) => {
      const detail = (e as CustomEvent<ExportRequest>).detail
      this.handleExport(detail)
    }, { signal: this.listeners.signal })

    // WebGL context-loss recovery
    window.addEventListener('webgl-restored', () => this.handleContextRestored(), { signal: this.listeners.signal })

    this.previewRenderers = {
      [PreviewMode.Raymarched]: (w, h) => this.renderRaymarched(w, h),
      [PreviewMode.Slice]: () => this.renderSlicePlane(false),
      [PreviewMode.Projection]: () => this.renderSlicePlane(true),
    }

    this.startRenderLoop()
    this.scheduleGeneration()
  }

  private handleResize() {
    const rect = this.el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.floor(rect.width * dpr)
    this.canvas.height = Math.floor(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
  }

  private resizeVolume(settings: VolumeSettings) {
    this.volume.destroy()
    this.volume = new VolumeTexture(this.ctx.gl, settings.resolution as Resolution, settings.depth as SliceCount)
    this.generator.resize(settings.resolution)
    this.cacheGenerator.resize(settings.resolution)
    this.sparseCacheGenerator.resize(settings.resolution)
    this.animation.invalidateAnimationCache()

    const proxyRes = proxyDimension(settings.resolution)
    this.proxyVolume.destroy()
    this.proxyVolume = new VolumeTexture(this.ctx.gl, proxyRes as Resolution, proxyDimension(settings.depth) as SliceCount)
    this.proxyGenerator.resize(proxyRes)
    this.proxyReady = false
  }

  private handleContextRestored() {
    this.compiler.invalidateCache()
    this.animation.invalidateAnimationCache()
    const s = this.state.get('settings')
    this.resizeVolume(s) // rebuilds VolumeTexture + generator slice buffers
    this.ctx.gl.deleteTexture(this.lutTexture) // GL textures don't survive context loss
    this.lutTexture = this.createLutTexture(this.lastColorRamp)
    this.scheduleGeneration()
  }

  // Allocate the 256x1 RGBA8 LUT texture and seed it with `ramp`'s data.
  // LINEAR filtering gives smooth interpolation between texels (the LUT
  // builder already interpolates between stops at 256 texels of
  // resolution, so this just smooths the last mile); CLAMP_TO_EDGE avoids
  // wrap-around bleeding at t=0/t=1.
  private createLutTexture(ramp: ColorRamp): WebGLTexture {
    const { gl } = this.ctx
    const tex = gl.createTexture()
    if (!tex) throw new Error('Failed to create color-ramp LUT texture')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      RAMP_LUT_SIZE, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, buildRampLUT(ramp, RAMP_LUT_SIZE)
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
    return tex
  }

  private uploadRampLUT(ramp: ColorRamp) {
    const { gl } = this.ctx
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture)
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0,
      RAMP_LUT_SIZE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, buildRampLUT(ramp, RAMP_LUT_SIZE)
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  // Bind the LUT to its texture unit and set the two uniforms every render
  // path needs — called from renderRaymarched/renderSlicePlane right next
  // to the volume bind. `texture` defaults to the shared live LUT; the
  // flipbook bake passes its own frozen snapshot texture instead (see
  // RaymarchParams.colorRampTexture) so on-screen behavior is unchanged.
  private bindColorRamp(prog: CompiledProgram, enabled: boolean, texture: WebGLTexture = this.lutTexture) {
    const { gl } = this.ctx
    const { compiler } = this
    gl.activeTexture(gl.TEXTURE0 + RAMP_LUT_TEXTURE_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    compiler.setUniformi(prog, 'u_colorRamp', RAMP_LUT_TEXTURE_UNIT)
    compiler.setUniformBool(prog, 'u_colorRampEnabled', enabled)
  }

  scheduleGeneration() {
    if (this.dirtyTimer !== null) return
    this.dirtyTimer = window.setTimeout(() => {
      this.dirtyTimer = null
      this.runGeneration()
    }, REGEN_DEBOUNCE_MS)
  }

  // Called (e.g. from PropertiesPanel) on pointer-down/up of a
  // generation-affecting control. See the drag-proxy fields above.
  setInteracting(active: boolean) {
    if (this.interacting === active) return
    this.interacting = active
    if (active) {
      // Generate the proxy immediately so there's fresh low-res content to
      // preview right away instead of a flash of stale/empty data.
      this.generateProxy()
    } else {
      // Snap back to full res as soon as possible; keep previewing the
      // proxy until this completes so we never flash the stale pre-drag
      // full-res volume (see previewSource()).
      this.settling = true
      this.generateFull()
    }
  }

  private runGeneration() {
    if (this.interacting) {
      this.generateProxy()
    } else {
      this.generateFull()
    }
  }

  // Full-resolution generation: the authoritative volume used for the
  // settled (non-dragging) preview, export, and the animation cache.
  private generateFull() {
    const { state } = this
    this.animation.resetAppliedFrame()
    state.update('generating', true)
    state.update('progress', 0)

    const indicator = document.getElementById('gen-indicator')
    if (indicator) indicator.style.display = 'flex'

    this.generator.generate(
      state.get('layers'),
      this.volume,
      state.get('settings').globalSeed,
      state.get('animation').phase,
      state.get('animation').evolutions,
      (p) => state.update('progress', p),
      () => {
        state.update('generating', false)
        state.update('progress', 1)
        if (indicator) indicator.style.display = 'none'
        this.settling = false
        this.animation.buildAnimationCacheIfNeeded()
        // Sparse cache (VFX-1 Task 3): rebuild once settled, but only while
        // actually playing — an edit made while paused shouldn't pay for a
        // bake nobody's about to watch; it'll build on the next play-start.
        if (this.state.get('animation').playing) {
          this.animation.buildSparseCache()
        }
      }
    )
  }

  // Low-res drag proxy (Task 4): regenerates the cheap proxyVolume while a
  // generation-affecting control is being dragged. No progress/indicator UI
  // — proxy generations are meant to be cheap, invisible plumbing, not a
  // "Generating…" flash during otherwise-smooth dragging.
  private generateProxy() {
    const { state } = this
    this.proxyGenerator.generate(
      state.get('layers'),
      this.proxyVolume,
      state.get('settings').globalSeed,
      state.get('animation').phase,
      state.get('animation').evolutions,
      undefined,
      () => { this.proxyReady = true }
    )
  }

  // Which volume the preview should currently sample: the proxy while
  // dragging (or settling right after) and it holds a completed generation,
  // otherwise the full-res volume. Export and the animation cache always
  // use `this.volume` directly and never call this.
  private previewSource(): VolumeTexture {
    return (this.interacting || this.settling) && this.proxyReady ? this.proxyVolume : this.volume
  }

  private startRenderLoop() {
    const render = () => {
      this.rafId = requestAnimationFrame(render)
      this.renderFrame()
    }
    this.rafId = requestAnimationFrame(render)
  }

  private renderFrame() {
    this.animation.advanceAnimation(performance.now())

    const { gl } = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height
    if (w === 0 || h === 0) return

    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)

    const preview = this.state.get('preview')
    this.previewRenderers[preview.mode]?.(w, h)

    gl.bindVertexArray(null)
  }

  private beginPass(prog: CompiledProgram): WebGL2RenderingContext {
    const gl = this.ctx.gl
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return gl
  }

  private renderRaymarched(w: number, h: number) {
    const prog = this.compiler.buildRaymarchShader()
    const gl = this.beginPass(prog)
    this.setRaymarchUniforms(prog, w, h, this.previewSource())
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Build a RaymarchParams snapshot from the LIVE camera/state — what
  // setRaymarchUniforms used to read directly every call. Used as the
  // default when no snapshot is supplied, so the on-screen path's behavior
  // is unchanged byte-for-byte.
  private liveRaymarchParams(w: number, h: number): RaymarchParams {
    const preview = this.state.get('preview')
    const settings = this.state.get('settings')
    const { eye, forward, right, up } = this.camera.getMatrices()
    return {
      eye, forward, right, up,
      aspect: w / h,
      cutoff: settings.cutoff,
      contrast: settings.contrast,
      density: preview.density,
      stepCount: preview.stepCount,
      exposure: preview.exposure,
      showTilePreview: preview.showTilePreview,
      tilePreviewDensity: preview.tilePreviewDensity,
      colorRampEnabled: preview.colorRamp.enabled,
      colorRampTexture: this.lutTexture,
    }
  }

  // Freeze the render-time uniforms once at bake start (VFX-0 Task 5 fix):
  // camera basis (for the square offscreen target, not the live canvas
  // aspect) + the raymarch preview/shading fields + a dedicated LUT texture
  // built from the current colorRamp so a later live ramp edit can't mutate
  // frames already decided. showTilePreview is forced off — a flipbook frame
  // shouldn't show the 3x3x3 neighbor-tile preview. Ownership of the
  // returned colorRampTexture passes to FlipbookExporter.bake, which deletes
  // it when the bake finishes.
  snapshotRaymarchParams(): RaymarchParams {
    const preview = this.state.get('preview')
    const settings = this.state.get('settings')
    const { eye, forward, right, up } = this.camera.getMatrices()
    return {
      eye, forward, right, up,
      aspect: 1, // flipbook tiles are always square (tileRes x tileRes)
      cutoff: settings.cutoff,
      contrast: settings.contrast,
      density: preview.density,
      stepCount: preview.stepCount,
      exposure: preview.exposure,
      showTilePreview: false,
      tilePreviewDensity: preview.tilePreviewDensity,
      colorRampEnabled: preview.colorRamp.enabled,
      colorRampTexture: this.createLutTexture(preview.colorRamp),
    }
  }

  // Shared by the on-screen raymarch pass and renderRaymarchToTarget (Task 5
  // flipbook bake) — the exact camera/ramp/cutoff/contrast uniform setup,
  // parameterized on which volume to sample so the bake can pass its own
  // per-frame volume instead of previewSource(). `params`, when supplied,
  // overrides every live read (bake path); when omitted, behaves exactly as
  // before via liveRaymarchParams (on-screen path, unchanged).
  private setRaymarchUniforms(prog: CompiledProgram, w: number, h: number, vol: VolumeTexture, params?: RaymarchParams) {
    const { compiler } = this
    const p = params ?? this.liveRaymarchParams(w, h)
    const depthScale = vol.depth / vol.resolution

    compiler.setUniform(prog, 'u_cutoff', p.cutoff)
    compiler.setUniform(prog, 'u_contrast', p.contrast)
    compiler.setUniform(prog, 'u_cameraPos', p.eye[0], p.eye[1], p.eye[2])
    compiler.setUniform(prog, 'u_cameraForward', p.forward[0], p.forward[1], p.forward[2])
    compiler.setUniform(prog, 'u_cameraRight', p.right[0], p.right[1], p.right[2])
    compiler.setUniform(prog, 'u_cameraUp', p.up[0], p.up[1], p.up[2])
    compiler.setUniform(prog, 'u_volumeSize', 1, 1, depthScale)
    compiler.setUniform(prog, 'u_aspect', p.aspect)
    compiler.setUniform(prog, 'u_tanHalfFov', RAYMARCH_TAN_HALF_FOV)
    compiler.setUniform(prog, 'u_density', p.density)
    compiler.setUniformBool(prog, 'u_showTilePreview', p.showTilePreview)
    compiler.setUniform(prog, 'u_tilePreviewDensity', p.tilePreviewDensity)
    compiler.setUniformi(prog, 'u_stepCount', p.stepCount)
    compiler.setUniform(prog, 'u_exposure', p.exposure)
    compiler.setUniform(prog, 'u_lightDir', ...LIGHT_DIR)

    vol.bind(0)
    compiler.setUniformi(prog, 'u_volume', 0)
    this.bindColorRamp(prog, p.colorRampEnabled, p.colorRampTexture)
    this.bindSparseTestUniforms(prog)
  }

  // Render hook for FlipbookExporter (Task 5): paints the colored raymarch —
  // camera, ramp LUT, cutoff/contrast, same as the on-screen path — for an
  // arbitrary volume into an arbitrary offscreen framebuffer at w×h. `params`
  // (supplied by the bake) overrides the live camera/state reads with the
  // frozen snapshot; never called from the render loop, so on-screen
  // rendering (which never passes params) is untouched.
  renderRaymarchToTarget(fbo: WebGLFramebuffer, w: number, h: number, vol: VolumeTexture, params?: RaymarchParams): void {
    const { gl } = this.ctx
    const prog = this.compiler.buildRaymarchShader()
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)
    this.setRaymarchUniforms(prog, w, h, vol, params)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private renderSlicePlane(isProjection: boolean) {
    const { compiler } = this
    const prog = isProjection ? compiler.buildProjectionShader() : compiler.buildSliceShader()
    const gl = this.beginPass(prog)

    const preview = this.state.get('preview')
    const settings = this.state.get('settings')
    const vol = this.previewSource()
    const planeAspect = preview.sliceAxis === SliceAxis.Z ? 1 : vol.resolution / vol.depth
    const screenAspect = this.canvas.width / this.canvas.height

    compiler.setUniform(prog, 'u_cutoff', settings.cutoff)
    compiler.setUniform(prog, 'u_contrast', settings.contrast)
    compiler.setUniformi(prog, 'u_sliceAxis', AXIS_MAP[preview.sliceAxis])
    compiler.setUniform(prog, 'u_exposure', preview.exposure)
    compiler.setUniform(prog, 'u_planeAspect', planeAspect)
    compiler.setUniform(prog, 'u_screenAspect', screenAspect)

    if (isProjection) {
      const projMap: Record<ProjectionMode, number> = { average: 0, max: 1 }
      compiler.setUniformi(prog, 'u_projMode', projMap[preview.projectionMode])
      compiler.setUniformi(prog, 'u_steps', preview.stepCount)
    } else {
      compiler.setUniform(prog, 'u_slicePos', preview.slicePosition)
    }

    vol.bind(0)
    compiler.setUniformi(prog, 'u_volume', 0)
    this.bindColorRamp(prog, preview.colorRamp.enabled)
    this.bindSparseTestUniforms(prog)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private async handleExport(opts: ExportRequest) {
    if (this.exportInProgress) return

    this.exportInProgress = true
    try {
      if (opts.format === ExportFormat.Flipbook) {
        await this.runFlipbookExport(opts)
      } else {
        const { ExportManager } = await import('../../core/export/ExportManager')
        const settings = this.state.get('settings')
        const mgr = new ExportManager(this.ctx.gl, this.volume, settings.cutoff, settings.contrast)
        await mgr.export(opts.format, opts.filenameBase, opts.flipY)
      }
    } catch (error) {
      console.error('Export failed:', error)
      const message = describeViewportError(error)
      window.alert(`Export failed: ${message}`)
    } finally {
      this.exportInProgress = false
    }
  }

  // Rendered-flipbook export (Task 5): bakes the colored raymarch over the
  // animation loop using the FULL-res generator/volume path (never the drag
  // proxy) via a dedicated FlipbookExporter instance. Reuses the same
  // generating/progress state the normal full-res generation uses so the
  // top-bar progress indicator reflects bake progress too.
  private async runFlipbookExport(config: FlipbookConfig): Promise<void> {
    const { FlipbookExporter } = await import('../../core/export/FlipbookExporter')
    const exporter = new FlipbookExporter({
      gl: this.ctx.gl,
      compiler: this.compiler,
      renderToTarget: (fbo, w, h, vol, params) => this.renderRaymarchToTarget(fbo, w, h, vol, params),
    })

    const indicator = document.getElementById('gen-indicator')
    if (indicator) indicator.style.display = 'flex'
    this.state.update('generating', true)
    this.state.update('progress', 0)

    // Snapshot camera + render params ONCE, before the (chunked, awaited)
    // per-frame bake loop starts, so a mid-bake camera drag or Properties
    // tweak can't make frames within one sprite sheet inconsistent (VFX-0
    // Task 5 fix). `camera` (for the JSON sidecar) and the matrices baked
    // into renderParams both come from the same live state read here, with
    // no await between them, so they can't drift apart.
    const camera = this.state.get('camera')
    const renderParams = this.snapshotRaymarchParams()

    try {
      await exporter.bake(
        config,
        this.state.get('layers'),
        this.state.get('settings'),
        this.state.get('animation'),
        camera,
        renderParams,
        (p) => this.state.update('progress', p),
      )
    } finally {
      this.state.update('generating', false)
      this.state.update('progress', 1)
      if (indicator) indicator.style.display = 'none'
    }
  }

  cyclePreviewMode() {
    const state = this.state
    const cur = state.get('preview').mode
    const next = PREVIEW_MODE_ORDER[(PREVIEW_MODE_ORDER.indexOf(cur) + 1) % PREVIEW_MODE_ORDER.length]
    state.update('preview', { ...state.get('preview'), mode: next })
  }

  toggleTilePreview() {
    const preview = this.state.get('preview')
    this.state.update('preview', { ...preview, showTilePreview: !preview.showTilePreview })
  }

  focusCamera() {
    this.camera.reset()
  }

  // --- TEST HOOKS (VFX-1 Task 4 parity smoke) ---------------------------
  // Not used by any real UI path; exist only so a Playwright parity test can
  // drive the sparse brick cache deterministically. Remove/replace once T5
  // wires real sparse playback.

  // Kicks off the same sparse bake AnimationController normally only starts
  // on play-start. Fire-and-forget like the real method; poll `generating`
  // (state) or sparseCacheFrameCountForTest() to know when it settles.
  buildSparseCacheForTest(): void {
    this.animation.buildSparseCache()
  }

  // Regenerates `this.volume` at an EXPLICIT phase, bypassing the
  // state.animation.phase subscription (and both animation caches it can
  // snap to) entirely: driving phase through state.update('animation', ...)
  // would risk tryApplyCachedAnimationFrame silently serving a nearby frame
  // from the dense per-frame cache's OWN (different) frame grid — see
  // computeCacheFrameCount vs ANIM_LOOP_FRAMES_DEFAULT — instead of
  // regenerating the exact requested phase. This uses the same
  // generateFrameData path the sparse bake itself uses, so the dense
  // comparison frame is generated the same way the sparse cache's source
  // frame was.
  async regenerateDenseFrameForTest(phase: number): Promise<void> {
    const { state } = this
    const data = await this.generator.generateFrameData(
      state.get('layers'),
      this.volume.resolution,
      this.volume.depth,
      state.get('settings').globalSeed,
      phase,
      state.get('animation').evolutions,
    )
    this.volume.uploadVolume(data)
    this.animation.resetAppliedFrame()
  }

  // Number of frames currently baked into the sparse brick cache (0 until a
  // build finishes successfully).
  get sparseCacheFrameCountForTest(): number {
    return this.brickCache.frameCount
  }

  // When `frameIndex` is non-null, every subsequent render binds that
  // brickCache frame and flips u_sparseEnabled on for it instead of sampling
  // the normal dense volume; null restores the normal dense path.
  setSparseTestFrame(frameIndex: number | null): void {
    this.sparseTestFrame = frameIndex
  }

  // Binds the sparse uniforms for the current sparseTestFrame (if any) onto
  // `prog`; otherwise leaves u_sparseEnabled false so the dense path is
  // untouched. Shared by the raymarch and slice/projection render paths.
  private bindSparseTestUniforms(prog: CompiledProgram): void {
    const { compiler } = this
    const frameIndex = this.sparseTestFrame
    if (frameIndex === null || frameIndex >= this.brickCache.frameCount) {
      compiler.setUniformBool(prog, 'u_sparseEnabled', false)
      return
    }
    this.brickCache.bindForFrame(frameIndex, SPARSE_ATLAS_TEXTURE_UNIT, SPARSE_INDIRECTION_TEXTURE_UNIT)
    compiler.setUniformi(prog, 'u_atlas', SPARSE_ATLAS_TEXTURE_UNIT)
    compiler.setUniformi(prog, 'u_indirection', SPARSE_INDIRECTION_TEXTURE_UNIT)
    compiler.setUniform(prog, 'u_macroDims', ...this.brickCache.macroDims)
    compiler.setUniform(prog, 'u_atlasDimsBricks', ...this.brickCache.atlasDimsInBricks)
    compiler.setUniformBool(prog, 'u_sparseEnabled', true)
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    if (this.dirtyTimer !== null) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
    this.listeners.abort()
    this.resizeObserver.disconnect()
    this.unsubscribes.forEach(unsub => unsub())
    this.unsubscribes = []
    this.camera.destroy()
    this.generator.destroy()
    this.cacheGenerator.destroy()
    this.sparseCacheGenerator.destroy()
    this.brickCache.destroy()
    this.volume.destroy()
    this.proxyGenerator.destroy()
    this.proxyVolume.destroy()
    this.ctx.gl.deleteTexture(this.lutTexture)
    this.ctx.gl.deleteVertexArray(this.vao)
  }
}

function describeViewportError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error

  try {
    const json = JSON.stringify(error)
    if (json && json !== '{}') return json
  } catch {
    // ignore JSON conversion failures
  }

  return String(error)
}

