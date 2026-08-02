# Running the v3 PoC — Noise & SDF Library

## Generation Primitives: Noise & Shape

Build volumetric scenes from an expanded noise library and SDF shape toolkit, achieving **v2 feature parity**.

### Noise Types

**Core noises** (all now support animation via **Evolutions** slider):
- **Value** — lattice-based, smooth
- **Perlin** — gradient-based, classic 2D/3D
- **Simplex** — improved perlin, smoother
- **Worley** (NEW) — cellular/Voronoi-seeded distance field
  - **Mode selector (F1 / F2 / F2−F1):**
    - **F1** — distance to nearest cell center (classic Voronoi diagram seed)
    - **F2** — distance to second-nearest center
    - **F2−F1** — difference; reveals cell edges & boundaries
- **Voronoi** (NEW) — cell-edge pattern (1 - F1, emphasizing edges)
- **White** (NEW) — per-voxel static random (GPU-side hash; varies frame-to-frame if seeded)

**Base for FBM (Fractional Brownian Motion):**
All noise types above can now serve as the **FBM base** (not just Simplex). Select FBM as the noise type, then pick the base: Value / Perlin / Simplex / Worley / Voronoi / White.

### SDF Shapes

Signed Distance Functions for volumetric sculpting; all parameterized by **Radius** and **Softness**:
- **Sphere** — existing baseline
- **Box** (NEW) — axis-aligned box; **Radius** controls half-extent
- **Cone** (NEW) — radial cone; **Radius** = base radius, height = 2×Radius (or use new **sdf_height** field for custom height)
- **Capsule** (NEW) — sphere swept along an axis; **Radius** = sphere radius, **sdf_height** = axis length
- **Cylinder** (NEW) — infinite cylinder; **Radius** = radius, **sdf_height** = height
- **Plume** (NEW) — tapered cylinder (cone → capsule hybrid); **Radius** and **sdf_height** both respected

**Note:** `sdf_height` is a new optional parameter (currently internal to the layer). Box shapes ignore it (use Radius only); Cone, Capsule, Cylinder, and Plume all use it for custom proportions.

### UI & Controls

**Noise group** now includes:
- **Noise type:** combo (Value, Perlin, Simplex, **Worley, Voronoi, White**, FBM, **SdfBox**, **SdfCone**, **SdfCapsule**, **SdfCylinder**, **SdfPlume**)
- **FBM params** (when Noise = FBM): Octaves, Persistence, Lacunarity, **Base selector** (Value / Perlin / Simplex / Worley / Voronoi / White)
- **Worley Mode** (when Noise = Worley): combo (F1, F2, F2−F1)
- **SDF params** (when Noise = Sdf*): Radius, **sdf_height** (for Cone / Capsule / Cylinder / Plume; Box ignores it)

The rest of the layer UI (Transform, Remap, Color, Blend mode, Gradient editor) remains unchanged.

### Distortion

Per-layer **Distortion** section in the Properties panel (v2 parity + v3 improvements):
- **Type:** combo (None, Domain Warp, Curl, Swirl, Polar, **Turbulence**)
  - **None** — default; no distortion applied
  - **Domain Warp** — wobbles the domain via noise, causing a liquid-like displacement
  - **Curl** — divergence-free swirling flow (based on curl noise)
  - **Swirl** — twists around the Y axis by height, creating a helical effect (now orientable via **Distortion Rotation**)
  - **Polar** — Cartesian→polar coordinate remap, remapping the domain radially (now orientable via **Distortion Rotation**)
  - **Turbulence** — multi-octave domain warp, simulating flowing turbulence; particularly effective on SDF shapes
