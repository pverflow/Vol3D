import './ui/styles/base.css'
import './ui/styles/layout.css'
import './ui/styles/components.css'
import './ui/styles/panels.css'
import './ui/styles/viewport.css'
import './ui/styles/animations.css'

import { StateManager } from './state/StateManager'
import { PresetManager } from './state/PresetManager'
import { LayerPanel } from './ui/panels/LayerPanel'
import { PropertiesPanel } from './ui/panels/PropertiesPanel'
import { TopBar } from './ui/panels/TopBar'
import { Viewport } from './ui/viewport/Viewport'

function init() {
  const app = document.getElementById('app')!

  // Check WebGL2
  const testCanvas = document.createElement('canvas')
  if (!testCanvas.getContext('webgl2')) {
    app.innerHTML = `
      <div class="error-screen">
        <div class="error-icon">⚠</div>
        <h2>WebGL2 Required</h2>
        <p>Your browser or GPU does not support WebGL2.</p>
        <p>Please use Chrome, Edge, or Firefox with hardware acceleration enabled.</p>
      </div>
    `
    return
  }

  // Create state - dirty callback wired up after viewport is created
  let viewportRef: Viewport | null = null
  const state = new StateManager(() => {
    viewportRef?.scheduleGeneration()
  })

  const presets = new PresetManager(state)

  // Create UI
  const topBar = new TopBar(state, presets)
  const layerPanel = new LayerPanel(state)
  const viewport = new Viewport(state)
  viewportRef = viewport
  const propsPanel = new PropertiesPanel(state)

  // Layout
  app.appendChild(topBar.el)

  const main = document.createElement('div')
  main.className = 'main-layout'
  main.appendChild(viewport.el)

  const sideStack = document.createElement('div')
  sideStack.className = 'sidebar-stack'
  sideStack.appendChild(propsPanel.el)
  sideStack.appendChild(layerPanel.el)
  main.appendChild(sideStack)

  app.appendChild(main)
}

init()
