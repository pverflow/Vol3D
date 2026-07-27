# Vol3D — Sparse Brick-Grid Animation Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Smooth high-res animation playback by caching the loop as sparse bricks (only non-empty regions), GPU-resident, sampled directly by the raymarch — no per-frame regen, no dense per-frame upload. Bake once, then play/scrub from the cache.

**Architecture:** A brick grid (16³ bricks) over the RG8 volume. Bake: generate each loop frame (existing `generateFrameData`), pack its active bricks into a shared **atlas 3D texture** and produce a small per-frame **indirection 3D texture** (macrocell → atlas brick slot, or empty). Playback: bind the atlas once, swap the tiny per-frame indirection, and the raymarch samples sparsely with empty-space skipping. Interactive (non-playing) editing keeps the Phase A dense direct-to-3D path untouched.

**Tech Stack:** TS, Vite, WebGL2/GLSL, Vitest. No new deps. No WebGPU/native.

**Spec:** [docs/superpowers/specs/2026-07-26-vol3d-sparse-anim-cache-design.md](../specs/2026-07-26-vol3d-sparse-anim-cache-design.md)

## Global Constraints
- No new deps. Zero `any`. No `as never`. Web + Tauri (pure WebGL2).
- **Dense path is sacred:** interactive (non-playing) generation + preview must be byte-identical (the sparse path is playback-only, behind a mode flag).
- Sparse render must be **visually identical** to the dense render of the same frame (lossless within the active-brick threshold).
- Volume stays RG8. No schema/preset change (cache is runtime-only, not serialized).
- Green build + test before commit. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure
New:
- `src/core/volume/brickPack.ts` (+ `.test.ts`) — pure brick packing / indirection / reconstruct (TDD foundation).
- `src/core/volume/BrickCache.ts` — GPU-resident atlas + per-frame indirection textures; build from packer output; bind for playback; destroy.

Modified:
- `src/core/renderer/VolumeGenerator.ts` — expose per-frame dense RG generation for the bake (reuse `generateFrameData`).
- `src/ui/viewport/AnimationController.ts` — bake the sparse cache on play; play/scrub from it (nearest frame); invalidate on edit; replace the per-frame-regen fallback.
- `src/ui/viewport/Viewport.ts` — own the `BrickCache`; bind atlas+indirection and set sparse-mode uniforms in the render paths; free on destroy/context-loss.
- `src/shaders/preview/raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl` — sparse sampling mode (indirection→atlas, empty-space skip) behind `u_sparseEnabled`; dense path unchanged.
- `src/core/renderer/ShaderCompiler.ts` — inject the shared sparse-sampling GLSL helper.
- `src/core/constants.ts` — brick size, max loop frames, VRAM budget.

---

## Task 1: Pure brick packer + indirection + reconstruct (TDD)

**Files:** Create `src/core/volume/brickPack.ts`, `src/core/volume/brickPack.test.ts`

**Interfaces:**
- Produces:
  - `BRICK = 16` (brick edge).
  - `type PackedFrame = { indirection: Uint8Array /* RGBA per macrocell: rgb=brick slot xyz, a=255 active|0 empty */ }`.
  - `class AtlasBuilder { constructor(brick: number); bricksUsed: number; data(atlasDimsInBricks): Uint8Array /* RG atlas */ ; ... }` — accumulates unique active bricks across frames.
  - `packFrame(dense: Uint8Array /* RG, res*res*depth*2 */, res: number, depth: number, builder: AtlasBuilder, threshold: number): PackedFrame` — scans macrocells; a brick is active if any voxel's density(`.r`) or heat(`.g`) > threshold; copies active bricks into the builder (dedup optional; v1 may append per frame), writes the indirection.
  - `reconstruct(atlas: Uint8Array, atlasDimsInBricks: [number,number,number], packed: PackedFrame, res: number, depth: number, brick: number): Uint8Array` — rebuild the dense RG frame from atlas+indirection (empties → 0). For tests + parity.

- [ ] **Step 1: Failing round-trip test**

