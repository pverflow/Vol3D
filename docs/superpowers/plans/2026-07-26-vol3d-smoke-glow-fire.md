# Vol3D — Smoke + Glow Fire Model (VFX-1 UX fix) — Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Make a plume + noise erosion "just look like fire" out of the box. Fix the VFX-1 heat model's two UX failures: (1) cold/low-heat dense regions render as **visible dark smoke** (occluding), not invisible; (2) heat adds **fire emission on top**; (3) a sensible default **Temperature** so raising it lands in the ramp's orange/red midrange, not saturated white.

**Root cause (diagnosed, not a bug):** the preview currently emits `ramp(heat).rgb * ramp(heat).a` only; with default temperature 0 (heat 0) and the Fire ramp's transparent heat=0 stop, cold dense voxels contribute no color yet consume transmittance → invisible. And `heat = density × temperature` saturates to ~1 on solid SDF cores at temperature 1 → ramp's white top.

**Architecture:** In the ramp-ENABLED preview branch, composite a dark **smoke base** (from density, lightly shaded like the grayscale path but dark) PLUS additive **emission** from `ramp(heat)`. Ramp-DISABLED branch stays byte-identical (current grayscale). Default `temperature` 0 → 0.5. No pipeline/storage change.

## Global Constraints
- No new deps. Zero `any`. No `as never`. Web + Tauri.
- Ramp-OFF preview byte-identical (no regression). Density/heat storage + generation unchanged.
- Green build + test. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 1: Smoke + glow emission model + default temperature

**Files:**
- Modify: `src/shaders/preview/raymarch.frag.glsl`, `src/shaders/preview/slice.frag.glsl`, `src/shaders/preview/projection.frag.glsl`
- Modify: `src/state/AppState.ts` (`defaultLayer` temperature 0 → 0.5)

**Interfaces:** none new (shader-internal + one default value).

- [ ] **Step 1: Raymarch smoke+glow (ramp-ON branch only)**

Replace the current ramp-enabled block in `raymarch.frag.glsl` (the `if (u_colorRampEnabled) { ... }` body) so that, per sampled voxel with `density > 0.001`:
- `alpha = 1.0 - exp(-density * stepSize * EXTINCTION_SCALE)` (unchanged).
- **Smoke base:** reuse the cheap 1-tap light already used in the grayscale branch (sample density slightly toward `u_lightDir`, compute `shadow`), but mix DARK smoke colors: `vec3 SMOKE_SHADOW = vec3(0.015,0.015,0.02); vec3 SMOKE_LIT = vec3(0.16,0.16,0.18); vec3 smoke = mix(SMOKE_SHADOW, SMOKE_LIT, clamp(shadow,0.0,1.0));` — so cold dense = visible dark grey, shaded for form.
- **Emission:** `vec4 ramp = texture(u_colorRamp, vec2(heat, 0.5)); vec3 emission = ramp.rgb * ramp.a * EMISSION_GAIN;` with `const float EMISSION_GAIN = 3.0;` (glow reads over smoke; tunable).
- `vec3 voxelColor = smoke + emission; accumulatedColor += voxelColor * alpha * transmittance; transmittance *= (1.0 - alpha);`

Net: cold dense → dark smoke (visible); hot → fire glow added on top. Keep the `else` (ramp-disabled) branch EXACTLY as-is.

- [ ] **Step 2: Slice + projection smoke+glow**

In `slice.frag.glsl` / `projection.frag.glsl` ramp-ENABLED path: show a dark smoke grey from shaped density plus additive `ramp(heat).rgb * ramp(heat).a * EMISSION_GAIN`, so these plane views are consistent (cold=dark, hot=glow). Ramp-disabled path unchanged. (No lighting needed for the plane views — a flat dark smoke `mix(0.02, 0.18, shapedDensity)` grey is fine, plus emission.)

- [ ] **Step 3: Default temperature 0.5**

`AppState.ts` `defaultLayer`: `temperature: 0.5` in the noise object. (New layers warm by default → colored in the ramp midrange; existing presets keep their stored temperature.) No schema/version change.

- [ ] **Step 4: Build + test + smoke**

`npm run build && npm run test` (52+ tests still green; no unit change expected). Then a real-GPU headless Playwright smoke (scratch, no repo deps): a Plume (default temp 0.5) with Fire ramp ON renders a **visible dark-to-orange flame** (not invisible, not white); adding a Perlin Subtract layer erodes it and it STAYS visibly colored; raising temperature → hotter/brighter core; ramp OFF → grayscale identical to before. Capture screenshots. Be HONEST if a live smoke wasn't run.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "feat: smoke+glow fire model (cold=dark smoke, heat=emission) + warm default temperature"
```

## Self-Review Notes
- Addresses both diagnosed causes: cold regions visible (smoke base) + colorful default (temp 0.5 keeps heat in ramp midrange, not white).
- Ramp-OFF grayscale untouched (no regression). Generation/storage/heat untouched.
- `EMISSION_GAIN`/`SMOKE_*` constants are tunable — the user will eyeball and we adjust if too dark/bright.
- Task 4 (baked RGBA8 export) should later bake to MATCH this smoke+glow look (note for that task).
