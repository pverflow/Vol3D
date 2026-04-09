import type { StateManager } from '../../state/StateManager'
import type { PresetManager } from '../../state/PresetManager'
import type { Resolution, SliceCount } from '../../types/index'
import { BUILTIN_PRESETS } from '../../state/PresetManager'
import { defaultState } from '../../state/AppState'
import { Select } from '../components/Select'
import { Toggle } from '../components/Toggle'

export class TopBar {
  readonly el: HTMLElement
  private progressBar!: HTMLElement
  private progressFill!: HTMLElement
  private dragModeBtn!: HTMLButtonElement
  private resolutionButtons = new Map<Resolution, HTMLButtonElement>()
  private depthSelect!: Select
  private customSlicesToggle!: Toggle
  private tilePreviewBtn!: HTMLButtonElement
  private seedInput!: HTMLInputElement
  private cutoffInput!: HTMLInputElement
  private contrastInput!: HTMLInputElement
  private animPlayBtn!: HTMLButtonElement
  private animPhaseInput!: HTMLInputElement
  private animLoopInput!: HTMLInputElement
  private animEvolutionInput!: HTMLInputElement

  constructor(state: StateManager, presets: PresetManager) {
    this.el = this.build(state, presets)
    state.subscribe('generating', (v) => this.setGenerating(v as boolean))
    state.subscribe('progress', (v) => this.setProgress(v as number))
    state.subscribe('camera', () => this.syncCameraMode(state))
    state.subscribe('settings', () => this.syncSettings(state))
    state.subscribe('preview', () => this.syncPreview(state))
    state.subscribe('animation', () => this.syncAnimation(state))
    window.addEventListener('vol3d-show-export', () => this.showExportModal(state))
  }

