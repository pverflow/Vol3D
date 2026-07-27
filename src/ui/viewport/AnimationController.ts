import { VolumeGenerator } from '../../core/renderer/VolumeGenerator'
import { VolumeTexture } from '../../core/volume/VolumeTexture'
import { BrickCache } from '../../core/volume/BrickCache'
import { AtlasBuilder, packFrame, macroDims, bakePlaybackResolution } from '../../core/volume/brickPack'
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

  // Sparse GPU brick cache bake (VFX-1 Task 3), consumed by playback (Task
  // 5) — a second, parallel bake alongside the dense animationCacheFrames
  // path above, inspectable via brickCache.frameCount.
  private sparseCacheKey = ''
  private sparseCacheBuildId = 0
  private sparseCacheBuilding = false
  private sparseCacheAvailable = false
  // Sticky "this exact scene already failed to bake" marker (VFX-1 Task 5
  // carry-forward): set when brickCache.build() throws for `sparseCacheKey`.
  // buildSparseCache() short-circuits while the current key still matches
  // this, instead of re-running the whole N-frame bake every play-start for
  // a scene that's deterministically going to fail again (e.g. an atlas too
  // large for this GPU). Cleared implicitly the moment the key changes via
  // an edit — no explicit reset needed, since a differing key just won't
  // match this string anymore.
  private sparseFailedKey = ''
  // Frame index (into brickCache) that advanceAnimation wants the current
  // render to bind, or null when playback should use the dense path instead
  // (not playing, or no sparse cache baked yet). Read by Viewport once per
  // render, right after advanceAnimation runs — see the `sparseFrameIndex`
  // getter below.
  private currentSparseFrameIndex: number | null = null

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

  // The sparse frame Viewport should bind for the CURRENT render, or null to
  // render the normal dense path (u_sparseEnabled=false). Only meaningful
  // for the render immediately following an advanceAnimation() call in the
  // same synchronous tick (Viewport.renderFrame calls them back-to-back) —
  // a cache invalidation can only happen from a separate call stack (a state
  // subscription fired by user input), never interleaved mid-tick, so this
  // is never read stale against a brickCache that's since been destroyed.
  get sparseFrameIndex(): number | null {
    return this.currentSparseFrameIndex
  }

  advanceAnimation(now: number) {
    const animation = this.state.get('animation')
    if (!animation.playing) {
      this.lastAnimationTick = now
      this.currentSparseFrameIndex = null
      return
    }

    // Sparse cache playback (VFX-1 Task 5): once a bake has completed for
    // the current scene, drive the phase clock the same way the dense path
    // below always has, but bind the nearest baked frame directly instead of
    // regenerating anything — no onNeedsGeneration(), no per-frame upload.
    const sparseFrameCount = this.brickCache.frameCount
    if (sparseFrameCount > 0) {
      if (this.lastAnimationTick === 0) {
        this.lastAnimationTick = now
      } else {
        const elapsed = now - this.lastAnimationTick
        if (elapsed >= ANIMATION_MIN_FRAME_MS) {
          const phaseDelta = elapsed / (animation.loopSeconds * 1000)
          const phase = (animation.phase + phaseDelta) % 1
          this.lastAnimationTick = now
          this.state.update('animation', { ...animation, phase })
        }
      }

      const phase = this.state.get('animation').phase
      const wrapped = ((phase % 1) + 1) % 1
      this.currentSparseFrameIndex = Math.round(wrapped * sparseFrameCount) % sparseFrameCount
      return
    }

    this.currentSparseFrameIndex = null

    // No sparse cache yet (still baking, clamped away, or this scene never
    // gets one) — dense interactive path, unchanged.
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
      // Sparse playback (Task 5) binds its own frame via advanceAnimation /
      // sparseFrameIndex — applying the dense per-frame cache here too would
      // just be a wasted whole-volume uploadVolume() every phase tick.
      const sparsePlaying = next.playing && this.brickCache.frameCount > 0
      if (!sparsePlaying && !this.tryApplyCachedAnimationFrame(next.phase) && !next.playing) {
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
      // Snap to a crisp full-res frame at the current (paused) phase: sparse
      // playback baked/showed a reduced-res loop and never updated the dense
      // volume per-frame, so regen full-res here (also fixes pre-existing
      // pause staleness). Does NOT invalidate the sparse cache (resume stays
      // instant) — the regen is gated on !playing so it won't rebake.
      this.onNeedsGeneration()
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
    this.currentSparseFrameIndex = null
    this.sparseGenerator.cancel()
    this.brickCache.destroy()
  }

  // Bakes the animation loop into the GPU sparse brick cache (VFX-1 Task 3):
  // generates each loop frame via the existing generateFrameData path (on a
  // dedicated generator instance — see sparseGenerator's doc comment above),
  // packs its active bricks into a shared AtlasBuilder, and uploads the
  // result into brickCache. Reuses the same build-id/cancel + key-gating
  // pattern as buildAnimationCacheIfNeeded so a superseding edit cancels an
  // in-flight bake cleanly. Consumed by playback via advanceAnimation's
  // brickCache.frameCount check (Task 5) — once this succeeds, playback binds
  // frames straight from brickCache instead of touching the dense path.
  //
  // Deliberately does NOT touch state.generating/progress (regression fix,
  // VFX-1 Task 5 carry-forward): this bake runs silently in the background.
  // It used to call beginGenerating()/endGenerating() (a ref count meant to
  // let multiple overlapping "generation in progress" sources share one
  // indicator), but that pairing isn't actually guaranteed here — like
  // Viewport.generateFull(), this bake's own completion is reached via an
  // awaited chunked-rAF loop (sparseGenerator.generateFrameData) that another
  // caller can cancel out from under it (e.g. an edit mid-bake calling
  // invalidateSparseCache() -> sparseGenerator.cancel()); when that happens
  // the in-flight await never resolves, so this async function never reaches
  // its finally block and the matching endGenerating() would never run —
  // exactly the "stuck generating=true forever" bug this fix removes. Rather
  // than build a second id-guard scheme for a bake nobody's blocked on (the
  // dense frame already on screen keeps playing while this bakes), the
  // simplest robust fix is for it to just not own any part of the shared
  // indicator: Viewport's generationId scheme (generateFull/export) is the
  // sole owner, so this bake can never stomp it, and this bake's own
  // cancellation/hang risk can never leak into it either. Failures/clamps
  // still get a console.warn (see below), which is enough signal for a
  // background operation whose absence just means "playback stays on the
  // dense per-frame path" rather than any visible breakage.
  buildSparseCache(): void {
    const key = this.getAnimationCacheKey()
    // Sticky failed-key guard: this exact scene already failed to bake once
    // (brickCache.build() threw) — don't re-run the whole N-frame bake on
    // every play-start for a doomed key. An edit changes the key and lifts
    // this automatically.
    if (key === this.sparseFailedKey) {
      return
    }
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
    // Reduced-res playback bake: at high source res a full loop can't fit VRAM,
    // so bake the loop at the largest brick-aligned res whose whole loop fits
    // (playback is softer; pause snaps back to full native res — see
    // handleAnimationChange). At low res this returns sourceRes unchanged.
    const { res: bakeRes, depth: bakeDepth } = bakePlaybackResolution(maxBricks, resolution, depth, ANIM_LOOP_FRAMES_DEFAULT)
    this.sparseGenerator.resize(bakeRes)
    const [mx, my, mz] = macroDims(bakeRes, bakeDepth)
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
        const dense = await this.sparseGenerator.generateFrameData(layers, bakeRes, bakeDepth, globalSeed, phase, evolutions)

        // Superseded by a newer bake (edit/invalidate/another play-start) —
        // bail before touching shared state (brickCache).
        if (buildId !== this.sparseCacheBuildId) return

        const packed = packFrame(dense, bakeRes, bakeDepth, builder, SPARSE_ACTIVE_THRESHOLD)
        indirections.push(packed.indirection)
      }

      if (buildId !== this.sparseCacheBuildId) return

      try {
        this.brickCache.build(builder, indirections, bakeRes, bakeDepth)
        this.sparseCacheAvailable = true
      } catch (err) {
        // BrickCache.build() throws loud on overflow/GPU OOM (by design) —
        // degrade gracefully here instead of crashing: sparse cache stays
        // unavailable/empty, playback keeps using the dense per-frame path
        // (the fallback whenever brickCache.frameCount is 0). Sticky: mark
        // this exact key as failed so the next play-start doesn't retry the
        // same doomed N-frame bake (see buildSparseCache's guard).
        console.warn('AnimationController: sparse cache build failed — playback stays on the dense per-frame path.', err)
        this.sparseCacheAvailable = false
        this.sparseFailedKey = this.sparseCacheKey
      }
    } finally {
      if (buildId === this.sparseCacheBuildId) {
        this.sparseCacheBuilding = false
      }
      // No endGenerating() here — see buildSparseCache's doc comment above
      // for why this bake never touches state.generating/progress at all.
      // (Also worth noting: this finally itself isn't even guaranteed to run
      // when superseded — see the same comment — which is exactly why this
      // bake must not be the thing responsible for clearing shared state.)
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