- **Strength** (0–2) — scales the distortion magnitude (shown when type ≠ None)
- **Warp Noise** (shown when type ∈ {Domain Warp, Curl, Turbulence}): noise type that drives the warp (Value, Perlin, Simplex, Worley, Voronoi, White). **Critical for SDF shapes** (e.g., cone, box) which have flat underlying fields; choosing a Warp Noise enables domain displacement. For procedural noise layers, using their own field; for SDFs, Warp Noise provides the distortion source.
- **Distortion Rotation X/Y/Z** (degrees, shown when type ≠ None) — orients the distortion field on any axis. **Swirl** (normally Y-axis twist) and **Polar** (normally radial on XZ plane) can now act on any orientation.
- **Warp Offset X/Y/Z** (range −10..10, shown when type ∈ {Domain Warp, Curl, Turbulence}) — shifts where the warp field is sampled, scrolling or advecting the distortion field. **Keyframable** (has the ◆ stopwatch). Key use: keyframe **Warp Offset Z** (or X/Y) from 0 to a few units over the loop to make a **Turbulence-distorted flame drift like wind** while looping smoothly. Offset 0 = no change (default; existing scenes unaffected).
- **Warp Freq** (0.5–10) — domain frequency for **Domain Warp** only
- **Swirl Amt** (−5..5) — twist amount for **Swirl** only
- **Octaves** (1–8, shown when type = **Turbulence**) — fractal depth; higher octaves add finer detail to the turbulence field

Each distortion type warps the noise layer before rendering, enabling domain-based visual effects beyond simple coordinate transforms. The **Warp Noise** field enables distortion to work on SDF shapes (previously had no effect).


## Volume Box Dimensions (Non-Cubic)

Set the volume box to any rectangular aspect ratio using **three independent power-of-2 dimensions**:
- **Box X / Y / Z:** each selectable from {32, 64, 128, 256, 512}
- Example: **64 × 64 × 256** renders a box 4× taller than wide

### Rendering & Cubic Voxels

The box renders with its true aspect — all voxels are cubic (same size in X/Y/Z world units), so:
- An **SDF sphere** layer stays a sphere (no vertical or horizontal stretch)
- Noise and shapes preserve their true proportions; a tall box just shows more vertical extent of the content
- Use per-layer **Scale** to deliberately stretch content for artistic effect

### VRAM & Playback Cache

- **VRAM readout** in the UI displays `box X×Y×Z — MB/frame`
- **Playback cache** auto-reduces all three axes together (preserving aspect) to fit the **4 GB budget**; watch the VRAM readout as you adjust dimensions
- **[128, 128, 128]** produces the same output as the previous cubic 128 resolution (identical)

### Identity Case

`[128, 128, 128]` is cubic. Verify it looks identical to any previously saved scene using the old cubic-128 resolution.


## Keyframe Animation (SP1)

Animate any numeric parameter across the timeline with frame-accurate keyframing.

### Basic workflow

Every numeric parameter in the Properties panel now has a **stopwatch toggle** beside it:
- **◇** (off): parameter is not animated; static value used everywhere
- **◆** (on): parameter is animated; a small number shows how many keyframes are set

To animate a parameter:
1. Click **◇** to enable animation (becomes **◆**); a keyframe is immediately created at the current **Phase** (playhead position), using the current value
2. Move the **Phase** slider to a different position in the loop (0–1)
3. Change the parameter value in the slider/input
4. A new keyframe is automatically added at this Phase with the new value
5. Repeat steps 2–3 to add more keyframes across the timeline
6. Press **Play** to see the parameter interpolate (linear) smoothly across all keyframes

**Scrubbing the Phase slider** shows the interpolated state live — all animated parameters update their values, and the viewport renders the interpolated scene in real time.

### Evolutions default change

**Evolutions** now defaults to **0 (off)**. In earlier v3 cycles, Evolutions drove a built-in domain-swirl distortion on every noise layer; this is now **opt-in**. You can:
- Raise the **Evolutions** slider to re-enable the domain swirl
- Or animate any parameters instead (or both — multiple animations compose)
- Un-animated scenes look the same as before, aside from no longer applying the default swirl

### Composing animations

Multiple animated parameters compose naturally:
- Animate **Opacity** and **Offset** on the same layer → both interpolate together across the loop
- Animate parameters on different layers → each animates independently, and their blended output is rendered
- Animate the same **Noise** and **Distortion** parameters → both affect the layer's final appearance

### Deferred

This is **SP1 (foundation)** of a 4-part timeline roadmap. Still coming:
- **SP2:** Visual track lanes — drag keyframe dots directly on the timeline; see parameter curves over time
- **SP3:** Value curves — edit interpolation mode per keyframe (Bezier, hold, step)
- **SP4:** Color / enum tracks — animate gradient colors and mode selectors

Export and presets are also in the pipeline.


## What to report back

### Non-Cubic Volume Box

Verify the non-cubic volume box works correctly:

1. **[128, 128, 128] looks identical to before?**
   - Load or recreate a scene using the default cubic **[128, 128, 128]** box.
   - Compare the output to a scene from before this release (cubic-128 baseline).
   - Should look visually identical.
   - Report: Does the cubic-128 output match the previous version?

2. **[64, 64, 256] renders a tall box with undistorted geometry?**
   - Set the box to **64 × 64 × 256** (4× taller than wide).
   - Create a layer with an **SDF Sphere** (Noise type: SdfSphere, Radius ~20).
   - The sphere should stay a sphere, **not stretched vertically**.
   - Create a second layer with **Simplex** or **Perlin** noise.
   - The noise should extend **4× taller** vertically, showing more layers of detail along the tall axis.
   - Report: Does the tall box render a round sphere and vertically-extended noise (no vertical squash or stretch)?

3. **Non-cubic box bakes + plays, cache auto-reduces, VRAM readout sane?**
   - Set the box to a non-cubic dimension (e.g., **128 × 64 × 256**).
   - Press **Bake** and verify the generation completes.
   - Press **Play** and verify animation/playback runs smoothly.
   - Watch the **VRAM readout** in the UI (displayed as `box X×Y×Z — MB/frame`).
   - If you set a very large box (e.g., **512 × 512 × 512**), the cache should auto-reduce all axes proportionally to fit the 4 GB budget; observe the VRAM drop.
   - Report: Does bake/play work? Does the VRAM readout show sensible values and auto-reduce on large boxes?

4. **No occupancy holes/clipping on tall boxes during render or playback?**
   - Create a tall box (e.g., **64 × 64 × 256**) with multiple noise layers.
   - During **rendering** (editing mode), watch the viewport for any visual gaps, holes, or clipped voxels.
   - Press **Play** and watch the **playback rendering** — same check for gaps or clipping.
   - Report: Do the tall boxes render without occupancy holes or unexpected clipping in both render and playback modes?

5. **Editing (paused) and playback show the same box shape?**
   - Set a non-cubic box (e.g., **128 × 128 × 256**).
   - In **editing/paused mode**, note the box aspect in the viewport.
   - Press **Play** to enter playback mode.
   - Pause again and compare the box shape. Should be identical (same width, height, depth).
   - Report: Does editing and playback show the same non-cubic box shape, or do they differ?

### Generation Primitives (Noise & SDF)

Verify the new generation primitives work correctly:

6. **New noise types render & look distinct?**
   - Create a layer with **Worley** noise. Do you see a clear cellular pattern (Voronoi diagram)?
   - Try Worley **Mode: F1** vs **F2** vs **F2−F1**. Each should look visually distinct (F1 = seeds, F2 = second-nearest, F2−F1 = edges). Report what you see.
   - Create a layer with **Voronoi** noise. Should emphasize cell edges more than Worley F1.
   - Create a layer with **White** noise. Should be a grainy, per-voxel random static (no obvious patterns).

7. **Worley modes visibly differ?**
   - Set a **Worley** layer to **F1, F2, F2−F1** in sequence, keeping other params constant.
   - Do the three modes look distinctly different (not just a re-color)? Report texture differences you observe.

8. **SDF shapes render correctly, radius/height affect them?**
   - Try each shape: **Box, Cone, Capsule, Cylinder, Plume** (one layer per shape).
   - For each, adjust the **Radius** slider. Does the shape scale visually?
   - For **Cone, Capsule, Cylinder, Plume**, adjust **sdf_height** (if available in the UI). Does height change the shape proportions?
   - Does each shape render without artifacts or shader errors?

9. **Existing Value/Perlin/Simplex/FBM/Sphere scenes unchanged?**
   - Load or recreate a scene using only **Value, Perlin, Simplex, FBM (with any of the old bases), or SdfSphere**.
   - Compare the output visually to before this release. Should look identical.
   - Report any changes or regressions.

10. **FBM with new bases (Worley/Voronoi/White) works?**
    - Create a layer with **FBM**, then set the **Base** to **Worley** (or Voronoi or White).
    - Adjust **Octaves** and **Lacunarity**. Should see fractal layering of the cellular/edge/static pattern, not a crash or blank output.
    - Report whether the FBM looks correct and distinct from the base noise.