  private build(state: StateManager, presets: PresetManager): HTMLElement {
    const el = document.createElement('div')
    el.className = 'top-bar'

    // Logo
    const logo = document.createElement('div')
    logo.className = 'top-logo'
    logo.innerHTML = `<span class="logo-icon">◈</span><span class="logo-text">Vol<span class="logo-accent">3D</span></span>`
    el.appendChild(logo)

    // Resolution selector
    const resGroup = document.createElement('div')
    resGroup.className = 'seg-group'
    const resolutions: Resolution[] = [32, 64, 128, 256, 512]
    for (const res of resolutions) {
      const btn = document.createElement('button')
      btn.className = 'seg-btn' + (state.get('settings').resolution === res ? ' active' : '')
      btn.textContent = `${res}³`
      btn.title = `${res}×${res}×${res} volume`
      btn.addEventListener('click', () => {
        state.update('settings', { ...state.get('settings'), resolution: res })
      })
      this.resolutionButtons.set(res, btn)
      resGroup.appendChild(btn)
    }
    el.appendChild(resGroup)

    this.customSlicesToggle = new Toggle('Custom Slices', state.get('settings').customSliceCount, (enabled) => {
      const settings = state.get('settings')
      state.update('settings', {
        ...settings,
        customSliceCount: enabled,
        depth: enabled ? settings.depth : settings.resolution as SliceCount,
      })
    })
    el.appendChild(this.customSlicesToggle.el)

    const depthWrap = document.createElement('div')
    depthWrap.className = 'top-field'
    const depthLabel = document.createElement('span')
    depthLabel.className = 'top-label'
    depthLabel.textContent = 'Slices'
    const depthOptions: SliceCount[] = [16, 32, 64, 128, 256, 512]
    this.depthSelect = new Select(
      depthOptions.map(v => ({ value: String(v), label: String(v) })),
      String(state.get('settings').depth),
      (v) => {
        state.update('settings', { ...state.get('settings'), depth: parseInt(v) as SliceCount })
      }
    )
    depthWrap.appendChild(depthLabel)
    depthWrap.appendChild(this.depthSelect.el)
    el.appendChild(depthWrap)

    this.tilePreviewBtn = document.createElement('button')
    this.tilePreviewBtn.className = 'top-btn' + (state.get('preview').showTilePreview ? ' active' : '')
    this.tilePreviewBtn.title = 'Toggle 3×3×3 tile preview (T)'
    this.tilePreviewBtn.textContent = 'Tile Preview'
    this.tilePreviewBtn.addEventListener('click', () => {
      const preview = state.get('preview')
      state.update('preview', { ...preview, showTilePreview: !preview.showTilePreview })
    })
    el.appendChild(this.tilePreviewBtn)

    this.dragModeBtn = document.createElement('button')
    this.dragModeBtn.className = 'top-btn'
    this.dragModeBtn.title = 'Toggle camera drag mode'
    this.dragModeBtn.addEventListener('click', () => {
      const camera = state.get('camera')
      const dragMode = camera.dragMode === 'grab' ? 'orbit' : 'grab'
      state.update('camera', { ...camera, dragMode })
    })
    this.syncCameraMode(state)
    el.appendChild(this.dragModeBtn)

    // Global seed
    const seedWrap = document.createElement('div')
    seedWrap.className = 'top-field'
    const seedLabel = document.createElement('span')
    seedLabel.className = 'top-label'
    seedLabel.textContent = 'Global Seed'
    this.seedInput = document.createElement('input')
    this.seedInput.type = 'number'
    this.seedInput.className = 'top-input'
    this.seedInput.id = 'global-seed'
    this.seedInput.name = 'global-seed'
    this.seedInput.value = String(state.get('settings').globalSeed)
    this.seedInput.min = '0'
    this.seedInput.max = '9999'
    this.seedInput.addEventListener('change', () => {
      const v = parseInt(this.seedInput.value) || 0
      state.update('settings', { ...state.get('settings'), globalSeed: v })
    })
    attachNumberReset(this.seedInput, defaultState().settings.globalSeed, (v) => {
      state.update('settings', { ...state.get('settings'), globalSeed: v })
    })
    const randomSeedBtn = document.createElement('button')
    randomSeedBtn.className = 'btn-icon'
    randomSeedBtn.title = 'Random global seed'
    randomSeedBtn.textContent = '⟳'
    randomSeedBtn.addEventListener('click', () => {
      const v = Math.floor(Math.random() * 9999)
      this.seedInput.value = String(v)
      state.update('settings', { ...state.get('settings'), globalSeed: v })
    })
    seedWrap.appendChild(seedLabel)
    seedWrap.appendChild(this.seedInput)
    seedWrap.appendChild(randomSeedBtn)
    el.appendChild(seedWrap)

    const cutoffWrap = document.createElement('div')
    cutoffWrap.className = 'top-field'
    const cutoffLabel = document.createElement('span')
    cutoffLabel.className = 'top-label'
    cutoffLabel.textContent = 'Cutoff'
    this.cutoffInput = document.createElement('input')
    this.cutoffInput.type = 'number'
    this.cutoffInput.className = 'top-input'
    this.cutoffInput.value = String(state.get('settings').cutoff)
    this.cutoffInput.min = '0'
    this.cutoffInput.max = '0.99'
    this.cutoffInput.step = '0.01'
    this.cutoffInput.title = 'Carves away low-density values before the volume is stored and exported'
    this.cutoffInput.addEventListener('change', () => {
      const next = Math.max(0, Math.min(0.99, parseFloat(this.cutoffInput.value) || 0))
      state.update('settings', { ...state.get('settings'), cutoff: next })
    })
    attachNumberReset(this.cutoffInput, defaultState().settings.cutoff, (v) => {
      state.update('settings', { ...state.get('settings'), cutoff: Math.max(0, Math.min(0.99, v)) })
    })
    cutoffWrap.appendChild(cutoffLabel)
    cutoffWrap.appendChild(this.cutoffInput)
    el.appendChild(cutoffWrap)

    const contrastWrap = document.createElement('div')
    contrastWrap.className = 'top-field'
    const contrastLabel = document.createElement('span')
    contrastLabel.className = 'top-label'
    contrastLabel.textContent = 'Contrast'
    this.contrastInput = document.createElement('input')
    this.contrastInput.type = 'number'
    this.contrastInput.className = 'top-input'
    this.contrastInput.value = String(state.get('settings').contrast)
    this.contrastInput.min = '0.1'
    this.contrastInput.max = '4'
    this.contrastInput.step = '0.1'
    this.contrastInput.title = 'Expands or softens the stored volume values after cutoff and affects preview plus export'
    this.contrastInput.addEventListener('change', () => {
      const next = Math.max(0.1, Math.min(4, parseFloat(this.contrastInput.value) || 1))
      state.update('settings', { ...state.get('settings'), contrast: next })
    })
    attachNumberReset(this.contrastInput, defaultState().settings.contrast, (v) => {
      state.update('settings', { ...state.get('settings'), contrast: Math.max(0.1, Math.min(4, v)) })
    })
    contrastWrap.appendChild(contrastLabel)
    contrastWrap.appendChild(this.contrastInput)
    el.appendChild(contrastWrap)

    this.animPlayBtn = document.createElement('button')
    this.animPlayBtn.className = 'top-btn'
    this.animPlayBtn.title = 'Play or pause looping volume animation preview'
    this.animPlayBtn.addEventListener('click', () => {
      const animation = state.get('animation')
      state.update('animation', { ...animation, playing: !animation.playing })
    })
    el.appendChild(this.animPlayBtn)

    const animTimeWrap = document.createElement('div')
    animTimeWrap.className = 'top-field'
    const animTimeLabel = document.createElement('span')
    animTimeLabel.className = 'top-label'
    animTimeLabel.textContent = 'Time'
    this.animPhaseInput = document.createElement('input')
    this.animPhaseInput.type = 'range'
    this.animPhaseInput.className = 'mini-slider'
    this.animPhaseInput.min = '0'
    this.animPhaseInput.max = '100'
    this.animPhaseInput.step = '1'
    this.animPhaseInput.value = '0'
    this.animPhaseInput.title = 'Loop position within the animation cycle'
    this.animPhaseInput.addEventListener('input', () => {
      const animation = state.get('animation')
      state.update('animation', {
        ...animation,
        phase: parseInt(this.animPhaseInput.value) / 100,
      })
    })
    attachRangeReset(this.animPhaseInput, 0, () => {
      const animation = state.get('animation')
      state.update('animation', { ...animation, phase: 0 })
    })
    animTimeWrap.appendChild(animTimeLabel)
    animTimeWrap.appendChild(this.animPhaseInput)
    el.appendChild(animTimeWrap)

    const animLoopWrap = document.createElement('div')
    animLoopWrap.className = 'top-field'
    const animLoopLabel = document.createElement('span')
    animLoopLabel.className = 'top-label'
    animLoopLabel.textContent = 'Loop s'
    this.animLoopInput = document.createElement('input')
    this.animLoopInput.type = 'number'
    this.animLoopInput.className = 'top-input'
    this.animLoopInput.min = '0.5'
    this.animLoopInput.max = '60'
    this.animLoopInput.step = '0.1'
    this.animLoopInput.title = 'Loop duration in seconds'
    this.animLoopInput.addEventListener('change', () => {
      const animation = state.get('animation')
      const next = Math.max(0.5, Math.min(60, parseFloat(this.animLoopInput.value) || defaultState().animation.loopSeconds))
      state.update('animation', { ...animation, loopSeconds: next })
    })
    attachNumberReset(this.animLoopInput, defaultState().animation.loopSeconds, (v) => {
      const animation = state.get('animation')
      state.update('animation', { ...animation, loopSeconds: v })
    })
    animLoopWrap.appendChild(animLoopLabel)
    animLoopWrap.appendChild(this.animLoopInput)
    el.appendChild(animLoopWrap)

    const animEvolutionWrap = document.createElement('div')
    animEvolutionWrap.className = 'top-field'
    const animEvolutionLabel = document.createElement('span')
    animEvolutionLabel.className = 'top-label'
    animEvolutionLabel.textContent = 'Evolutions'
    this.animEvolutionInput = document.createElement('input')
    this.animEvolutionInput.type = 'number'
    this.animEvolutionInput.className = 'top-input'
    this.animEvolutionInput.min = '0.1'
    this.animEvolutionInput.max = '16'
    this.animEvolutionInput.step = '0.1'
    this.animEvolutionInput.title = 'How many looping evolution cycles happen over one loop'
    this.animEvolutionInput.addEventListener('change', () => {
      const animation = state.get('animation')
      const next = Math.max(0.1, Math.min(16, parseFloat(this.animEvolutionInput.value) || defaultState().animation.evolutions))
      state.update('animation', { ...animation, evolutions: next })
    })
    attachNumberReset(this.animEvolutionInput, defaultState().animation.evolutions, (v) => {
      const animation = state.get('animation')
      state.update('animation', { ...animation, evolutions: v })
    })
    animEvolutionWrap.appendChild(animEvolutionLabel)
    animEvolutionWrap.appendChild(this.animEvolutionInput)
    el.appendChild(animEvolutionWrap)

    this.syncSettings(state)
    this.syncPreview(state)
    this.syncAnimation(state)

    // Spacer
    const spacer = document.createElement('div')
    spacer.style.flex = '1'
    el.appendChild(spacer)

    // Progress bar
    this.progressBar = document.createElement('div')
    this.progressBar.className = 'progress-bar'
    this.progressBar.style.display = 'none'
    this.progressFill = document.createElement('div')
    this.progressFill.className = 'progress-fill'
    this.progressBar.appendChild(this.progressFill)
    el.appendChild(this.progressBar)

    // Presets button
    const helpBtn = document.createElement('button')
    helpBtn.className = 'top-btn'
    helpBtn.textContent = '? Help'
    helpBtn.addEventListener('click', () => this.showHelpModal())
    el.appendChild(helpBtn)

    const presetsBtn = document.createElement('button')
    presetsBtn.className = 'top-btn'
    presetsBtn.textContent = '⊞ Presets'
    presetsBtn.addEventListener('click', () => this.showPresetsMenu(presetsBtn, state, presets))
    el.appendChild(presetsBtn)

    // Export button
    const exportBtn = document.createElement('button')
    exportBtn.className = 'top-btn accent'
    exportBtn.innerHTML = `↓ Export`
    exportBtn.addEventListener('click', () => this.showExportModal(state))
    el.appendChild(exportBtn)

    return el
  }