`brickPack.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { AtlasBuilder, packFrame, reconstruct, BRICK } from './brickPack'

// tiny volume: res=32, depth=32 → macrocells 2x2x2 (BRICK=16)
function makeDense(res: number, depth: number, fill: (x:number,y:number,z:number)=>[number,number]) {
  const out = new Uint8Array(res*res*depth*2)
  for (let z=0; z<depth; z++) for (let y=0; y<res; y++) for (let x=0; x<res; x++) {
    const i = (z*res*res + y*res + x)*2; const [d,h]=fill(x,y,z); out[i]=d; out[i+1]=h
  }
  return out
}
describe('brickPack round-trip', () => {
  it('reconstructs active bricks exactly and zeros empty ones', () => {
    const res=32, depth=32
    // one active brick: the (0,0,0) 16^3 corner has density 200
    const dense = makeDense(res, depth, (x,y,z)=> (x<16&&y<16&&z<16)?[200,50]:[0,0])
    const builder = new AtlasBuilder(BRICK)
    const packed = packFrame(dense, res, depth, builder, 0)
    const atlasDims: [number,number,number] = [Math.max(builder.bricksUsed,1),1,1]
    const recon = reconstruct(builder.data(atlasDims), atlasDims, packed, res, depth, BRICK)
    // active corner preserved
    expect(recon[0]).toBe(200); expect(recon[1]).toBe(50)
    // an empty region is zero
    const j = ((20*res*res)+(20*res)+20)*2
    expect(recon[j]).toBe(0); expect(recon[j+1]).toBe(0)
    // exactly 1 active brick out of 8 macrocells
    expect(builder.bricksUsed).toBe(1)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npm run test`).

- [ ] **Step 3: Implement `brickPack.ts`** — macrocell grid = `ceil(res/BRICK)²×ceil(depth/BRICK)`; scan each macrocell for any voxel over threshold; active → copy the brick's voxels into the next atlas slot (builder appends; slot xyz = linear index mapped into `atlasDimsInBricks`), write indirection texel `[slotX,slotY,slotZ,255]`; empty → `[0,0,0,0]`. `reconstruct` inverts it. Keep indices exact (careful with res/depth not multiples of BRICK — clamp/pad edge bricks).

- [ ] **Step 4: Run → PASS** (`npm run test`). Add a 2nd test: two frames with different active bricks accumulate in the builder; each reconstructs its own frame.

- [ ] **Step 5: Constants + commit**
Add `BRICK_SIZE=16`, `ANIM_LOOP_FRAMES_DEFAULT=32`, reuse `ANIMATION_CACHE_BUDGET_BYTES` as the atlas VRAM cap in `constants.ts`.
```bash
git add -A && git commit -m "feat: pure sparse brick packer + indirection + reconstruct (TDD)"
```

---

## Task 2: BrickCache — GPU atlas + indirection textures

**Files:** Create `src/core/volume/BrickCache.ts`; modify `src/core/constants.ts`

**Interfaces:**
- Consumes: `brickPack` (Task 1).
- Produces: `class BrickCache { constructor(gl); build(frames: {atlas:Uint8Array, atlasDims:[number,number,number], indirections: Uint8Array[]}, res, depth): void; bindForFrame(index: number, atlasUnit: number, indirUnit: number): void; readonly frameCount: number; readonly atlasDimsInBricks: [number,number,number]; readonly macroDims: [number,number,number]; destroy(): void }`.
- One RG8 3D **atlas** texture (dims = atlasDimsInBricks × BRICK). N RGBA8 3D **indirection** textures (dims = macroDims). NEAREST filtering on indirection (exact slot lookup); atlas uses LINEAR within bricks (see Task 4 caveat on brick-edge filtering — v1 may use NEAREST atlas to avoid cross-brick bleed, note it).

- [ ] **Step 1:** Implement allocation/upload/bind/destroy following the existing `VolumeTexture` GL patterns (texStorage3D/texImage3D, CLAMP_TO_EDGE). Guard framebuffer/texture creation; free all in `destroy()`.
- [ ] **Step 2:** Build + `npm run test` (no new unit test needed; covered by Task 1 + later parity smoke). Confirm no leaks (textures created once per build, freed on rebuild/destroy).
- [ ] **Step 3: Commit** `feat: BrickCache GPU atlas + per-frame indirection textures`

---

## Task 3: Bake pipeline (generate loop → sparse cache)

**Files:** Modify `src/ui/viewport/AnimationController.ts`, `src/ui/viewport/Viewport.ts`, `src/core/renderer/VolumeGenerator.ts`

**Interfaces:** Consumes `generateFrameData(phase) → Uint8Array (RG)` (existing), `brickPack`, `BrickCache`.