11. **Distortion now works on SDF shapes: Domain Warp / Curl / Turbulence + Warp Noise?**
    - Create a **Cone** (SDF shape) layer.
    - Set distortion **Type** to **Domain Warp**, pick a **Warp Noise** (e.g., **Simplex**), raise **Strength** to 1.0+.
    - Does the cone visibly warp? (Previously, SDF shapes had no distortion response.)
    - Try **Domain Warp**, **Curl**, and **Turbulence** types. All should warp the cone.
    - Try different **Warp Noise** values (Value, Perlin, Simplex, Worley, Voronoi, White). Does each produce a distinct warp character?
    - Report: Does Domain Warp / Curl / Turbulence visibly warp a cone, and does Warp Noise change the character?

12. **Distortion Rotation X/Y/Z orient Swirl/Polar on any axis?**
    - Create a **Cone** layer, set distortion **Type** to **Swirl**, **Swirl Amt** = 2.5, **Strength** = 1.0.
    - Default (Rotation = 0, 0, 0): Swirl twists around the Y axis (helical on the cone).
    - Set **Distortion Rotation X** = 90°. Swirl should now twist around the X axis instead.
    - Try **Rotation Y** = 90° or **Rotation Z** = 90°. Verify reorientation each time.
    - Repeat for **Polar** distortion. Should reorient its radial field accordingly.
    - Report: Does Rotation X/Y/Z successfully reorient Swirl/Polar on a Y-aligned cone?

13. **Turbulence type produces flowing turbulence; Octaves adds detail?**
    - Create a noise layer with **Simplex** or **Perlin**.
    - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
    - Adjust **Octaves** from 1 to 8. Does higher Octaves add progressively finer turbulent detail?
    - Report: Does Turbulence look like flowing turbulence, and does Octaves add visible detail?

14. **Changing Warp Offset scrolls the turbulent detail?**
    - Create a noise layer with **Simplex** or **Perlin**.
    - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
    - Adjust **Warp Offset Z** (or X/Y) from 0 to 5–10. Does the turbulent field visibly scroll or shift?
    - Report: Does changing Warp Offset cause the warp field detail to shift/advect?

15. **Keyframing Warp Offset makes the pattern drift (wind motion)?**
    - Create a **Turbulence**-distorted noise layer (e.g., **Simplex** + Turbulence Type).
    - Enable animation on **Warp Offset Z** at **Phase** = 0.0 (value = 0.0).
    - At **Phase** = 1.0, set **Warp Offset Z** to 3–5 (creates a second keyframe).
    - Press **Play**. The turbulent pattern should smoothly drift over the loop (like wind blowing the flame sideways or along the Z axis).
    - Report: Does keyframing Warp Offset produce drifting/wind motion? Does the flame remain loopable (with hand-authored seamless wrapping via keyframes)?

16. **Warp Offset = 0 + existing scenes unchanged?**
    - Verify **Warp Offset X/Y/Z** all default to **0.0** (or very close).
    - Load or recreate a scene using **Domain Warp**, **Curl**, or **Turbulence** distortion with Warp Offset untouched (left at 0).
    - Compare the output to before this release. Should look identical.
    - Report: Does Warp Offset = 0 produce no visible change, and do existing scenes remain unaffected?

17. **Distortion type=None remains a no-op; existing scenes unchanged?**
    - Verify distortion **Type** = **None** is a true no-op (layer appearance unchanged).
    - Load or recreate an older v3 scene. Should look identical (all layers default to type=None).
    - Report: Does type=None remain a true no-op, and do existing scenes remain unaffected?

**Errors:**
- Paste any **egui, wgpu, or WGSL compilation error** from the native terminal or web console.
- Report any **visual artifacts** (z-fighting, NaN values, clipping) in the viewport.

### Keyframe Animation (SP1) verification

Verify keyframing and animation composition work correctly:

18. **Keyframing a parameter animates smoothly across the loop on Play?**
    - Create a layer with any noise type (e.g., **Simplex**).
    - Enable animation on **Opacity** by clicking ◇ (becomes ◆) at **Phase** = 0.0. Keep the value at 1.0.
    - Scrub **Phase** to 0.5. Set **Opacity** to 0.2. A second keyframe should be created.
    - Scrub to 1.0 and set **Opacity** back to 1.0. A third keyframe should be created.
    - Press **Play**. The layer's opacity should smoothly interpolate: 1.0 → 0.2 → 1.0 across the loop.
    - Report: Does the opacity animate smoothly and linearly across the keyframes?