  private showPresetsMenu(anchor: HTMLElement, _state: StateManager, presets: PresetManager) {
    const popup = document.createElement('div')
    popup.className = 'preset-popup'

    const builtinHeader = document.createElement('div')
    builtinHeader.className = 'preset-group-label'
    builtinHeader.textContent = 'Built-in'
    popup.appendChild(builtinHeader)

    for (const preset of BUILTIN_PRESETS) {
      const btn = document.createElement('button')
      btn.className = 'preset-item'
      btn.textContent = preset.name
      btn.addEventListener('click', () => {
        presets.loadPreset(preset)
        popup.remove()
      })
      popup.appendChild(btn)
    }

    const userPresetList = presets.getUserPresets()
    if (userPresetList.length > 0) {
      const userHeader = document.createElement('div')
      userHeader.className = 'preset-group-label'
      userHeader.textContent = 'Saved'
      popup.appendChild(userHeader)
      for (const preset of userPresetList) {
        const row = document.createElement('div')
        row.className = 'preset-row'
        const btn = document.createElement('button')
        btn.className = 'preset-item'
        btn.textContent = preset.name
        btn.addEventListener('click', () => { presets.loadPreset(preset); popup.remove() })
        const del = document.createElement('button')
        del.className = 'preset-del'
        del.textContent = '×'
        del.addEventListener('click', () => { presets.deleteUserPreset(preset.name); popup.remove() })
        row.appendChild(btn)
        row.appendChild(del)
        popup.appendChild(row)
      }
    }

    const sep = document.createElement('div')
    sep.className = 'context-sep'
    popup.appendChild(sep)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'preset-item'
    saveBtn.textContent = '+ Save current as preset...'
    saveBtn.addEventListener('click', () => {
      const name = prompt('Preset name:')
      if (name?.trim()) { presets.saveUserPreset(name.trim()); popup.remove() }
    })
    popup.appendChild(saveBtn)

    const importBtn = document.createElement('button')
    importBtn.className = 'preset-item'
    importBtn.textContent = '↑ Import from file...'
    importBtn.addEventListener('click', () => {
      void presets.importPreset()
        .catch((err) => console.error('Failed to import preset:', err))
        .finally(() => popup.remove())
    })
    popup.appendChild(importBtn)

    const exportFileBtn = document.createElement('button')
    exportFileBtn.className = 'preset-item'
    exportFileBtn.textContent = '↓ Export to file...'
    exportFileBtn.addEventListener('click', () => {
      void presets.exportPreset()
        .catch((err) => console.error('Failed to export preset:', err))
        .finally(() => popup.remove())
    })
    popup.appendChild(exportFileBtn)

    document.body.appendChild(popup)
    const rect = anchor.getBoundingClientRect()
    popup.style.right = `${window.innerWidth - rect.right}px`
    popup.style.top = `${rect.bottom + 4}px`

    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('mousedown', close) }
      }
      document.addEventListener('mousedown', close)
    }, 10)
  }

  private showExportModal(state: StateManager) {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'modal'

    modal.innerHTML = `
      <div class="modal-header">
        <h2>Export Volume</h2>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="prop-row">
          <span class="prop-label">Format</span>
          <select class="ui-select" id="exp-format" name="exp-format">
            <option value="png_sequence">PNG Sequence (ZIP)</option>
            <option value="sprite_sheet">Sprite Sheet (PNG)</option>
            <option value="raw_r8">Raw R8 (grayscale bytes)</option>
            <option value="raw_rgba8">Raw RGBA8</option>
            <option value="raw_r32f">Raw R32F (float)</option>
          </select>
        </div>
        <div class="prop-row">
          <span class="prop-label">Filename</span>
          <input type="text" class="top-input" id="exp-name" name="exp-name" value="noise_volume" style="flex:1">
        </div>
        <div class="prop-row">
          <label class="ui-toggle" style="margin:0">
            <input type="checkbox" id="exp-flipy" name="exp-flipy">
            <span class="toggle-track"><span class="toggle-knob"></span></span>
            <span class="toggle-label">Flip Y</span>
          </label>
        </div>
        <div class="modal-info">
          Resolution: <strong id="exp-res">${state.get('settings').resolution}×${state.get('settings').resolution}×${state.get('settings').depth}</strong>
          voxels
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary modal-cancel">Cancel</button>
        <button class="top-btn accent modal-export">Export</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.remove())
    overlay.querySelector('.modal-cancel')?.addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

    overlay.querySelector('.modal-export')?.addEventListener('click', () => {
      const format = (overlay.querySelector('#exp-format') as HTMLSelectElement).value
      const filename = (overlay.querySelector('#exp-name') as HTMLInputElement).value || 'noise_volume'
      const flipY = (overlay.querySelector('#exp-flipy') as HTMLInputElement).checked
      overlay.remove()
      // Trigger export event
      window.dispatchEvent(new CustomEvent('vol3d-export', {
        detail: { format, filename, flipY }
      }))
    })
  }

  private showHelpModal() {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'modal help-modal'

    modal.innerHTML = `
      <div class="modal-header">
        <h2>Help & Shortcuts</h2>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body help-body">
        <div class="help-section">
          <h3>Keyboard</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Tab</span><span>Cycle preview mode</span></div>
            <div class="help-item"><span class="help-key">T</span><span>Toggle the 3×3×3 tile preview</span></div>
            <div class="help-item"><span class="help-key">F</span><span>Reset / focus the camera</span></div>
            <div class="help-item"><span class="help-key">Delete</span><span>Delete the selected layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+D</span><span>Duplicate the selected layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+Shift+N</span><span>Add a new default layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+E</span><span>Open the export dialog</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Viewport</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">LMB drag</span><span>Orbit / grab the volume depending on the camera mode</span></div>
            <div class="help-item"><span class="help-key">RMB drag</span><span>Pan the view</span></div>
            <div class="help-item"><span class="help-key">Wheel</span><span>Zoom in and out</span></div>
            <div class="help-item"><span class="help-key">Double-click</span><span>Reset the camera</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Curves & sliders</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Slider drag</span><span>Adjust values continuously</span></div>
            <div class="help-item"><span class="help-key">Shift+drag</span><span>Fine-adjust slider values</span></div>
            <div class="help-item"><span class="help-key">Wheel on slider</span><span>Nudge slider values by one step</span></div>
            <div class="help-item"><span class="help-key">Double-click value</span><span>Type a precise slider value</span></div>
            <div class="help-item"><span class="help-key">Right-click</span><span>Reset sliders and Bézier curves to their defaults</span></div>
            <div class="help-item"><span class="help-key">Curve handles</span><span>Drag the two control points to shape remap and feather falloff</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Layers</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Click</span><span>Select a layer</span></div>
            <div class="help-item"><span class="help-key">Drag row</span><span>Reorder layers</span></div>
            <div class="help-item"><span class="help-key">Eye button</span><span>Toggle layer visibility</span></div>
            <div class="help-item"><span class="help-key">Double-click name</span><span>Rename a layer</span></div>
            <div class="help-item"><span class="help-key">Blend badge</span><span>Cycle blend modes quickly</span></div>
            <div class="help-item"><span class="help-key">Right-click row</span><span>Open duplicate / move / delete actions</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Basic workflow</h3>
          <div class="help-copy">
            <p>Start with one large base noise layer, then stack detail layers using <strong>Multiply</strong>, <strong>Overlay</strong>, or <strong>Subtract</strong>.</p>
            <p>Use <strong>In Min / In Max</strong> to isolate ranges, then shape the result with the Bézier <strong>Remap Curve</strong>.</p>
            <p>Use <strong>Feather Shape</strong> plus the <strong>Feather</strong> widths and curve to carve the volume into a box-like or spherical falloff.</p>
            <p>The top-bar <strong>Cutoff</strong> and <strong>Contrast</strong> affect the stored/exported density, not just the preview.</p>
            <p>The <strong>Tile Preview</strong> button only visualizes repetition. It does not change the generated texture itself.</p>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="top-btn accent modal-close-primary">Close</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    overlay.querySelector('.modal-close')?.addEventListener('click', close)
    overlay.querySelector('.modal-close-primary')?.addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  }

  setGenerating(v: boolean) {
    this.progressBar.style.display = v ? 'flex' : 'none'
  }

  setProgress(v: number) {
    this.progressFill.style.width = `${Math.round(v * 100)}%`
  }

  private syncSettings(state: StateManager) {
    const settings = state.get('settings')
    this.resolutionButtons.forEach((btn, res) => {
      btn.classList.toggle('active', settings.resolution === res)
      btn.title = settings.customSliceCount
        ? `${res}×${res}×${settings.depth} volume`
        : `${res}×${res}×${res} volume`
    })
    this.customSlicesToggle?.setValue(settings.customSliceCount)
    this.depthSelect?.setValue(String(settings.depth))
    if (this.depthSelect) {
      this.depthSelect.el.disabled = !settings.customSliceCount
      this.depthSelect.el.title = settings.customSliceCount
        ? 'Independent Z slice count'
        : 'Locked to the cubic depth for this resolution'
    }
    if (this.seedInput && this.seedInput.value !== String(settings.globalSeed)) {
      this.seedInput.value = String(settings.globalSeed)
    }
    if (this.cutoffInput && this.cutoffInput.value !== String(settings.cutoff)) {
      this.cutoffInput.value = String(settings.cutoff)
    }
    if (this.contrastInput && this.contrastInput.value !== String(settings.contrast)) {
      this.contrastInput.value = String(settings.contrast)
    }
  }

  private syncCameraMode(state: StateManager) {
    if (!this.dragModeBtn) return
    const dragMode = state.get('camera').dragMode
    this.dragModeBtn.classList.toggle('active', dragMode === 'grab')
    this.dragModeBtn.textContent = dragMode === 'grab' ? 'Grab Cam' : 'Orbit Cam'
  }

  private syncPreview(state: StateManager) {
    if (!this.tilePreviewBtn) return
    const preview = state.get('preview')
    this.tilePreviewBtn.classList.toggle('active', preview.showTilePreview)
  }

  private syncAnimation(state: StateManager) {
    const animation = state.get('animation')
    if (this.animPlayBtn) {
      this.animPlayBtn.classList.toggle('active', animation.playing)
      this.animPlayBtn.textContent = animation.playing ? 'Pause' : 'Play'
    }
    if (this.animPhaseInput) {
      this.animPhaseInput.value = String(Math.round(animation.phase * 100))
    }
    if (this.animLoopInput && this.animLoopInput.value !== String(animation.loopSeconds)) {
      this.animLoopInput.value = String(animation.loopSeconds)
    }
    if (this.animEvolutionInput && this.animEvolutionInput.value !== String(animation.evolutions)) {
      this.animEvolutionInput.value = String(animation.evolutions)
    }
  }
}

function attachNumberReset(input: HTMLInputElement, defaultValue: number, onReset: (value: number) => void) {
  input.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    input.value = String(defaultValue)
    onReset(defaultValue)
  })
}

function attachRangeReset(input: HTMLInputElement, defaultValue: number, onReset: () => void) {
  input.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    input.value = String(defaultValue)
    onReset()
  })
}

