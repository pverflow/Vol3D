import type { StateManager } from '../../state/StateManager'
import type { PresetManager } from '../../state/PresetManager'
import { BUILTIN_PRESETS } from '../../state/PresetManager'
import { openAnchoredPopup } from '../components/anchoredPopup'

export class PresetsMenu {
  // `state` isn't read directly here (PresetManager already closes over it),
  // but is accepted to keep this module's constructor consistent with
  // ExportModal's and with how TopBar already holds (state, presets).
  constructor(_state: StateManager, private readonly presets: PresetManager) {}

  open(anchor: HTMLElement): void {
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
        this.presets.loadPreset(preset)
        close()
      })
      popup.appendChild(btn)
    }

    const userPresetList = this.presets.getUserPresets()
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
        btn.addEventListener('click', () => { this.presets.loadPreset(preset); close() })
        const del = document.createElement('button')
        del.className = 'preset-del'
        del.textContent = '×'
        del.addEventListener('click', () => { this.presets.deleteUserPreset(preset.name); close() })
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
      if (name?.trim()) { this.presets.saveUserPreset(name.trim()); close() }
    })
    popup.appendChild(saveBtn)

    const importBtn = document.createElement('button')
    importBtn.className = 'preset-item'
    importBtn.textContent = '↑ Import from file...'
    importBtn.addEventListener('click', () => {
      void this.presets.importPreset()
        .catch((err) => {
          console.error('Failed to import preset:', err)
          window.alert('Failed to import preset. See the console for details.')
        })
        .finally(() => close())
    })
    popup.appendChild(importBtn)

    const exportFileBtn = document.createElement('button')
    exportFileBtn.className = 'preset-item'
    exportFileBtn.textContent = '↓ Export to file...'
    exportFileBtn.addEventListener('click', () => {
      void this.presets.exportPreset()
        .catch((err) => {
          console.error('Failed to export preset:', err)
          window.alert('Failed to export preset. See the console for details.')
        })
        .finally(() => close())
    })
    popup.appendChild(exportFileBtn)

    const close = openAnchoredPopup(anchor, popup)
  }
}
