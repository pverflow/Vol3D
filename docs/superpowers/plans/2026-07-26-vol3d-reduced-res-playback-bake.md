# Vol3D — Reduced-Resolution Playback Bake — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Make high-res (512³) animation playback smooth by baking the sparse
loop at a *reduced* resolution that fits the full loop in the brick budget,
then snapping back to full native resolution on pause. Tuning fixed 256³
(16/32 frames) but 512³ still baked only 2 frames — full-res 512³ can't fit a
loop in VRAM. Reduced-res playback + crisp-on-pause is the documented fallback.

**Measured baseline (this branch, before this task):** 256³ = 16/32 frames
~120fps; 512³ = 2/32 frames ~26–34fps (not animating).

**Constraints:** No new deps. Zero `any`. No `as never`. Web + Tauri. Dense
interactive path + exports unchanged. Ramp-OFF/on look unchanged. Green
build+test. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Design (worked out — implement exactly)

Two changes, both in the bake/playback path only. The sparse render already
samples the brick grid resolution-independently (`u_macroDims` /
`u_atlasDimsBricks` come from the *baked* grid, ray positions are normalized
`[0,1]³`), so baking at a lower resolution "just works" — playback is softer,
the full loop fits, pause is crisp.

### 1. Bake the playing loop at a reduced resolution
- New pure helper in `brickPack.ts`:
  `bakePlaybackResolution(maxBricks, sourceRes, sourceDepth, targetFrames): { res, depth }`
  — largest brick-aligned res **≤ sourceRes** whose worst-case full
  `targetFrames` loop fits the budget: `macroDims(res,depth) product ≤ floor(maxBricks/targetFrames)`.
  Step down from `sourceRes` by `BRICK_SIZE`; preserve source aspect for depth
  (`depth = max(BRICK, round(res * sourceDepth/sourceRes / BRICK) * BRICK)`);
  floor at `BRICK_SIZE`. Returns `{res: sourceRes, ...}` unchanged when the
  full loop already fits (≤128³ etc.) → behavior identical to today for those.
- In `AnimationController.bakeSparseCache`: compute
  `{res: bakeRes, depth: bakeDepth} = bakePlaybackResolution(maxBricks, resolution, depth, ANIM_LOOP_FRAMES_DEFAULT)`,
  `this.sparseGenerator.resize(bakeRes)`, then generate/`packFrame`/
  `brickCache.build` at `bakeRes`/`bakeDepth` (not the source res). The existing
  worst-case `maxFrames` clamp now uses `bakeRes`'s macrocell count → it won't
  trigger (bakeRes was chosen to fit `ANIM_LOOP_FRAMES_DEFAULT`), so the full
  loop bakes. Keep the clamp as the safety net.
- `sparseGenerator` is dedicated to the bake (Viewport only resizes it on
  settings change), so resizing it down here is safe; it's re-chosen every bake.

### 2. Snap to full native resolution on pause
- In `AnimationController.handleAnimationChange`, the `prev.playing && !next.playing`
  branch (currently only resets `lastAnimationTick`): also call
  `this.onNeedsGeneration()` → full-res `generateFull` at the current (paused)
  phase → dense path shows a crisp native-res frame. This also fixes the
  pre-existing "pause shows a stale full-res frame" (during sparse playback
  `this.volume` is never updated per-frame).
- Do NOT invalidate the sparse cache on pause (resume-play stays instant). The
  pause regen must not rebake (it's paused → `generateFull.onComplete` already
  gates `buildSparseCache()` on `playing`).

---

## Task 1: Reduced-res bake helper + wire bake + pause snap

**Files:** `src/core/volume/brickPack.ts` (+ `.test.ts`), `src/ui/viewport/AnimationController.ts`

- [ ] **Step 1: Helper test (TDD)** — in `brickPack.test.ts`: `bakePlaybackResolution`
  returns sourceRes when the full loop already fits (small maxBricks-generous /
  low res, e.g. 128³ with a big budget); returns a reduced, brick-aligned res
  `< 512` whose `macroDims` product `≤ floor(maxBricks/targetFrames)` for 512³
  with a realistic `maxBricks` (e.g. 65536, targetFrames 32 → expect ~192);
  result is always a multiple of `BRICK_SIZE`, `≥ BRICK_SIZE`, `≤ sourceRes`;
  depth preserves aspect (cubic in→cubic out). Run → FAIL.
- [ ] **Step 2: Implement `bakePlaybackResolution`** in `brickPack.ts` (pure, no GL).
  Export it. Run → PASS. Full suite stays green.
- [ ] **Step 3: Wire reduced-res bake** in `AnimationController.bakeSparseCache`:
  compute bakeRes/bakeDepth via the helper (using `BrickCache.computeMaxBricks(this.gl)`
  — already computed there for the clamp), `sparseGenerator.resize(bakeRes)`,
  and thread bakeRes/bakeDepth through `generateFrameData`, `packFrame`,
  `macroDims`, and `brickCache.build`. Keep the worst-case clamp as-is (now a
  safety net). No change to the dense per-frame cache path.
- [ ] **Step 4: Snap-to-full-res on pause** in `handleAnimationChange`: in the
  `prev.playing && !next.playing` branch add `this.onNeedsGeneration()`. Verify
  no double-regen (the phase-change branch already skips when phase is unchanged).
- [ ] **Step 5: Build + test + MEASURE** — `npm run build && npm run test` (new
  helper test green; existing round-trip/dedup/cubic/bpa tests green). Then a
  real-GPU headless Playwright measurement (scratch, no repo deps): at **512³**
  report cache frame count (expect full `ANIM_LOOP_FRAMES_DEFAULT`=32) and
  playback FPS (expect smooth, ≥ ~30fps) vs the 2-frame baseline; confirm
  playback is visibly softer than pause and **pause snaps to a crisp full-res
  frame at the current phase**; at **256³** confirm still smooth (now full loop)
  and pause crisp; confirm dense interactive editing + export unchanged. Be
  HONEST if a live smoke wasn't run.
- [ ] **Step 6: Commit** `feat: reduced-resolution playback bake (full loop) + snap to full res on pause`

## Self-Review Notes
- Sparse sampling is resolution-independent (grid dims are uniforms; ray coords
  normalized), so a lower bake res only softens playback — no shader change.
- Pause regen is the crisp-frame source AND a fix for pre-existing pause
  staleness; it must not invalidate the sparse cache (instant resume) nor
  rebake (it's gated on `playing`).
- Aspect preserved so `u_volumeSize` depthScale (from the full-res volume)
  still matches the sparse bounding box.
- Not built here: temporal interpolation, brick apron/LINEAR atlas (playback
  blockiness), on-disk gzip. Deferred.
