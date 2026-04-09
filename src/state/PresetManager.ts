import type { StateManager } from './StateManager'
import { defaultLayer } from './AppState'
import { NoiseType, BlendMode, DistortionType } from '../types/index'
import { openTextFile, saveText } from '../platform/fileAccess'

const STORAGE_KEY = 'vol3d_presets'

export interface Preset {
  name: string
  data: string  // serialized state
}

// Built-in presets
export const BUILTIN_PRESETS: Preset[] = [
  {
    name: 'Cloud',
    data: JSON.stringify({
      settings: { resolution: 64, globalSeed: 42 },
      layers: [
        {
          ...defaultLayer('Base FBM', NoiseType.FBM),
          noise: {
            type: NoiseType.FBM,
            worleyMode: 'f1',
            fbm: { baseNoise: NoiseType.Perlin, octaves: 6, persistence: 0.5, lacunarity: 2.0 },
            scale: [3, 3, 3], amplitude: 1.0, offset: [0,0,0], rotation: [0,0,0], seed: 0
          },
          remap: { inputMin: 0.3, inputMax: 1.0, outputMin: 0.0, outputMax: 1.0 },
        },
        {
          ...defaultLayer('Worley Detail', NoiseType.Worley),
          blendMode: BlendMode.Multiply,
          opacity: 0.6,
          noise: {
            type: NoiseType.Worley,
            worleyMode: 'f2f1',
            fbm: { baseNoise: NoiseType.Simplex, octaves: 3, persistence: 0.5, lacunarity: 2.0 },
            scale: [6, 6, 6], amplitude: 1.0, offset: [0,0,0], rotation: [0,0,0], seed: 7
          },
          remap: { inputMin: 0.0, inputMax: 0.8, outputMin: 0.0, outputMax: 1.0 },
        }
      ]
    })
  },
  {
    name: 'Dense Fog',
    data: JSON.stringify({
      settings: { resolution: 64, globalSeed: 13 },
      layers: [
        {
          ...defaultLayer('Fog Base', NoiseType.Perlin),
          noise: {
            type: NoiseType.Perlin,
            worleyMode: 'f1',
            fbm: { baseNoise: NoiseType.Perlin, octaves: 4, persistence: 0.6, lacunarity: 2.0 },
            scale: [2, 1, 2], amplitude: 1.0, offset: [0,0,0], rotation: [0,0,0], seed: 0
          },
          remap: { inputMin: 0.4, inputMax: 1.0, outputMin: 0.2, outputMax: 1.0 },
        }
      ]
    })
  },
  {
    name: 'Smoke',
    data: JSON.stringify({
      settings: { resolution: 64, globalSeed: 99 },
      layers: [
        {
          ...defaultLayer('Smoke Body', NoiseType.FBM),
          distortion: { type: DistortionType.Curl, strength: 0.4, warpOctaves: 2, warpFrequency: 2.0, swirlAmount: 1.0 },
          noise: {
            type: NoiseType.FBM,
            worleyMode: 'f1',
            fbm: { baseNoise: NoiseType.Simplex, octaves: 5, persistence: 0.55, lacunarity: 2.1 },
            scale: [4, 4, 4], amplitude: 1.0, offset: [0,0,0], rotation: [15,0,0], seed: 33
          },
        }
      ]
    })
  },
  {
    name: 'Fire',
    data: JSON.stringify({
      settings: { resolution: 64, globalSeed: 77 },
      layers: [
        {
          ...defaultLayer('Fire Base', NoiseType.FBM),
          distortion: { type: DistortionType.DomainWarp, strength: 0.5, warpOctaves: 2, warpFrequency: 3.0, swirlAmount: 1.0 },
          noise: {
            type: NoiseType.FBM,
            worleyMode: 'f1',
            fbm: { baseNoise: NoiseType.Simplex, octaves: 5, persistence: 0.5, lacunarity: 2.0 },
            scale: [4, 6, 4], amplitude: 1.0, offset: [0,0,0], rotation: [0,0,0], seed: 10
          },
          remap: { inputMin: 0.2, inputMax: 1.0, outputMin: 0.0, outputMax: 1.0 },
        }
      ]
    })
  },
  {
    name: 'Marble',
    data: JSON.stringify({
      settings: { resolution: 64, globalSeed: 55 },
      layers: [
        {
          ...defaultLayer('Marble Veins', NoiseType.Perlin),
          noise: {
            type: NoiseType.Perlin,
            worleyMode: 'f1',
            fbm: { baseNoise: NoiseType.Perlin, octaves: 6, persistence: 0.5, lacunarity: 2.0 },
            scale: [5, 1, 5], amplitude: 1.0, offset: [0,0,0], rotation: [30,0,45], seed: 20
          },
          remap: { inputMin: 0.0, inputMax: 1.0, outputMin: 0.0, outputMax: 1.0 },
        }
      ]
    })
  },
]

export class PresetManager {
  private state: StateManager

  constructor(state: StateManager) {
    this.state = state
  }

  getUserPresets(): Preset[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }

  saveUserPreset(name: string) {
    const presets = this.getUserPresets()
    const idx = presets.findIndex(p => p.name === name)
    const entry: Preset = { name, data: this.state.serialize() }
    if (idx >= 0) presets[idx] = entry
    else presets.push(entry)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  }

  deleteUserPreset(name: string) {
    const presets = this.getUserPresets().filter(p => p.name !== name)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  }

  loadPreset(preset: Preset) {
    try {
      const data = JSON.parse(preset.data)
      this.state.loadState(data)
    } catch (e) {
      console.error('Failed to load preset:', e)
    }
  }

  async exportPreset(): Promise<void> {
    const data = this.state.serialize()
    await saveText(data, {
      suggestedName: 'noise_preset.json',
      mime: 'application/json',
      filters: [{ name: 'Preset JSON', extensions: ['json'] }],
    })
  }

  async importPreset(): Promise<void> {
    const file = await openTextFile({
      filters: [{ name: 'Preset JSON', extensions: ['json'] }],
    })

    if (!file) return

    const data = JSON.parse(file.text)
    this.state.loadState(data)
  }
}
