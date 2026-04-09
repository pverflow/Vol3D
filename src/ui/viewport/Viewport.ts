import { WebGLContext } from '../../core/renderer/WebGLContext'
import { ShaderCompiler } from '../../core/renderer/ShaderCompiler'
import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import { CameraController } from './CameraController'
import type { StateManager } from '../../state/StateManager'
import type { AnimationSettings, Resolution, SliceCount, VolumeSettings } from '../../types/index'
import { PreviewMode, SliceAxis, ProjectionMode } from '../../types/index'
import { defaultLayer, defaultState } from '../../state/AppState'

export class Viewport {
  readonly el: HTMLElement
  readonly canvas: HTMLCanvasElement
  private ctx: WebGLContext
  private compiler: ShaderCompiler
  private generator: VolumeGenerator
  private cacheGenerator: VolumeGenerator
  private volume: VolumeTexture
  private camera: CameraController
  private state: StateManager
  private rafId: number | null = null
  private vao: WebGLVertexArrayObject
  private dirtyTimer: number | null = null
  private lastAnimationTick = 0
  private lastAnimationState: AnimationSettings
  private animationCacheFrames: Uint8Array[] = []
  private animationCacheKey = ''
  private animationCacheBuildId = 0
  private animationCacheBuilding = false
  private currentCachedFrame = -1

