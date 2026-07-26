import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import { BrickCache } from '../../core/volume/BrickCache'
import { AtlasBuilder, packFrame, macroDims } from '../../core/volume/brickPack'
import type { StateManager } from '../../state/StateManager'
import type { AnimationSettings, Layer } from '../../types/index'
import { ANIMATION_MIN_FRAME_MS, BRICK_SIZE, ANIM_LOOP_FRAMES_DEFAULT, SPARSE_ACTIVE_THRESHOLD } from '../../core/constants'
import { computeCacheFrameCount } from './animationCache'

interface AnimationControllerOptions {
  state: StateManager
  cacheGenerator: VolumeGenerator
  // Dedicated generator for the sparse-cache bake (VFX-1 Task 3) — kept
  // separate from `cacheGenerator` so the bake's own chunked-rAF loop never
  // cancels/contends with the dense per-frame cache build's loop when both
  // run around the same play-start moment (VolumeGenerator only tracks one
  // in-flight loop per instance).
  sparseGenerator: VolumeGenerator
  brickCache: BrickCache
  gl: WebGL2RenderingContext
  getVolume: () => VolumeTexture
  onNeedsGeneration: () => void
}

export class AnimationController {
  private state: StateManager
  private cacheGenerator: VolumeGenerator
  private sparseGenerator: VolumeGenerator
  private brickCache: BrickCache
  private gl: WebGL2RenderingContext
  private getVolume: () => VolumeTexture
  private onNeedsGeneration: () => void

  private lastAnimationTick = 0
  private lastAnimationState: AnimationSettings
  private animationCacheFrames: Uint8Array[] = []
  private animationCacheKey = ''
  private animationCacheBuildId = 0
  private animationCacheBuilding = false
  private currentCachedFrame = -1

  // Sparse GPU brick cache bake (VFX-1 Task 3). Not consumed by playback yet
  // (T4/T5) — this is a second, parallel bake alongside the dense
  // animationCacheFrames path above, inspectable via brickCache.frameCount.
  private sparseCacheKey = ''
  private sparseCacheBuildId = 0
  private sparseCacheBuilding = false
  private sparseCacheAvailable = false

