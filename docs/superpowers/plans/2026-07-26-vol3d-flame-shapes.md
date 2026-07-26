# Vol3D — Flame Shape Pack (Plume / Capsule / Cylinder) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Add three elongated SDF primitive source layers — **Plume** (tapered flame), **Capsule** (rounded column), **Cylinder** (capped column) — so users can build more fire-/smoke-like base shapes. Same pattern as the existing SDF Sphere/Box/Cone.

**Architecture:** Each shape is a new `NoiseType` member whose GLSL `noiseEval(vec3 p)` returns `1 - smoothstep(0, softness, signedDistance)` (identical convention + `#define SDF_SOURCE` centering as the existing SDF sources). They reuse `radius`/`softness` and add a shared `height` param. TS-mirrored distance functions with a parity test (like `sdfField.ts`). Compose with noise erosion + smooth-min like existing SDF layers.

**Tech Stack:** TS, Vite, WebGL2/GLSL, Vitest. No new deps.

## Global Constraints
- No new deps. Zero `any`. No `as never`. Web + Tauri.
- Follow the existing SDF-source pattern exactly (VFX-0). Existing shapes/noise unchanged.
- `sdf` config gains `height` (default 1.0); existing sphere/box/cone ignore it (unchanged behavior). Validate/clamp + migrate + version bump (Phase A patterns).
- TS distance functions and their GLSL mirrors MUST be numerically identical (parity test enforces).
- Green build + test before commit. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: Plume / Capsule / Cylinder SDF sources

**Files:**
- Modify: `src/core/sdfField.ts` (+ `src/core/sdfField.test.ts`)
- Create: `src/shaders/noise/sdf_plume.glsl`, `sdf_capsule.glsl`, `sdf_cylinder.glsl`
- Modify: `src/types/noise.ts` (NoiseType members + `sdf.height`), `src/state/AppState.ts` (`DEFAULT_SDF` gains `height:1`), `src/core/renderer/ShaderCompiler.ts` (register snippets + `u_sdfHeight` inject), `src/core/renderer/VolumeGenerator.ts` (set `u_sdfHeight`), `src/utils/colorMap.ts` (labels/colors), `src/ui/panels/PropertiesPanel.ts` (Height slider for SDF layers), `src/state/presetValidation.ts` + `src/state/stateMigration.ts` (height clamp/default + version bump)

**Interfaces:**
- Produces: `NoiseType.SdfPlume='sdf_plume'`, `SdfCapsule='sdf_capsule'`, `SdfCylinder='sdf_cylinder'`; `sdf.height: number`; `plumeField/capsuleField/cylinderField(p, radius, softness, height): number`. `isSdfSource` returns true for the new members.

- [ ] **Step 1: Failing parity test**

Add to `src/core/sdfField.test.ts` (p centered, along +Y; `h` = height as half-extent):
```ts
import { plumeField, capsuleField, cylinderField } from './sdfField'
describe('elongated sdf fields', () => {
  it('capsule: solid on axis within height, empty far out', () => {
    expect(capsuleField([0,0,0], 0.2, 0.05, 0.6)).toBeCloseTo(1, 6)   // center inside
    expect(capsuleField([0,0.6,0], 0.2, 0.05, 0.6)).toBeCloseTo(1, 6)  // top cap surface (sd≈0)
    expect(capsuleField([0.5,0,0], 0.2, 0.05, 0.6)).toBe(0)           // far radial
  })
  it('cylinder: solid inside r&h, empty beyond the flat cap', () => {
    expect(cylinderField([0,0,0], 0.2, 0.05, 0.5)).toBeCloseTo(1, 6)
    expect(cylinderField([0,0.9,0], 0.2, 0.05, 0.5)).toBe(0)          // above cap+softness
  })
  it('plume: fat base, narrow top, values in [0,1]', () => {
    const base = plumeField([0,-0.5,0], 0.3, 0.05, 0.5)
    const top  = plumeField([0.2,0.5,0], 0.3, 0.05, 0.5)             // 0.2 out near narrow tip
    expect(base).toBeGreaterThan(top)
    for (const v of [base, top]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npm run test`).

