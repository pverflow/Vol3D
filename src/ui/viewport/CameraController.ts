import type { CameraState } from '../../types/index'
import { mat4LookAt, mat4Perspective, mat4Multiply, mat4Invert } from '../../utils/mathUtils'

export class CameraController {
  private camera: CameraState
  private onChange: (cam: CameraState) => void
  private canvas: HTMLElement
  private volumeSize = new Float32Array([1, 1, 1])
  private isOrbiting = false
  private isPanning = false
  private lastX = 0
  private lastY = 0

  constructor(canvas: HTMLElement, initial: CameraState, onChange: (cam: CameraState) => void) {
    this.camera = { ...initial }
    this.onChange = onChange
    this.canvas = canvas
    this.attachEvents()
  }

  private attachEvents() {
    const el = this.canvas

    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.isOrbiting = true }
      if (e.button === 2) { this.isPanning = true; e.preventDefault() }
      this.lastX = e.clientX
      this.lastY = e.clientY
    })

    window.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY

      if (this.isOrbiting) {
        const orbitSign = this.camera.dragMode === 'grab' ? -1 : 1
        this.camera.azimuth += dx * 0.01 * orbitSign
        this.camera.elevation = Math.max(
          -Math.PI / 2 + 0.05,
          Math.min(Math.PI / 2 - 0.05, this.camera.elevation - dy * 0.01 * orbitSign)
        )
        this.onChange({ ...this.camera })
      }
      if (this.isPanning) {
        const panSign = this.camera.dragMode === 'grab' ? -1 : 1
        this.camera.panX += dx * 0.005 * panSign
        this.camera.panY -= dy * 0.005 * panSign
        this.onChange({ ...this.camera })
      }
    })

    window.addEventListener('mouseup', () => {
      this.isOrbiting = false
      this.isPanning = false
    })

    el.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.camera.distance *= 1 + e.deltaY * 0.001
      this.camera.distance = Math.max(0.5, Math.min(8.0, this.camera.distance))
      this.onChange({ ...this.camera })
    }, { passive: false })

    el.addEventListener('contextmenu', (e) => e.preventDefault())

    // Double click resets camera
    el.addEventListener('dblclick', () => this.reset())
  }

  reset() {
    this.camera = {
      azimuth: 0.5,
      elevation: 0.3,
      distance: 2.5,
      panX: 0,
      panY: 0,
      dragMode: this.camera.dragMode,
    }
    this.onChange({ ...this.camera })
  }

  setVolumeDepth(resolution: number, depth: number) {
    this.volumeSize = new Float32Array([1, 1, depth / resolution])
  }

  getMatrices(width: number, height: number): {
    view: Float32Array
    proj: Float32Array
    invViewProj: Float32Array
    eye: Float32Array
    forward: Float32Array
    right: Float32Array
    up: Float32Array
  } {
    const { azimuth, elevation, distance, panX, panY } = this.camera

    const x = Math.cos(elevation) * Math.sin(azimuth) * distance
    const y = Math.sin(elevation) * distance
    const z = Math.cos(elevation) * Math.cos(azimuth) * distance

    const center = new Float32Array([
      0.5 + panX,
      0.5 + panY,
      this.volumeSize[2] * 0.5,
    ])
    const eye = new Float32Array([x + center[0], y + center[1], z + center[2]])
    const worldUp = new Float32Array([0, 1, 0])

    const forward = normalize3(new Float32Array([
      center[0] - eye[0],
      center[1] - eye[1],
      center[2] - eye[2],
    ]))
    const right = normalize3(cross3(forward, worldUp))
    const up = normalize3(cross3(right, forward))

    const view = mat4LookAt(eye, center, up)
    const proj = mat4Perspective(Math.PI / 3, width / height, 0.01, 100.0)
    const viewProj = mat4Multiply(proj, view)
    const invViewProj = mat4Invert(viewProj)

    return { view, proj, invViewProj, eye, forward, right, up }
  }

  updateCamera(cam: CameraState) {
    this.camera = { ...cam }
  }
}

function cross3(a: Float32Array, b: Float32Array): Float32Array {
  return new Float32Array([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ])
}

function normalize3(v: Float32Array): Float32Array {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? new Float32Array([v[0] / len, v[1] / len, v[2] / len]) : v
}

