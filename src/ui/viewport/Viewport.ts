import { WebGLContext } from '../../core/renderer/WebGLContext'
import { ShaderCompiler } from '../../core/renderer/ShaderCompiler'
import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import { CameraController } from './CameraController'
import { AnimationController } from './AnimationController'
import { ViewportOverlay } from './ViewportOverlay'
import type { StateManager } from '../../state/StateManager'
import type { AnimationSettings, ExportConfig, Resolution, SliceCount, VolumeSettings } from '../../types/index'
import { PreviewMode, SliceAxis, ProjectionMode } from '../../types/index'
import { REGEN_DEBOUNCE_MS, RAYMARCH_TAN_HALF_FOV, LIGHT_DIR } from '../../core/constants'

export class Viewport {
  readonly el: HTMLElement
  readonly canvas: HTMLCanvasElement
  private ctx: WebGLContext
  private compiler: ShaderCompiler
  private generator: VolumeGenerator
  private cacheGenerator: VolumeGenerator
  private volume: VolumeTexture
  private camera: CameraController
  private animation: AnimationController
  private overlay: ViewportOverlay
  private state: StateManager
  private rafId: number | null = null
  private vao: WebGLVertexArrayObject
  private dirtyTimer: number | null = null
  private exportInProgress = false

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
    this.volume = new VolumeTexture(gl, settings.resolution as Resolution, settings.depth as SliceCount)
    this.generator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.cacheGenerator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.animation = new AnimationController({
      state,
      cacheGenerator: this.cacheGenerator,
      getVolume: () => this.volume,
      onNeedsGeneration: () => this.scheduleGeneration(),
    })

    this.camera = new CameraController(this.canvas, state.get('camera'), (cam) => {
      state.update('camera', cam)
    })
    this.camera.setVolumeDepth(settings.resolution, settings.depth)

    this.vao = gl.createVertexArray()!

    // Resize observer
    const ro = new ResizeObserver(() => this.handleResize())
    ro.observe(this.el)

    // State subscriptions
    state.subscribe('layers', () => {
      this.animation.invalidateAnimationCache()
      this.scheduleGeneration()
    })
    state.subscribe('settings', () => {
      const s = state.get('settings')
      this.animation.invalidateAnimationCache()
      this.camera.setVolumeDepth(s.resolution, s.depth)
      if (s.resolution !== this.volume.resolution || s.depth !== this.volume.depth) {
        this.resizeVolume(s)
      }
      this.scheduleGeneration()
    })
    state.subscribe('preview', () => { /* just re-render */ })
    state.subscribe('animation', (anim) => this.animation.handleAnimationChange(anim as AnimationSettings))
    state.subscribe('camera', (cam) => {
      this.camera.updateCamera(cam as typeof cam)
    })

