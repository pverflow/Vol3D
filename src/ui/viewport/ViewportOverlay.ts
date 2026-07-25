import type { StateManager } from '../../state/StateManager'
import { PreviewMode, SliceAxis, ProjectionMode } from '../../types/index'
import { defaultState } from '../../state/AppState'
import { Slider } from '../components/Slider'
import { Toggle } from '../components/Toggle'
import { Select } from '../components/Select'
import { RAMP_PRESETS } from '../../core/colorRamp'

export class ViewportOverlay {
  readonly el: HTMLElement

  constructor(state: StateManager) {
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
      btn.className = 'seg-btn' + (state.get('preview').mode === mode ? ' active' : '')
      btn.textContent = label
      btn.addEventListener('click', () => {
        state.update('preview', { ...state.get('preview'), mode })
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
      btn.className = 'seg-btn sm' + (state.get('preview').projectionMode === mode ? ' active' : '')
      btn.textContent = label
      btn.title = title
      btn.addEventListener('click', () => {
        state.update('preview', { ...state.get('preview'), projectionMode: mode })
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
      btn.className = 'seg-btn sm' + (state.get('preview').sliceAxis === axis ? ' active' : '')
      btn.textContent = axis.toUpperCase()
      btn.addEventListener('click', () => {
        state.update('preview', { ...state.get('preview'), sliceAxis: axis })
      })
      axisButtons.set(axis, btn)
      axisGroup.appendChild(btn)
    }
    sliceControls.appendChild(axisGroup)

    const posSlider = new Slider({
      label: '',
      min: 0,
      max: 1,
      step: 0.01,
      value: state.get('preview').slicePosition,
      defaultValue: defaults.slicePosition,
      decimals: 2,
      onInput: (v) => {
        state.update('preview', { ...state.get('preview'), slicePosition: v })
      },
    })
    sliceControls.appendChild(posSlider.el)
    overlay.appendChild(sliceControls)

    const previewControls = document.createElement('div')
    previewControls.className = 'raymarch-controls'

    const densitySlider = new Slider({
      label: 'Density',
      min: 0,
      max: 3,
      step: 0.01,
      value: state.get('preview').density,
      defaultValue: defaults.density,
      decimals: 2,
      onInput: (v) => {
        state.update('preview', { ...state.get('preview'), density: v })
      },
    })
    previewControls.appendChild(densitySlider.el)

    const stepSlider = new Slider({
      label: 'Steps',
      min: 16,
      max: 256,
      step: 8,
      value: state.get('preview').stepCount,
      defaultValue: defaults.stepCount,
      decimals: 0,
      onInput: (v) => {
        state.update('preview', { ...state.get('preview'), stepCount: v })
      },
    })
    previewControls.appendChild(stepSlider.el)

    const tilePreviewDensitySlider = new Slider({
      label: 'Repeat α',
      min: 0,
      max: 1,
      step: 0.01,
      value: state.get('preview').tilePreviewDensity,
      defaultValue: defaults.tilePreviewDensity,
      decimals: 2,
      onInput: (v) => {
        state.update('preview', { ...state.get('preview'), tilePreviewDensity: v })
      },
    })
    previewControls.appendChild(tilePreviewDensitySlider.el)

    overlay.appendChild(previewControls)

    // Color ramp (VFX-0 Task 3): minimal enable toggle + preset picker so
    // the ramp is actually reachable before Task 4's full gradient editor.
    const rampControls = document.createElement('div')
    rampControls.className = 'raymarch-controls'

    const rampToggle = new Toggle('Color Ramp', state.get('preview').colorRamp.enabled, (v) => {
      const preview = state.get('preview')
      state.update('preview', { ...preview, colorRamp: { ...preview.colorRamp, enabled: v } })
    })
    rampControls.appendChild(rampToggle.el)

    const rampPresetSelect = new Select(
      [
        { value: 'fire', label: 'Fire' },
        { value: 'smoke', label: 'Smoke' },
        { value: 'explosion', label: 'Explosion' },
      ],
      'fire',
      (v) => {
        const preview = state.get('preview')
        const preset = RAMP_PRESETS[v as keyof typeof RAMP_PRESETS]
        state.update('preview', { ...preview, colorRamp: { ...preview.colorRamp, stops: preset } })
      }
    )
    rampControls.appendChild(rampPresetSelect.el)

    overlay.appendChild(rampControls)

    const syncOverlay = () => {
      const preview = state.get('preview')
      modeButtons.forEach((btn, mode) => btn.classList.toggle('active', preview.mode === mode))
      projectionButtons.forEach((btn, mode) => btn.classList.toggle('active', preview.projectionMode === mode))
      axisButtons.forEach((btn, axis) => btn.classList.toggle('active', preview.sliceAxis === axis))

      posSlider.setValueSilent(preview.slicePosition)
      densitySlider.setValueSilent(preview.density)
      stepSlider.setValueSilent(preview.stepCount)
      tilePreviewDensitySlider.setValueSilent(preview.tilePreviewDensity)
      rampToggle.setValue(preview.colorRamp.enabled)

      sliceControls.style.display = preview.mode === PreviewMode.Slice || preview.mode === PreviewMode.Projection ? 'flex' : 'none'
      previewControls.style.display = preview.mode === PreviewMode.Raymarched || preview.mode === PreviewMode.Projection ? 'flex' : 'none'
      projModeGroup.style.display = preview.mode === PreviewMode.Projection ? 'flex' : 'none'

      const showDensity = preview.mode === PreviewMode.Raymarched
      densitySlider.el.style.display = showDensity ? '' : 'none'

      const showRepeatDensity = preview.mode === PreviewMode.Raymarched && preview.showTilePreview
      tilePreviewDensitySlider.el.style.display = showRepeatDensity ? '' : 'none'

      stepSlider.el.title = preview.mode === PreviewMode.Projection
        ? 'Projection sampling steps'
        : 'Volume raymarch steps'
    }

    state.subscribe('preview', syncOverlay)
    syncOverlay()

    // Generating indicator
    const genIndicator = document.createElement('div')
    genIndicator.className = 'gen-indicator'
    genIndicator.id = 'gen-indicator'
    genIndicator.style.display = 'none'
    genIndicator.innerHTML = `<span class="spin">⟳</span> Generating...`
    overlay.appendChild(genIndicator)

    this.el = overlay
  }
}