- [ ] **Step 3: Implement the three fields in `sdfField.ts`** (reuse the existing `smoothstep`/`field` helpers; `h = Math.max(height, 1e-4)` as half-height):
```ts
export function capsuleField(p: Vec3, radius: number, softness: number, height: number): number {
  const h = Math.max(height, 1e-4)
  const cy = Math.max(-h, Math.min(h, p[1]))
  const d = Math.hypot(p[0], p[1] - cy, p[2]) - radius
  return field(d, softness)
}
export function cylinderField(p: Vec3, radius: number, softness: number, height: number): number {
  const h = Math.max(height, 1e-4)
  const dx = Math.hypot(p[0], p[2]) - radius
  const dy = Math.abs(p[1]) - h
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  return field(outside + inside, softness)
}
export function plumeField(p: Vec3, radius: number, softness: number, height: number): number {
  // tapered capsule: radius shrinks linearly base->top (flame silhouette)
  const h = Math.max(height, 1e-4)
  const t = Math.max(0, Math.min(1, (p[1] + h) / (2 * h)))  // 0 base, 1 top
  const rr = radius * (1 - 0.85 * t)                        // taper to 15%
  const cy = Math.max(-h, Math.min(h, p[1]))
  const d = Math.hypot(p[0], p[1] - cy, p[2]) - rr
  return field(d, softness)
}
```

- [ ] **Step 4: Run → PASS** (`npm run test`).

- [ ] **Step 5: GLSL mirrors** — `sdf_capsule.glsl`/`sdf_cylinder.glsl`/`sdf_plume.glsl` each define `float noiseEval(vec3 p)` reading `uniform float u_sdfRadius, u_sdfSoftness, u_sdfHeight;` with math IDENTICAL to the TS (e.g. capsule: `float h=max(u_sdfHeight,1e-4); float cy=clamp(p.y,-h,h); float d=length(vec3(p.x,p.y-cy,p.z))-u_sdfRadius; return 1.0-smoothstep(0.0,max(u_sdfSoftness,1e-4),d);`).

- [ ] **Step 6: Register + schema + uniforms + UI**
  - `types/noise.ts`: add the 3 `NoiseType` members; add `height: number` to the `sdf` config; `isSdfSource` covers them.
  - `AppState.ts` `DEFAULT_SDF`: add `height: 1.0`.
  - `ShaderCompiler`: add the 3 snippets to `NOISE_SNIPPETS`; ensure `u_sdfHeight` is available (inject/declare like `u_sdfRadius`).
  - `VolumeGenerator`: set `u_sdfHeight` from `layer.noise.sdf.height` in the same conditional block that sets `u_sdfRadius`/`u_sdfSoftness`.
  - `colorMap.ts`: `NOISE_LABELS`/`NOISE_COLORS` entries ("SDF Plume"/"SDF Capsule"/"SDF Cylinder").
  - `PropertiesPanel.ts`: add a **Height** slider (min 0.1, max 2, step 0.01, default 1, decimals 2) alongside Radius/Softness in the `isSdfSource` block (writes `sdf.height`). Shown for all SDF shapes (harmless for sphere/box/cone; or gate to the 3 elongated ones — implementer's call, note it).
  - `presetValidation.ts`/`stateMigration.ts`: clamp `sdf.height` (0.1..2, default 1), default on absent; bump `CURRENT_PRESET_VERSION`.

- [ ] **Step 7: Build + test + smoke**

`npm run build && npm run test`. Then `npm run dev` (5174): add a layer, Noise Type → **SDF Plume** → a tapered flame shape (fat base, narrow top); Capsule → rounded column; Cylinder → flat-capped column. Height slider elongates them; Radius/Softness work; a noise layer on Multiply erodes; smooth-min merges two shapes. (Real-GPU Playwright smoke if feasible, per precedent.)

- [ ] **Step 8: Commit**
```bash
git add -A
git commit -m "feat: elongated SDF flame shapes (plume/capsule/cylinder) with height param"
```

## Self-Review Notes
- Coverage: 3 shapes + height param + parity tests + validation/migration/UI — the approved "shapes only" scope. Turbulence/wind/taper deliberately deferred (VFX-2 bundle).
- Parity: TS fields mirrored exactly in GLSL; test guards drift. `height` floored to avoid divide/degenerate at 0.
- No-regression: existing sphere/box/cone + all noise unchanged; `height` additive with a default that doesn't affect them.