19. **Multiple animated parameters compose?**
    - On the same layer, enable animation on **Offset X** (click ◇ at **Phase** = 0.0, value = 0.0).
    - At **Phase** = 0.5, set **Offset X** to 2.0 (creates a second keyframe).
    - At **Phase** = 1.0, set **Offset X** back to 0.0 (creates a third keyframe).
    - Also enable animation on **Opacity**: at Phase = 0.0, value = 1.0; at Phase = 0.5, value = 0.2; at Phase = 1.0, value = 1.0.
    - Press **Play**. Both **Offset X** and **Opacity** should animate at the same time.
    - Report: Do both parameters animate simultaneously? Does the layer move and fade as expected?

20. **Scrubbing Phase shows interpolated values live?**
    - With the animated layer from (19) above, pause playback (or start paused).
    - Drag the **Phase** slider from 0.0 to 1.0.
    - Watch the **Offset X** and **Opacity** sliders in the Properties panel.
    - The values should update smoothly as you scrub (not snap). The viewport should also render the interpolated scene in real time.
    - Report: Do the sliders and viewport update smoothly as you scrub Phase?

21. **Evolutions defaults to 0 (off) and re-enabling it works?**
    - Create a new scene or reset the existing one.
    - Check the **Evolutions** slider. It should start at **0.0** (or very close to 0).
    - Add a layer with **Simplex** noise. It should render without the domain-swirl distortion (clean noise field).
    - Raise **Evolutions** to 0.5 or higher. The noise field should now show the built-in swirl (visible distortion / warping).
    - Lower **Evolutions** back to 0. The swirl should disappear.
    - Report: Does Evolutions start at 0, and does raising/lowering it toggle the domain swirl on/off?

22. **Un-keyframed scenes look the same as before (aside from Evolutions off)?**
    - Load or recreate a scene using only non-animated parameters and **Evolutions** = 0.
    - Compare the output to a similar scene from an earlier v3 run (without keyframe animation).
    - They should look identical, except that **Evolutions** is no longer auto-applied.
    - Report: Do un-keyframed scenes render the same way, with no unexpected changes (other than Evolutions defaulting to 0)?

23. **Toggling ◆ off removes the animation?**
    - Create an animated layer (e.g., **Opacity** keyframed from 1.0 → 0.2 → 1.0 as in item 15).
    - Press **Play**. Verify the animation works.
    - Click the ◆ toggle next to **Opacity** to turn it off (becomes ◇).
    - Press **Play** again. The layer should now have a constant opacity (the slider's current value) and not animate.
    - Click ◆ again to re-enable. The animation should resume.
    - Report: Does toggling ◆ off freeze the animation and toggle ◇ back on resume it?

## Known this cycle

- **Worley/Voronoi GPU hash stability:** Worley and Voronoi use a fast hash (`hash13`) for cell seeding; results are consistent per voxel per frame, but the hash is not bit-exact across platforms. Expect minor visual differences between native and web.
- **White noise varies frame-to-frame:** White noise is re-hashed on each frame; to use it in a static (non-animated) scene, set **Evolutions** to 0. For animation, White will look like TV static transitioning over time (expected behavior).

## Deferred (not in this cycle)

**Non-cubic volume box** and **Distortion improvements** (Domain Warp, Curl, Swirl, Polar, Turbulence + Warp Noise + Rotation) are now **complete**.

Still to come:
- **Export:** Save/load preset layers, scene bundles, and animated sequences.
- **Presets:** Factory library of named FBM/Worley/Voronoi combinations, preset shape rigs.
- **Feather & remap curve UI:** Spline-based in/out remapping (beyond hard min/max sliders); feather/falloff for SDF blend softness.
- **Cutoff & contrast:** Hard clip and contrast scaling in the layer pipeline.
- **Slice & projection views:** Multi-plane slice views and 2D projection UI for easier inspection of volumetric data.

### Run paths

**Native:**
```bash
cd v3 && cargo run
```
Expect a window with the UI on left/right and viewport in the center. The terminal shows the "v3 adapter:" line (GPU backend, capabilities). Animation plays in the native window with the dense cache.

**Web (WebGPU):**
```bash
cd v3 && trunk serve        # (cargo install trunk, once)
```
Open the shown localhost URL in a WebGPU browser (Chrome/Edge/Safari 26). Same UI, same animation, same cache. If the canvas is blank, open devtools console for WebGPU/adapter errors.
