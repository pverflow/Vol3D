import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import type { StateManager } from '../../state/StateManager'
import type { AnimationSettings } from '../../types/index'
import { ANIMATION_MIN_FRAME_MS } from '../../core/constants'
import { computeCacheFrameCount } from './animationCache'

interface AnimationControllerOptions {
  state: StateManager
  cacheGenerator: VolumeGenerator
  getVolume: () => VolumeTexture
  onNeedsGeneration: () => void
}

export class AnimationController {
  private state: StateManager
  private cacheGenerator: VolumeGenerator
  private getVolume: () => VolumeTexture
  private onNeedsGeneration: () => void

  private lastAnimationTick = 0
  private lastAnimationState: AnimationSettings
  private animationCacheFrames: Uint8Array[] = []
  private animationCacheKey = ''
  private animationCacheBuildId = 0
  private animationCacheBuilding = false
  private currentCachedFrame = -1

  constructor(options: AnimationControllerOptions) {
    this.state = options.state
    this.cacheGenerator = options.cacheGenerator
    this.getVolume = options.getVolume
    this.onNeedsGeneration = options.onNeedsGeneration
    this.lastAnimationState = { ...this.state.get('animation') }
  }

  advanceAnimation(now: number) {
    const animation = this.state.get('animation')
    if (!animation.playing) {
      this.lastAnimationTick = now
      return
    }

    const cacheFrameCount = computeCacheFrameCount(this.getVolume().resolution, this.getVolume().depth)
    if (cacheFrameCount >= 2 && this.animationCacheFrames.length < cacheFrameCount) {
      this.buildAnimationCacheIfNeeded()
      this.lastAnimationTick = now
      return
    }

    if (this.lastAnimationTick === 0) {
      this.lastAnimationTick = now
      return
    }

    const minFrameMs = ANIMATION_MIN_FRAME_MS
    const elapsed = now - this.lastAnimationTick
    if (elapsed < minFrameMs) return

    const phaseDelta = elapsed / (animation.loopSeconds * 1000)
    const phase = (animation.phase + phaseDelta) % 1
    this.lastAnimationTick = now
    this.state.update('animation', { ...animation, phase })

    if (cacheFrameCount < 2) {
      this.onNeedsGeneration()
    }
  }

  handleAnimationChange(next: AnimationSettings) {
    const prev = this.lastAnimationState

    if (prev.evolutions !== next.evolutions) {
      this.invalidateAnimationCache()
      this.onNeedsGeneration()
    } else if (prev.phase !== next.phase) {
      if (!this.tryApplyCachedAnimationFrame(next.phase) && !next.playing) {
        this.onNeedsGeneration()
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

  // Marks the volume as not matching any cached frame, so the next cache
  // apply re-uploads even if its index matches the last-applied one.
  // Call this whenever something outside the cache path (e.g. a foreground
  // regeneration) overwrites the volume's contents.
  resetAppliedFrame() {
    this.currentCachedFrame = -1
  }

  invalidateAnimationCache() {
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

  buildAnimationCacheIfNeeded() {
    const frameCount = computeCacheFrameCount(this.getVolume().resolution, this.getVolume().depth)
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

  tryApplyCachedAnimationFrame(phase: number): boolean {
    const frameCount = this.animationCacheFrames.length
    if (frameCount < 2) return false

    const wrapped = ((phase % 1) + 1) % 1
    const index = Math.min(frameCount - 1, Math.floor(wrapped * frameCount))
    const frame = this.animationCacheFrames[index]
    if (!frame) return false

    if (this.currentCachedFrame !== index) {
      this.getVolume().uploadVolume(frame)
      this.currentCachedFrame = index
    }

    return true
  }
}