    // Export handler
    window.addEventListener('vol3d-export', (e: Event) => {
      const detail = (e as CustomEvent<ExportConfig>).detail
      this.handleExport(detail)
    })

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
    this.animation.invalidateAnimationCache()
  }

  scheduleGeneration() {
    if (this.dirtyTimer !== null) return
    this.dirtyTimer = window.setTimeout(() => {
      this.dirtyTimer = null
      this.runGeneration()
    }, REGEN_DEBOUNCE_MS)
  }

  private runGeneration() {
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
      state.get('settings').cutoff,
      state.get('settings').contrast,
      state.get('animation').phase,
      state.get('animation').evolutions,
      (p) => state.update('progress', p),
      () => {
        state.update('generating', false)
        state.update('progress', 1)
        if (indicator) indicator.style.display = 'none'
        this.animation.buildAnimationCacheIfNeeded()
      }
    )
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

    switch (preview.mode) {
      case PreviewMode.Raymarched:
        this.renderRaymarched(w, h)
        break
      case PreviewMode.Slice:
        this.renderSlice()
        break
      case PreviewMode.Projection:
        this.renderProjection()
        break
    }

    gl.bindVertexArray(null)
  }

  private renderRaymarched(w: number, h: number) {
    const gl = this.ctx.gl
    const { compiler } = this
    const prog = compiler.buildRaymarchShader()
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const preview = this.state.get('preview')
    const depthScale = this.volume.depth / this.volume.resolution
    const { eye, forward, right, up } = this.camera.getMatrices()
    const aspect = w / h
    const tanHalfFov = RAYMARCH_TAN_HALF_FOV

    compiler.setUniform(prog, 'u_cameraPos', eye[0], eye[1], eye[2])
    compiler.setUniform(prog, 'u_cameraForward', forward[0], forward[1], forward[2])
    compiler.setUniform(prog, 'u_cameraRight', right[0], right[1], right[2])
    compiler.setUniform(prog, 'u_cameraUp', up[0], up[1], up[2])
    compiler.setUniform(prog, 'u_volumeSize', 1, 1, depthScale)
    compiler.setUniform(prog, 'u_aspect', aspect)
    compiler.setUniform(prog, 'u_tanHalfFov', tanHalfFov)
    compiler.setUniform(prog, 'u_density', preview.density)
    compiler.setUniformBool(prog, 'u_showTilePreview', preview.showTilePreview)
    compiler.setUniform(prog, 'u_tilePreviewDensity', preview.tilePreviewDensity)
    compiler.setUniformi(prog, 'u_stepCount', preview.stepCount)
    compiler.setUniform(prog, 'u_exposure', preview.exposure)
    compiler.setUniform(prog, 'u_lightDir', ...LIGHT_DIR)

    this.volume.bind(0)
    compiler.setUniformi(prog, 'u_volume', 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private renderSlice() {
    const gl = this.ctx.gl
    const { compiler } = this
    const prog = compiler.buildSliceShader()
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const preview = this.state.get('preview')
    const axisMap: Record<SliceAxis, number> = { x: 0, y: 1, z: 2 }
    const planeAspect = preview.sliceAxis === SliceAxis.Z ? 1 : this.volume.resolution / this.volume.depth
    const screenAspect = this.canvas.width / this.canvas.height

    compiler.setUniformi(prog, 'u_sliceAxis', axisMap[preview.sliceAxis])
    compiler.setUniform(prog, 'u_slicePos', preview.slicePosition)
    compiler.setUniform(prog, 'u_exposure', preview.exposure)
    compiler.setUniform(prog, 'u_planeAspect', planeAspect)
    compiler.setUniform(prog, 'u_screenAspect', screenAspect)

    this.volume.bind(0)
    compiler.setUniformi(prog, 'u_volume', 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private renderProjection() {
    const gl = this.ctx.gl
    const { compiler } = this
    const prog = compiler.buildProjectionShader()
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const preview = this.state.get('preview')
    const axisMap: Record<SliceAxis, number> = { x: 0, y: 1, z: 2 }
    const projMap: Record<ProjectionMode, number> = { average: 0, max: 1 }
    const planeAspect = preview.sliceAxis === SliceAxis.Z ? 1 : this.volume.resolution / this.volume.depth
    const screenAspect = this.canvas.width / this.canvas.height

    compiler.setUniformi(prog, 'u_sliceAxis', axisMap[preview.sliceAxis])
    compiler.setUniformi(prog, 'u_projMode', projMap[preview.projectionMode])
    compiler.setUniform(prog, 'u_exposure', preview.exposure)
    compiler.setUniformi(prog, 'u_steps', preview.stepCount)
    compiler.setUniform(prog, 'u_planeAspect', planeAspect)
    compiler.setUniform(prog, 'u_screenAspect', screenAspect)

    this.volume.bind(0)
    compiler.setUniformi(prog, 'u_volume', 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private async handleExport(opts: ExportConfig) {
    if (this.exportInProgress) return

    this.exportInProgress = true
    try {
      const { ExportManager } = await import('../../core/export/ExportManager')
      const mgr = new ExportManager(this.ctx.gl, this.volume)
      await mgr.export(opts.format, opts.filenameBase, opts.flipY)
    } catch (error) {
      console.error('Export failed:', error)
      const message = describeViewportError(error)
      window.alert(`Export failed: ${message}`)
    } finally {
      this.exportInProgress = false
    }
  }

  cyclePreviewMode() {
    const state = this.state
    const modes = [PreviewMode.Raymarched, PreviewMode.Slice, PreviewMode.Projection]
    const cur = state.get('preview').mode
    const next = modes[(modes.indexOf(cur) + 1) % modes.length]
    state.update('preview', { ...state.get('preview'), mode: next })
  }

  toggleTilePreview() {
    const preview = this.state.get('preview')
    this.state.update('preview', { ...preview, showTilePreview: !preview.showTilePreview })
  }

  focusCamera() {
    this.camera.reset()
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.generator.destroy()
    this.cacheGenerator.destroy()
    this.volume.destroy()
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

