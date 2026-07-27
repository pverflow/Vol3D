# Vol3D — Sparse Cache Tuning (budget + dedup + threshold) — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Make the sparse animation cache actually hold a smooth loop at high res by (1) a larger dedicated VRAM budget, (2) cross-frame brick dedup, (3) a tunable active threshold. Measure FPS + frame-count before/after. (256³ expected to become smooth; 512³ may stay tight → reduced-res bake is the documented fallback, not built here.)

**Constraints:** No new deps. Zero `any`. No `as never`. Web + Tauri. Dense/interactive path + exports unchanged. Green build+test. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: Bigger budget + cross-frame brick dedup + tunable threshold

**Files:** `src/core/constants.ts`, `src/core/volume/brickPack.ts` (+ test), `src/core/volume/BrickCache.ts`, `src/ui/viewport/AnimationController.ts`

**Interfaces:**
- Produces: `SPARSE_CACHE_BUDGET_BYTES` (new, e.g. `512*1024*1024`) used by `BrickCache.computeMaxBricks` (the dense `ANIMATION_CACHE_BUDGET_BYTES=96MB` stays for the dense cache — do NOT change it). `AtlasBuilder` gains cross-frame dedup: identical brick content reuses its existing atlas slot. `packFrame`/bake threshold configurable.

- [ ] **Step 1: Dedup test (TDD)** — add to `brickPack.test.ts`: pack two frames where frame B's active brick is byte-identical to frame A's → `builder.bricksUsed` stays 1 (deduped, both indirections point to the same slot); a third frame with a DIFFERENT brick → bricksUsed 2. Run → FAIL.

- [ ] **Step 2: Implement dedup in `AtlasBuilder`** — maintain a `Map<string, number>` from a brick-content hash (e.g. FNV-1a over the brick's RG bytes) to slot index; `append(brickBytes)` returns the existing slot on a hash hit (verify full-bytes-equal on collision), else appends a new slot. `packFrame` writes the returned slot into the indirection. Keep the cubic-layout + `bpa≤256` invariants. Run → PASS.

- [ ] **Step 3: Bigger dedicated budget** — add `SPARSE_CACHE_BUDGET_BYTES = 512*1024*1024` to `constants.ts`; `BrickCache.computeMaxBricks` uses it (min with the `MAX_3D_TEXTURE_SIZE` cap and the `256³` bpa cap). Leave `ANIMATION_CACHE_BUDGET_BYTES` (dense cache) untouched.

- [ ] **Step 4: Tunable threshold** — expose the active-brick threshold (bake passes it to `packFrame`); pick a sensible default that culls empty/near-empty bricks without dropping faint smoke (e.g. a small epsilon on max(density,heat)). A named constant is fine.

- [ ] **Step 5: Build + test + MEASURE** — `npm run build && npm run test` (dedup test green). Then a real-GPU headless Playwright measurement (scratch, no repo deps): at **256³** and **512³**, report **cache frame count** and **playback FPS** with the tuning vs the pre-tuning baseline (git stash A/B). State honestly whether 256³ is now smooth (target: full N frames fit, ≥ ~20–30 fps playback) and how much 512³ improved (frame count > 1?). Also confirm dense/interactive + export unchanged.

- [ ] **Step 6: Commit** `feat: larger sparse-cache budget + cross-frame brick dedup + tunable threshold`

## Self-Review Notes
- Dedup is content-hash based (collision-checked); turbulent bricks may not dedup much — the measurement tells us if it helped. Budget bump is the bigger lever for 256³.
- No change to the dense cache budget, dense/interactive path, or exports.
- If 512³ still can't hold a real loop after this, the documented fallback is the reduced-resolution playback bake (separate increment) — note it in the report, don't build it here.