  constructor(state: StateManager) {
    this.state = state

    this.el = document.createElement('div')
    this.el.className = 'viewport'

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'viewport-canvas'
    this.el.appendChild(this.canvas)

    // Overlay controls
    this.el.appendChild(this.buildOverlay())

    // WebGL setup
    this.ctx = new WebGLContext(this.canvas)
    const { gl } = this.ctx
    gl.getExtension('EXT_color_buffer_float')

    this.compiler = new ShaderCompiler(gl)

    const settings = state.get('settings')
    this.volume = new VolumeTexture(gl, settings.resolution as Resolution, settings.depth as SliceCount)
    this.generator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.cacheGenerator = new VolumeGenerator(gl, this.compiler, settings.resolution)
    this.lastAnimationState = { ...state.get('animation') }

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
      this.invalidateAnimationCache()
      this.scheduleGeneration()
    })
    state.subscribe('settings', () => {
      const s = state.get('settings')
      this.invalidateAnimationCache()
      this.camera.setVolumeDepth(s.resolution, s.depth)
      if (s.resolution !== this.volume.resolution || s.depth !== this.volume.depth) {
        this.resizeVolume(s)
      }
      this.scheduleGeneration()
    })
    state.subscribe('preview', () => { /* just re-render */ })
    state.subscribe('animation', (anim) => this.handleAnimationChange(anim as AnimationSettings))
    state.subscribe('camera', (cam) => {
      this.camera.updateCamera(cam as typeof cam)
    })

    // Export handler
    window.addEventListener('vol3d-export', (e: Event) => {
      const detail = (e as CustomEvent).detail
      this.handleExport(detail)
    })

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => this.handleKey(e))

    this.startRenderLoop()
    this.scheduleGeneration()
  }

  private buildOverlay(): HTMLElement {
    const overlay = document.createElement('div')
    overlay.className = 'viewport-overlay'
    const defaults = defaultState().preview

    // Preview mode buttons
    const modeGroup = document.createElement('div')
    modeGroup.className = 'seg-group'
    const modeButtons = new Map<PreviewMode, HTMLButtonElement>()
    const modes: [PreviewMode, string][] = [
      [PreviewMode.Raymarched, '☁ Vol'],
      [PreviewMode.Slice, '⬛ Slice'],
      [PreviewMode.Projection, '⬤ Proj'],
    ]
    for (const [mode, label] of modes) {
      const btn = document.createElement('button')
      btn.className = 'seg-btn' + (this.state.get('preview').mode === mode ? ' active' : '')
      btn.textContent = label
      btn.addEventListener('click', () => {
        this.state.update('preview', { ...this.state.get('preview'), mode })
      })
      modeButtons.set(mode, btn)
      modeGroup.appendChild(btn)
    }
    overlay.appendChild(modeGroup)

    const projModeGroup = document.createElement('div')
    projModeGroup.className = 'seg-group'
    const projectionButtons = new Map<ProjectionMode, HTMLButtonElement>()
    const projModes: [ProjectionMode, string, string][] = [
      [ProjectionMode.Max, 'Max', 'Maximum density projection: shows the strongest value along the axis'],
      [ProjectionMode.Average, 'Avg', 'Average density projection: shows the mean value through the volume'],
    ]
    for (const [mode, label, title] of projModes) {
      const btn = document.createElement('button')
      btn.className = 'seg-btn sm' + (this.state.get('preview').projectionMode === mode ? ' active' : '')
      btn.textContent = label
      btn.title = title
      btn.addEventListener('click', () => {
        this.state.update('preview', { ...this.state.get('preview'), projectionMode: mode })
      })
      projectionButtons.set(mode, btn)
      projModeGroup.appendChild(btn)
    }
    overlay.appendChild(projModeGroup)

    // Slice controls (shown only in slice/projection mode)
    const sliceControls = document.createElement('div')
    sliceControls.className = 'slice-controls'

    const axisGroup = document.createElement('div')
    axisGroup.className = 'seg-group'
    const axisButtons = new Map<SliceAxis, HTMLButtonElement>()
    for (const axis of [SliceAxis.X, SliceAxis.Y, SliceAxis.Z]) {
      const btn = document.createElement('button')
      btn.className = 'seg-btn sm' + (this.state.get('preview').sliceAxis === axis ? ' active' : '')
      btn.textContent = axis.toUpperCase()
      btn.addEventListener('click', () => {
        this.state.update('preview', { ...this.state.get('preview'), sliceAxis: axis })
      })
      axisButtons.set(axis, btn)
      axisGroup.appendChild(btn)
    }
    sliceControls.appendChild(axisGroup)

    const posSlider = document.createElement('input')
    posSlider.type = 'range'
    posSlider.className = 'slice-pos-slider'
    posSlider.id = 'preview-slice-position'
    posSlider.name = 'preview-slice-position'
    posSlider.min = '0'
    posSlider.max = '100'
    posSlider.value = String(this.state.get('preview').slicePosition * 100)
    posSlider.addEventListener('input', () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        slicePosition: parseInt(posSlider.value) / 100
      })
    })
    attachRangeReset(posSlider, defaults.slicePosition * 100, () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        slicePosition: defaults.slicePosition
      })
    })
    sliceControls.appendChild(posSlider)
    overlay.appendChild(sliceControls)

    const previewControls = document.createElement('div')
    previewControls.className = 'raymarch-controls'

    const densitySlider = document.createElement('input')
    densitySlider.type = 'range'
    densitySlider.className = 'mini-slider'
    densitySlider.id = 'preview-density'
    densitySlider.name = 'preview-density'
    densitySlider.min = '0'
    densitySlider.max = '300'
    densitySlider.value = String(this.state.get('preview').density * 100)
    densitySlider.title = 'Density'
    densitySlider.addEventListener('input', () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        density: parseInt(densitySlider.value) / 100
      })
    })
    attachRangeReset(densitySlider, defaults.density * 100, () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        density: defaults.density
      })
    })
    const densityLabel = document.createElement('span')
    densityLabel.className = 'mini-label'
    densityLabel.textContent = 'Density'
    previewControls.appendChild(densityLabel)
    previewControls.appendChild(densitySlider)

    const stepSlider = document.createElement('input')
    stepSlider.type = 'range'
    stepSlider.className = 'mini-slider'
    stepSlider.min = '16'
    stepSlider.max = '256'
    stepSlider.step = '8'
    stepSlider.value = String(this.state.get('preview').stepCount)
    stepSlider.title = 'Raymarch steps'
    stepSlider.addEventListener('input', () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        stepCount: parseInt(stepSlider.value)
      })
    })
    attachRangeReset(stepSlider, defaults.stepCount, () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        stepCount: defaults.stepCount
      })
    })
    const stepLabel = document.createElement('span')
    stepLabel.className = 'mini-label'
    stepLabel.textContent = 'Steps'
    previewControls.appendChild(stepLabel)
    previewControls.appendChild(stepSlider)

    const tilePreviewDensitySlider = document.createElement('input')
    tilePreviewDensitySlider.type = 'range'
    tilePreviewDensitySlider.className = 'mini-slider'
    tilePreviewDensitySlider.min = '0'
    tilePreviewDensitySlider.max = '100'
    tilePreviewDensitySlider.value = String(this.state.get('preview').tilePreviewDensity * 100)
    tilePreviewDensitySlider.title = 'Neighbor cube density'
    tilePreviewDensitySlider.addEventListener('input', () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        tilePreviewDensity: parseInt(tilePreviewDensitySlider.value) / 100
      })
    })
    attachRangeReset(tilePreviewDensitySlider, defaults.tilePreviewDensity * 100, () => {
      this.state.update('preview', {
        ...this.state.get('preview'),
        tilePreviewDensity: defaults.tilePreviewDensity
      })
    })
    const tilePreviewDensityLabel = document.createElement('span')
    tilePreviewDensityLabel.className = 'mini-label'
    tilePreviewDensityLabel.textContent = 'Repeat α'
    previewControls.appendChild(tilePreviewDensityLabel)
    previewControls.appendChild(tilePreviewDensitySlider)

    overlay.appendChild(previewControls)

    const syncOverlay = () => {
      const preview = this.state.get('preview')
      modeButtons.forEach((btn, mode) => btn.classList.toggle('active', preview.mode === mode))
      projectionButtons.forEach((btn, mode) => btn.classList.toggle('active', preview.projectionMode === mode))
      axisButtons.forEach((btn, axis) => btn.classList.toggle('active', preview.sliceAxis === axis))

      posSlider.value = String(Math.round(preview.slicePosition * 100))
      densitySlider.value = String(Math.round(preview.density * 100))
      stepSlider.value = String(preview.stepCount)
      tilePreviewDensitySlider.value = String(Math.round(preview.tilePreviewDensity * 100))

      sliceControls.style.display = preview.mode === PreviewMode.Slice || preview.mode === PreviewMode.Projection ? 'flex' : 'none'
      previewControls.style.display = preview.mode === PreviewMode.Raymarched || preview.mode === PreviewMode.Projection ? 'flex' : 'none'
      projModeGroup.style.display = preview.mode === PreviewMode.Projection ? 'flex' : 'none'

      const showDensity = preview.mode === PreviewMode.Raymarched
      densityLabel.style.display = showDensity ? '' : 'none'
      densitySlider.style.display = showDensity ? '' : 'none'

      const showRepeatDensity = preview.mode === PreviewMode.Raymarched && preview.showTilePreview
      tilePreviewDensityLabel.style.display = showRepeatDensity ? '' : 'none'
      tilePreviewDensitySlider.style.display = showRepeatDensity ? '' : 'none'

      stepSlider.title = preview.mode === PreviewMode.Projection
        ? 'Projection sampling steps'
        : 'Volume raymarch steps'
    }

    this.state.subscribe('preview', syncOverlay)
    syncOverlay()

    // Generating indicator
    const genIndicator = document.createElement('div')
    genIndicator.className = 'gen-indicator'
    genIndicator.id = 'gen-indicator'
    genIndicator.style.display = 'none'
    genIndicator.innerHTML = `<span class="spin">⟳</span> Generating...`
    overlay.appendChild(genIndicator)

    return overlay
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
    this.currentCachedFrame = -1
  }

  scheduleGeneration() {
    if (this.dirtyTimer !== null) return
    this.dirtyTimer = window.setTimeout(() => {
      this.dirtyTimer = null
      this.runGeneration()
    }, 150)
  }

  private runGeneration() {
    const { state } = this
    this.currentCachedFrame = -1
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
        this.buildAnimationCacheIfNeeded()
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
    this.advanceAnimation(performance.now())

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

  private advanceAnimation(now: number) {
    const animation = this.state.get('animation')
    if (!animation.playing) {
      this.lastAnimationTick = now
      return
    }

    const cacheFrameCount = this.getAnimationCacheFrameCount()
    if (cacheFrameCount >= 2 && this.animationCacheFrames.length < cacheFrameCount) {
      this.buildAnimationCacheIfNeeded()
      this.lastAnimationTick = now
      return
    }

    if (this.lastAnimationTick === 0) {
      this.lastAnimationTick = now
      return
    }

    const minFrameMs = 100
    const elapsed = now - this.lastAnimationTick
    if (elapsed < minFrameMs) return

    const phaseDelta = elapsed / (animation.loopSeconds * 1000)
    const phase = (animation.phase + phaseDelta) % 1
    this.lastAnimationTick = now
    this.state.update('animation', { ...animation, phase })

    if (cacheFrameCount < 2) {
      this.scheduleGeneration()
    }
  }

  private handleAnimationChange(next: AnimationSettings) {
    const prev = this.lastAnimationState

    if (prev.evolutions !== next.evolutions) {
      this.invalidateAnimationCache()
      this.scheduleGeneration()
    } else if (prev.phase !== next.phase) {
      if (!this.tryApplyCachedAnimationFrame(next.phase) && !next.playing) {
        this.scheduleGeneration()
      }
    }

    if ((!prev.playing && next.playing) || prev.evolutions !== next.evolutions) {
      this.buildAnimationCacheIfNeeded()
    }

    if (prev.playing && !next.playing) {
      this.lastAnimationTick = 0
    }

    this.lastAnimationState = { ...next }
  }

  private invalidateAnimationCache() {
    this.animationCacheBuildId += 1
    this.animationCacheBuilding = false
    this.animationCacheFrames = []
    this.animationCacheKey = ''
    this.currentCachedFrame = -1
    this.cacheGenerator.cancel()
  }

  private getAnimationCacheKey(): string {
    const state = this.state.getState()
    return JSON.stringify({
      layers: state.layers,
      settings: state.settings,
      evolutions: state.animation.evolutions,
    })
  }

  private getAnimationCacheFrameCount(): number {
    const bytesPerFrame = this.volume.resolution * this.volume.resolution * this.volume.depth
    const maxFramesByBudget = Math.floor((96 * 1024 * 1024) / Math.max(bytesPerFrame, 1))
    return Math.min(24, Math.max(0, maxFramesByBudget))
  }

  private buildAnimationCacheIfNeeded() {
    const frameCount = this.getAnimationCacheFrameCount()
    if (frameCount < 2) {
      this.invalidateAnimationCache()
      return
    }

    const key = `${this.getAnimationCacheKey()}::${frameCount}`
    if (!this.animationCacheBuilding && this.animationCacheKey === key && this.animationCacheFrames.length === frameCount) {
      return
    }
    if (this.animationCacheBuilding && this.animationCacheKey === key) {
      return
    }

    this.animationCacheBuildId += 1
    const buildId = this.animationCacheBuildId
    this.animationCacheBuilding = true
    this.animationCacheKey = key
    this.animationCacheFrames = []
    this.currentCachedFrame = -1
    this.cacheGenerator.cancel()

    const { layers, settings, animation } = this.state.getState()

    void (async () => {
      try {
        for (let i = 0; i < frameCount; i++) {
          const phase = i / frameCount
          const frame = await this.cacheGenerator.generateFrameData(
            layers,
            settings.resolution,
            settings.depth,
            settings.globalSeed,
            settings.cutoff,
            settings.contrast,
            phase,
            animation.evolutions,
          )

          if (buildId !== this.animationCacheBuildId) return
          this.animationCacheFrames[i] = frame
        }

        if (buildId !== this.animationCacheBuildId) return
        this.animationCacheBuilding = false
        this.tryApplyCachedAnimationFrame(this.state.get('animation').phase)
      } finally {
        if (buildId === this.animationCacheBuildId) {
          this.animationCacheBuilding = false
        }
      }
    })()
  }

  private tryApplyCachedAnimationFrame(phase: number): boolean {
    const frameCount = this.animationCacheFrames.length
    if (frameCount < 2) return false

    const wrapped = ((phase % 1) + 1) % 1
    const index = Math.min(frameCount - 1, Math.floor(wrapped * frameCount))
    const frame = this.animationCacheFrames[index]
    if (!frame) return false

    if (this.currentCachedFrame !== index) {
      this.volume.uploadVolume(frame)
      this.currentCachedFrame = index
    }

    return true
  }

  private renderRaymarched(w: number, h: number) {
    const gl = this.ctx.gl
    const { compiler } = this
    const prog = compiler.buildRaymarchShader()
    gl.useProgram(prog.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const preview = this.state.get('preview')
    const depthScale = this.volume.depth / this.volume.resolution
    const { eye, forward, right, up } = this.camera.getMatrices(w, h)
    const aspect = w / h
    const tanHalfFov = Math.tan(Math.PI / 6)

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
    compiler.setUniform(prog, 'u_lightDir', 0.577, 0.577, 0.577)

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

  private async handleExport(opts: { format: string; filename: string; flipY: boolean }) {
    const { ExportManager } = await import('../../core/export/ExportManager')
    const mgr = new ExportManager(this.ctx.gl, this.volume)
    await mgr.export(opts.format as never, opts.filename, opts.flipY)
  }

  private handleKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    const state = this.state
    // Tab = cycle preview mode
    if (e.key === 'Tab') {
      e.preventDefault()
      const modes = [PreviewMode.Raymarched, PreviewMode.Slice, PreviewMode.Projection]
      const cur = state.get('preview').mode
      const next = modes[(modes.indexOf(cur) + 1) % modes.length]
      state.update('preview', { ...state.get('preview'), mode: next })
    }
    // T = toggle tile preview
    if (e.key === 't' || e.key === 'T') {
      const preview = state.get('preview')
      state.update('preview', { ...preview, showTilePreview: !preview.showTilePreview })
    }
    // F = focus/reset camera
    if (e.key === 'f' || e.key === 'F') {
      this.camera.reset()
    }
    // Delete = delete selected layer
    if (e.key === 'Delete') {
      const sel = state.get('selected')
      if (sel) state.removeLayer(sel)
    }
    // Ctrl+D = duplicate
    if (e.ctrlKey && e.key === 'd') {
      e.preventDefault()
      const sel = state.get('selected')
      if (sel) state.duplicateLayer(sel)
    }
    // Ctrl+Shift+N = add layer
    if (e.ctrlKey && e.shiftKey && e.key === 'N') {
      e.preventDefault()
      state.addLayer(defaultLayer())
    }
    // Ctrl+E = export
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('vol3d-show-export'))
    }
  }

  destroy() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.generator.destroy()
    this.cacheGenerator.destroy()
    this.volume.destroy()
  }
}

function attachRangeReset(input: HTMLInputElement, defaultValue: number, onReset: () => void) {
  input.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    input.value = String(defaultValue)
    onReset()
  })
}