  constructor(options: AnimationControllerOptions) {
    this.state = options.state
    this.cacheGenerator = options.cacheGenerator
    this.sparseGenerator = options.sparseGenerator
    this.brickCache = options.brickCache
    this.gl = options.gl
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

    // Sparse cache (VFX-1 Task 3): bake on play-start only. An evolutions
    // edit mid-playback is handled by the settle path instead (Viewport's
    // generateFull onComplete calls buildSparseCache() there, gated on
    // still-playing) so a bake doesn't kick off on stale pre-edit frames.
    if (!prev.playing && next.playing) {
      this.buildSparseCache()
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

  // Invalidates BOTH caches (dense per-frame + sparse GPU brick cache) — every
  // call site here means "the volume content described by state changed",
  // which invalidates whatever either cache was holding. Folding the sparse
  // invalidation in here (rather than adding a second call at every one of
  // this method's existing call sites) keeps the "on layers/settings edits,
  // invalidate" rule enforced in one place.
  invalidateAnimationCache() {
    this.animationCacheBuildId += 1
    this.animationCacheBuilding = false
    this.animationCacheFrames = []
    this.animationCacheKey = ''
    this.currentCachedFrame = -1
    this.cacheGenerator.cancel()

    this.invalidateSparseCache()
  }

  // Marks the sparse cache unavailable and frees its GPU textures so a stale
  // atlas/indirection set is never mistaken for a valid one. Safe to call
  // whether or not a bake is in flight (an in-flight bake notices the bumped
  // build id at its next await and bails without touching brickCache).
  invalidateSparseCache() {
    this.sparseCacheBuildId += 1
    this.sparseCacheBuilding = false
    this.sparseCacheKey = ''
    this.sparseCacheAvailable = false
    this.sparseGenerator.cancel()
    this.brickCache.destroy()
  }

  // Bakes the animation loop into the GPU sparse brick cache (VFX-1 Task 3):
  // generates each loop frame via the existing generateFrameData path (on a
  // dedicated generator instance — see sparseGenerator's doc comment above),
  // packs its active bricks into a shared AtlasBuilder, and uploads the
  // result into brickCache. Reuses the same build-id/cancel + key-gating
  // pattern as buildAnimationCacheIfNeeded so a superseding edit cancels an
  // in-flight bake cleanly. NOT yet consumed by playback (T4/T5) — this task
  // only builds it; it stays inspectable via brickCache.frameCount while the
  // existing dense animationCacheFrames path keeps driving actual playback.
  buildSparseCache(): void {
    const key = this.getAnimationCacheKey()
    if (!this.sparseCacheBuilding && this.sparseCacheKey === key && this.sparseCacheAvailable) {
      return
    }
    if (this.sparseCacheBuilding && this.sparseCacheKey === key) {
      return
    }

    this.sparseCacheBuildId += 1
    const buildId = this.sparseCacheBuildId
    this.sparseCacheBuilding = true
    this.sparseCacheKey = key
    this.sparseCacheAvailable = false
    this.sparseGenerator.cancel()
    this.state.update('generating', true)
    this.state.update('progress', 0)

    const { layers, settings, animation } = this.state.getState()
    const { resolution, depth, globalSeed } = settings

    void this.bakeSparseCache(buildId, layers, resolution, depth, globalSeed, animation.evolutions)
  }

  private async bakeSparseCache(
    buildId: number,
    layers: Layer[],
    resolution: number,
    depth: number,
    globalSeed: number,
    evolutions: number
  ): Promise<void> {
    // Worst-case-conservative N clamp: assume every macrocell could be active
    // every frame (no cross-frame brick reuse) and shrink the loop length so
    // that upper bound still fits the brick budget, instead of discovering an
    // overflow mid-bake. Real fire/smoke scenes are far sparser than this
    // worst case, so N is rarely actually reduced in practice — but a scene
    // dense/large enough to hit it gets a clamp + a loud note, not a silent
    // truncation.
    const maxBricks = BrickCache.computeMaxBricks(this.gl)
    const [mx, my, mz] = macroDims(resolution, depth)
    const macrocellsPerFrame = Math.max(1, mx * my * mz)
    const maxFrames = Math.max(1, Math.floor(maxBricks / macrocellsPerFrame))
    let frameCount = ANIM_LOOP_FRAMES_DEFAULT
    if (maxFrames < frameCount) {
      console.warn(
        `AnimationController: clamped sparse-cache loop length from ${frameCount} to ${maxFrames} frames — ` +
          `this scene's macrocell count (${macrocellsPerFrame}/frame) could exceed the brick VRAM budget ` +
          `(${maxBricks}) at the default loop length.`
      )
      frameCount = maxFrames
    }

    const builder = new AtlasBuilder(BRICK_SIZE, maxBricks)
    const indirections: Uint8Array[] = []

    try {
      for (let i = 0; i < frameCount; i++) {
        const phase = i / frameCount
        const dense = await this.sparseGenerator.generateFrameData(layers, resolution, depth, globalSeed, phase, evolutions)

        // Superseded by a newer bake (edit/invalidate/another play-start) —
        // bail before touching shared state (brickCache, progress).
        if (buildId !== this.sparseCacheBuildId) return

        const packed = packFrame(dense, resolution, depth, builder, SPARSE_ACTIVE_THRESHOLD)
        indirections.push(packed.indirection)
        this.state.update('progress', (i + 1) / frameCount)
      }

      if (buildId !== this.sparseCacheBuildId) return

      try {
        this.brickCache.build(builder, indirections, resolution, depth)
        this.sparseCacheAvailable = true
      } catch (err) {
        // BrickCache.build() throws loud on overflow/GPU OOM (by design) —
        // degrade gracefully here instead of crashing: sparse cache stays
        // unavailable/empty, playback keeps using the dense per-frame path
        // (this task's only consumer of either cache anyway).
        console.warn('AnimationController: sparse cache build failed — playback stays on the dense per-frame path.', err)
        this.sparseCacheAvailable = false
      }
    } finally {
      if (buildId === this.sparseCacheBuildId) {
        this.sparseCacheBuilding = false
      }
      // Unconditional: if this bake was superseded, nothing should still be
      // "generating" on its behalf, and a newer bake — if one starts — sets
      // these back to true/0 itself. Leaving this guarded by buildId risked
      // a permanently-stuck indicator when a bake is invalidated with no
      // guaranteed successor (e.g. an edit while not playing).
      this.state.update('generating', false)
      this.state.update('progress', 1)
    }
  }

  private getAnimationCacheKey(): string {
    const state = this.state.getState()
    // cutoff/contrast are preview-time shading uniforms (Task 3) and don't
    // affect the raw density the cache stores, so they're excluded here —
    // dragging them must not invalidate/rebuild the animation cache.
    const { cutoff, contrast, ...cacheSettings } = state.settings
    return JSON.stringify({
      layers: state.layers,
      settings: cacheSettings,
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