- [ ] **Step 1:** In AnimationController, add `buildSparseCache()`: for `i` in `0..N-1`, `phase=i/N`, `await generateFrameData(...)` → `packFrame` into a shared `AtlasBuilder` + collect indirections; then `brickCache.build(...)`. Reuse the existing build-id/cancel pattern (invalidate supersedes an in-flight bake). Report progress via the existing `generating`/`progress` state (or gen-indicator). Cap `N` and atlas size to the VRAM budget (skip/clamp with a `log()`-style note if exceeded — no silent truncation).
- [ ] **Step 2:** Trigger: on play-start (and when settled after an edit while playing), build the cache; on edit, invalidate it. Wire `Viewport` to own the `BrickCache` and pass it in.
- [ ] **Step 3:** Build + test; manual/Playwright smoke: entering play bakes (progress shows) then the cache exists (frameCount>0). Commit `feat: bake animation loop into the sparse brick cache`.

---

## Task 4: Sparse raymarch sampling + empty-space skip

**Files:** Modify `raymarch.frag.glsl`, `slice.frag.glsl`, `projection.frag.glsl`, `ShaderCompiler.ts`, `Viewport.ts`

**Interfaces:** new uniforms `uniform bool u_sparseEnabled; uniform sampler3D u_atlas; uniform sampler3D u_indirection; uniform vec3 u_macroDims; uniform vec3 u_atlasDimsBricks;`. Shared GLSL helper `sampleSparse(vec3 volumePos) -> vec2 (density,heat)` injected via ShaderCompiler.

- [ ] **Step 1:** Implement `sampleSparse`: `mc = floor(volumePos * u_macroDims)`; `ind = texelFetch/‌texture(u_indirection, (mc+0.5)/u_macroDims)`; if `ind.a < 0.5` return `vec2(0.0)` (empty); else `slot = ind.rgb * 255.0` (brick xyz); `local = fract(volumePos * u_macroDims)`; `atlasCoord = (slot + local) * BRICK / (u_atlasDimsBricks*BRICK)`; return `texture(u_atlas, atlasCoord).rg`. Use NEAREST atlas sampling in v1 to avoid cross-brick filtering bleed (note as a known v1 limitation; brick apron/padding is a later refinement).
- [ ] **Step 2:** In each preview shader, when `u_sparseEnabled` sample via `sampleSparse(volumePos)` instead of `texture(u_volume, volumePos).rg`; everything after (shaping, smoke/glow emission, opacity) unchanged. When `!u_sparseEnabled` the current dense path is byte-identical. Add empty-space skip: if `sampleSparse` returns empty for the macrocell, the ray can advance (optimization; correctness first).
- [ ] **Step 3:** Viewport sets `u_sparseEnabled` + binds atlas/indirection (from BrickCache for the current frame) during sparse playback; false otherwise.
- [ ] **Step 4:** Build + test; **parity smoke (real-GPU Playwright):** a baked sparse frame renders **visually identical** to the dense render of the same phase (screenshot diff ~0 over active regions). Commit `feat: sparse brick sampling in preview with empty-space skip`.

---

## Task 5: Playback from the sparse cache + FPS win

**Files:** Modify `src/ui/viewport/AnimationController.ts`, `Viewport.ts`

- [ ] **Step 1:** Replace the playing-case fallback (`cacheFrameCount<2 → onNeedsGeneration()` per frame) with: if a sparse cache exists, advance phase and select the **nearest** cached frame (bind its indirection) — no regen. Keep the dense interactive path for non-playing/scrub-without-cache.
- [ ] **Step 2:** Invalidate the sparse cache on layers/settings edits (rebuild on next play/settle). Ensure context-restore rebuilds/clears it (mirror Phase A patterns).
- [ ] **Step 3:** Build + test; **FPS smoke (real-GPU Playwright):** measure playback FPS at 256³ and 512³ with the sparse cache vs the old per-frame-regen baseline — expect a large improvement (target smooth ≥ intended fps). Interactive editing unchanged. Commit `feat: play animation from the sparse cache (no per-frame regen)`.

---

## Self-Review Notes
- **Spec coverage:** packer/indirection/reconstruct → T1; GPU cache → T2; bake → T3; sparse sampling+skip → T4; playback → T5. Testing (round-trip unit + parity/FPS smoke) mapped.
- **Dense-path-sacred:** all sparse behavior is behind `u_sparseEnabled` / playback-only; interactive dense generation + preview untouched (T4 keeps the `!u_sparseEnabled` branch byte-identical).
- **Lossless:** reconstruct round-trip test (T1) guarantees active bricks are exact; parity smoke (T4) guarantees sparse render == dense.
- **Known v1 limitations (noted, not silent):** NEAREST atlas sampling (no brick-apron → possible seams at brick borders under linear filtering — v1 uses nearest; apron padding is a follow-up); bake is a one-time cost (WebGPU compute deferred); nearest-frame playback (interpolation deferred).
- **Deferred:** temporal interpolation, on-disk gzip, WebGPU/BC-ASTC, native — per spec.
