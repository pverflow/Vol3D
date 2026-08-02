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
- **Loop Offset** (toggle, shown when type ∈ {Domain Warp, Curl, Turbulence}) — determines whether the warp field scrolls infinitely or tiles. **Off (default):** the warp offset scrolls infinitely through non-repeating noise (as before); changing Warp Offset creates an endless advection. **On:** the warp field becomes tileable (uses a tileable Perlin regardless of the Warp Noise selector), and **Warp Offset is measured in loops** (0–1 = one full cycle). This enables **seamless loopable motion**: keyframe **Warp Offset** 0 → 1 over your animation loop, and the distortion drifts with no jump at the loop seam (e.g., a wind-scrolled flame that loops smoothly). Loop mode is useful for authored seamless animation.
- **Warp Freq** (0.5–10) — domain frequency for **Domain Warp** only
- **Swirl Amt** (−5..5) — twist amount for **Swirl** only
- **Octaves** (1–8, shown when type = **Turbulence**) — fractal depth; higher octaves add finer detail to the turbulence field

Each distortion type warps the noise layer before rendering, enabling domain-based visual effects beyond simple coordinate transforms. The **Warp Noise** field enables distortion to work on SDF shapes (previously had no effect).


## Volume Box Dimensions (Non-Cubic)

Set the volume box to any rectangular aspect ratio using **three independent power-of-2 dimensions**:
- **Box X / Y / Z:** each selectable from {32, 64, 128, 256, 512}
- Example: **64 × 64 × 256** renders a box 4× taller than wide

### Rendering & Cubic Voxels

The box renders with its true aspect using **min-normalized scaling** — all voxels are cubic (same size in X/Y/Z world units), so:
- An **SDF sphere** layer stays a sphere (no vertical or horizontal stretch) regardless of box aspect
- Growing one axis (e.g., Z from 128 to 256) **extends the box along that axis only**; the other sides keep their size
- Noise and shapes preserve their true proportions; a tall box just shows more vertical extent of the content
- The camera automatically stays **centered on and fitted to the box** — no clipping, no off-center pan
- There's **no camera jump or pop** when you change box dimensions; the camera and box move together smoothly
- Use per-layer **Scale** to deliberately stretch content for artistic effect

### VRAM & Playback Cache

- **VRAM readout** in the UI displays `box X×Y×Z — MB/frame`
- **Playback cache** auto-reduces all three axes together (preserving aspect) to fit the **4 GB budget**; watch the VRAM readout as you adjust dimensions
- **[128, 128, 128]** produces the same output as the previous cubic 128 resolution (identical)

### Identity Case

`[128, 128, 128]` is cubic. Verify it looks identical to any previously saved scene using the old cubic-128 resolution.


## Bounding-Box Wireframe

When working with the volume box, a **bounding-box wireframe** helps visualize dimensions:
- **Hover the viewport** → the volume's bounding-box wireframe appears as soft cyan lines, fading in/out smoothly.
- **Change a Box dimension** → the wireframe **flashes visibly for ~2 seconds then fades**, so you can see what changed.
- The wireframe **matches the actual box shape** (tall for `[64,64,256]`, cube for `[128,128,128]`). When you're not hovering and haven't just changed a dimension, the wireframe is invisible; the render looks exactly like before.

### Run paths

**Native:**
```bash
cd v3 && cargo run
```

**Web (WebGPU):**
```bash
cd v3 && trunk serve        # (cargo install trunk, once)
```

### What to report back

1. **Hovering the viewport shows the box wireframe and hides on leave?**
   - Hover the viewport. You should see the volume's bounding-box wireframe appear as soft cyan lines.
   - Move your mouse away from the viewport. The wireframe should fade out and disappear.
   - Report: Does hovering show the wireframe, and leaving hide it?

2. **Changing a Box dimension flashes the wireframe for ~2 s then fades?**
   - Adjust one of the **Box X / Y / Z** dimensions.
   - The wireframe should flash visibly, then fade over approximately 2 seconds.
   - Change a different dimension and observe the same behavior.
   - Report: Does changing a Box dimension flash the wireframe then fade?

3. **The wireframe matches the box shape (tall vs cube)?**
   - Set the box to **[64, 64, 256]** (4× taller).
   - The wireframe should render as a **tall rectangular box**.
   - Set the box to **[128, 128, 128]** (cube).
   - The wireframe should render as a **cube**.
   - Report: Does the wireframe match the box dimensions (tall box vs cube)?

4. **With no hover and no recent dimension change, the view looks exactly like before (no wireframe)?**
   - Pause or sit idle (don't hover, don't change dimensions).
   - The viewport should render with **no wireframe visible**.
   - The output should be **visually identical** to before the feature was added.
   - Report: Does the view with no hover / no recent change look exactly the same as before?


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

## Visual Timeline (SP2)

A **timeline panel** now sits below the animation controls, displaying all animated parameters as **lanes** with **keyframe dots** on a **seconds ruler**:

### Timeline interactions

- **Playhead (vertical line):** Marks the current **Phase** position on the timeline. **Drag left/right** to scrub through the animation; the viewport renders the interpolated scene in real time as you drag.
- **Keyframe dots:** Each animated parameter shows as a labeled lane (`L{layer}·{param}`, e.g., `L0·Opacity`). Dots on the ruler mark where keyframes exist.
  - **Click a dot** to select it (appears highlighted).
  - **Drag a selected dot left/right** to retime that keyframe; the playback interpolation updates immediately to reflect the new timing.
- **Delete / Backspace** (or click the **🗑** button in the timeline controls): Removes the selected keyframe.
  - When the **last** keyframe for a parameter is removed, the **◆** stopwatch next to that parameter **un-fills** (reverts to ◇), and the parameter becomes static again.
- **Add keyframes:** Click the **◆** stopwatch next to any parameter (as in SP1) to enable animation, then adjust the parameter value at any **Phase** position. A new keyframe is automatically created.
- **Scrolling:** When a scene has many animated parameters, the timeline panel scrolls vertically to show all lanes. Non-animated scenes show an **empty timeline** (no lanes).

### Run paths

**Native:**
```bash
cd v3 && cargo run
```

**Web (WebGPU):**
```bash
cd v3 && trunk serve        # (cargo install trunk, once)
```

### What to report back

Verify the timeline panel and keyframe editing work correctly:

1. **Animated params appear as lanes with dots at the right spots on the ruler?**
   - Create a layer and keyframe **Opacity** at Phase 0.0 (value 1.0), Phase 0.5 (value 0.2), Phase 1.0 (value 1.0).
   - The timeline panel should show a lane labeled `L0·Opacity` with **three dots** at approximately 0s, 0.5s, and 1.0s positions (scaled to the seconds ruler).
   - Verify the dots align visually with your keyframe positions.
   - Report: Do animated params appear as labeled lanes with dots at the correct positions?

2. **Dragging the playhead scrubs the animation?**
   - With the animated layer from (1), drag the **playhead (vertical line)** left and right across the timeline.
   - The viewport should render the interpolated scene in real time; **Opacity** should smoothly fade in and out as you drag.
   - Report: Does playhead drag scrub the animation smoothly without stalling?

3. **Clicking a dot selects it, dragging it retimes the keyframe (and playback reflects the new timing)?**
   - Click one of the **Opacity** keyframe dots on the timeline (e.g., the middle dot at 0.5s).
   - It should appear **highlighted** (visually selected).
   - **Drag that dot left** to ~0.3s and release.
   - The keyframe should move; when you press **Play**, the layer's opacity should now fade faster (opacity reaches 0.2 at 0.3s instead of 0.5s).
   - Report: Does clicking select a dot, and does dragging it retime the keyframe (with playback reflecting the new timing)?

4. **Delete removes the selected key (and the ◆ un-fills when its last key goes)?**
   - With the timeline showing the animated **Opacity** layer, click a keyframe dot to select it.
   - Press **Delete** (or **Backspace**, or click the **🗑** button).
   - The dot should disappear from the timeline.
   - If you delete the **last** keyframe for **Opacity**, the **◆** stopwatch next to the **Opacity** slider should **change to ◇** (animation disabled), and the parameter becomes static.
   - Report: Does Delete remove the selected keyframe, and does the ◆ un-fill when the last key is removed?

5. **Many animated params scroll in the panel; a non-animated scene shows an empty timeline?**
   - Animate 5–10 different parameters across different layers (e.g., Opacity, Offset X, Offset Y, Color, Emission on multiple layers).
   - The timeline panel should show all lanes; if they exceed the panel height, **scroll vertically** to reveal more.
   - Create a separate non-animated scene (no parameters with ◆ enabled).
   - The timeline panel should appear **empty** (no lanes, just the ruler and playhead).
   - Report: Does the timeline scroll when many lanes are present, and does an empty scene show no lanes?

### Next: SP3 (Value Curves & Vertical Editing)

**SP2 is horizontal-retime only** (drag dots left/right to adjust timing). Coming in **SP3**:
- **Per-keyframe value editing:** Drag keyframes **vertically** to adjust their values directly on the timeline.
- **Interpolation curves:** Bezier / hold / step modes per keyframe for non-linear interpolation.

### Deferred

This is **SP1 (foundation)** of a 4-part timeline roadmap. Still coming:
- **SP2:** Visual track lanes — drag keyframe dots directly on the timeline; see parameter curves over time
- **SP3:** Value curves — edit interpolation mode per keyframe (Bezier, hold, step)
- **SP4:** Color / enum tracks — animate gradient colors and mode selectors

Export and presets are also in the pipeline.


## HDR Color

The volume is now **float (RGBA16F)**, enabling colors and emission to exceed 1 for bright, glowing emissive content without clipping to flat white.

### Emission

Each layer now has an **Emission** slider (0–16) in the Properties panel, near the Color controls, and is **keyframable**:
- **Emission** = 1: layer color used as-is (baseline).
- **Emission** > 1: layer scales bright (crank it for glowing fire, bright highlights).
- **Emission** = 0: fully dims the layer.
- A fire layer with **Emission** = 8–16 produces bright, emissive color that does not clip to flat white.

### Exposure

A global **Exposure** control (0.1–4) in the top bar adjusts render brightness:
- Applied with a **filmic ACES tonemap**, so bright values roll off smoothly instead of blowing out.
- Tune **Exposure** to brighten or darken the entire render while maintaining natural highlight rolloff.
- Default: 1.0 (neutral; no change from before).

### Notes

- **Playback cache:** Now fits ~**half as many full-res frames** (RGBA16F is 2× the bytes per voxel). The VRAM readout shows larger MB/frame. Playback still works smoothly; cache auto-reduces all dimensions to stay within the 4 GB budget.
- **Existing scenes look slightly more filmic:** The default ACES tonemap gives all renders a subtle filmic character, even at **Exposure** = 1. Tune **Exposure** to taste (0.8–1.2 is often natural; higher for drama, lower for subdued).
- **Pre-HDR saved scenes still load:** Scenes saved before HDR support load cleanly with **Emission** = 1.0 (layer colors unchanged) and **Exposure** = 1.0 (default tonemap applied).

### Run paths

**Native:**
```bash
cd v3 && cargo run
```

**Web (WebGPU):**
```bash
cd v3 && trunk serve        # (cargo install trunk, once)
```


## What to report back

### Non-Cubic Volume Box

Verify the non-cubic volume box works correctly:

1. **[128, 128, 128] looks identical to before?**
   - Load or recreate a scene using the default cubic **[128, 128, 128]** box.
   - Compare the output to a scene from before this release (cubic-128 baseline).
   - Should look visually identical.
   - Report: Does the cubic-128 output match the previous version?

2. **[64, 64, 256] renders a taller box with sides **unchanged** and sphere **unchanged in size**?**
   - Set the box to **64 × 64 × 256** (4× taller, same width/depth as before).
   - Create a layer with an **SDF Sphere** (Noise type: SdfSphere, Radius ~20).
   - The sphere should stay the **same size** as on a [64, 64, 64] box (not stretched, not shrunk) — **the sides keep their size**.
   - Create a second layer with **Simplex** or **Perlin** noise.
   - The noise should extend **4× taller** vertically, showing more vertical detail, but the **sides remain unchanged**.
   - Report: Does growing Z make the box **taller with unchanged sides**, and does the sphere stay the **same size** (vs. the old behavior where the sides would shrink when growing another axis)?

3. **Camera stays **centered on and fitted to** the box?**
   - Set the box to **64 × 64 × 256** (a tall box).
   - Look at the viewport. The camera should frame the **entire box** (top to bottom, left to right, front to back) without clipping.
   - The box should be **centered in the viewport** (not off to one side or tilted).
   - Report: Does the camera stay **centered on the box** and **fit the entire box** in the viewport? Are there any clipping artifacts or off-center issues?

4. **Changing box dimensions has **no camera jump or pop**?**
   - With a scene rendered or playing, adjust one box dimension (e.g., Z from 256 → 512).
   - The viewport should pan/zoom smoothly to the new box without a sudden snap or jerk.
   - The camera and box should move together, maintaining the centered fit.
   - Report: When you change box dimensions, does the camera move smoothly with the box, or do you see a sudden jump/pop?

5. **Non-cubic box bakes + plays, cache auto-reduces, VRAM readout sane?**
   - Set the box to a non-cubic dimension (e.g., **128 × 64 × 256**).
   - Press **Bake** and verify the generation completes.
   - Press **Play** and verify animation/playback runs smoothly.
   - Watch the **VRAM readout** in the UI (displayed as `box X×Y×Z — MB/frame`).
   - If you set a very large box (e.g., **512 × 512 × 512**), the cache should auto-reduce all axes proportionally to fit the 4 GB budget; observe the VRAM drop.
   - Report: Does bake/play work? Does the VRAM readout show sensible values and auto-reduce on large boxes?

6. **No occupancy holes/clipping on tall boxes during render or playback?**
   - Create a tall box (e.g., **64 × 64 × 256**) with multiple noise layers.
   - During **rendering** (editing mode), watch the viewport for any visual gaps, holes, or clipped voxels.
   - Press **Play** and watch the **playback rendering** — same check for gaps or clipping.
   - Report: Do the tall boxes render without occupancy holes or unexpected clipping in both render and playback modes?

7. **Editing (paused) and playback show the same box shape?**
   - Set a non-cubic box (e.g., **128 × 128 × 256**).
   - In **editing/paused mode**, note the box aspect in the viewport.
   - Press **Play** to enter playback mode.
   - Pause again and compare the box shape. Should be identical (same width, height, depth).
   - Report: Does editing and playback show the same non-cubic box shape, or do they differ?

### Generation Primitives (Noise & SDF)

Verify the new generation primitives work correctly:

8. **New noise types render & look distinct?**
   - Create a layer with **Worley** noise. Do you see a clear cellular pattern (Voronoi diagram)?
   - Try Worley **Mode: F1** vs **F2** vs **F2−F1**. Each should look visually distinct (F1 = seeds, F2 = second-nearest, F2−F1 = edges). Report what you see.
   - Create a layer with **Voronoi** noise. Should emphasize cell edges more than Worley F1.
   - Create a layer with **White** noise. Should be a grainy, per-voxel random static (no obvious patterns).

9. **Worley modes visibly differ?**
   - Set a **Worley** layer to **F1, F2, F2−F1** in sequence, keeping other params constant.
   - Do the three modes look distinctly different (not just a re-color)? Report texture differences you observe.

10. **SDF shapes render correctly, radius/height affect them?**
    - Try each shape: **Box, Cone, Capsule, Cylinder, Plume** (one layer per shape).
    - For each, adjust the **Radius** slider. Does the shape scale visually?
    - For **Cone, Capsule, Cylinder, Plume**, adjust **sdf_height** (if available in the UI). Does height change the shape proportions?
    - Does each shape render without artifacts or shader errors?

11. **Existing Value/Perlin/Simplex/FBM/Sphere scenes unchanged?**
    - Load or recreate a scene using only **Value, Perlin, Simplex, FBM (with any of the old bases), or SdfSphere**.
    - Compare the output visually to before this release. Should look identical.
    - Report any changes or regressions.

12. **FBM with new bases (Worley/Voronoi/White) works?**
    - Create a layer with **FBM**, then set the **Base** to **Worley** (or Voronoi or White).
    - Adjust **Octaves** and **Lacunarity**. Should see fractal layering of the cellular/edge/static pattern, not a crash or blank output.
    - Report whether the FBM looks correct and distinct from the base noise.

13. **Distortion now works on SDF shapes: Domain Warp / Curl / Turbulence + Warp Noise?**
    - Create a **Cone** (SDF shape) layer.
    - Set distortion **Type** to **Domain Warp**, pick a **Warp Noise** (e.g., **Simplex**), raise **Strength** to 1.0+.
    - Does the cone visibly warp? (Previously, SDF shapes had no distortion response.)
    - Try **Domain Warp**, **Curl**, and **Turbulence** types. All should warp the cone.
    - Try different **Warp Noise** values (Value, Perlin, Simplex, Worley, Voronoi, White). Does each produce a distinct warp character?
    - Report: Does Domain Warp / Curl / Turbulence visibly warp a cone, and does Warp Noise change the character?

14. **Distortion Rotation X/Y/Z orient Swirl/Polar on any axis?**
    - Create a **Cone** layer, set distortion **Type** to **Swirl**, **Swirl Amt** = 2.5, **Strength** = 1.0.
    - Default (Rotation = 0, 0, 0): Swirl twists around the Y axis (helical on the cone).
    - Set **Distortion Rotation X** = 90°. Swirl should now twist around the X axis instead.
    - Try **Rotation Y** = 90° or **Rotation Z** = 90°. Verify reorientation each time.
    - Repeat for **Polar** distortion. Should reorient its radial field accordingly.
    - Report: Does Rotation X/Y/Z successfully reorient Swirl/Polar on a Y-aligned cone?

15. **Turbulence type produces flowing turbulence; Octaves adds detail?**
    - Create a noise layer with **Simplex** or **Perlin**.
    - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
    - Adjust **Octaves** from 1 to 8. Does higher Octaves add progressively finer turbulent detail?
    - Report: Does Turbulence look like flowing turbulence, and does Octaves add visible detail?

16. **Changing Warp Offset scrolls the turbulent detail?**
    - Create a noise layer with **Simplex** or **Perlin**.
    - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
    - Adjust **Warp Offset Z** (or X/Y) from 0 to 5–10. Does the turbulent field visibly scroll or shift?
    - Report: Does changing Warp Offset cause the warp field detail to shift/advect?

17. **Keyframing Warp Offset makes the pattern drift (wind motion)?**
    - Create a **Turbulence**-distorted noise layer (e.g., **Simplex** + Turbulence Type).
    - Enable animation on **Warp Offset Z** at **Phase** = 0.0 (value = 0.0).
    - At **Phase** = 1.0, set **Warp Offset Z** to 3–5 (creates a second keyframe).
    - Press **Play**. The turbulent pattern should smoothly drift over the loop (like wind blowing the flame sideways or along the Z axis).
    - Report: Does keyframing Warp Offset produce drifting/wind motion? Does the flame remain loopable (with hand-authored seamless wrapping via keyframes)?

18. **Warp Offset = 0 + existing scenes unchanged?**
    - Verify **Warp Offset X/Y/Z** all default to **0.0** (or very close).
    - Load or recreate a scene using **Domain Warp**, **Curl**, or **Turbulence** distortion with Warp Offset untouched (left at 0).
    - Compare the output to before this release. Should look identical.
    - Report: Does Warp Offset = 0 produce no visible change, and do existing scenes remain unaffected?

19. **Distortion type=None remains a no-op; existing scenes unchanged?**
    - Verify distortion **Type** = **None** is a true no-op (layer appearance unchanged).
    - Load or recreate an older v3 scene. Should look identical (all layers default to type=None).
    - Report: Does type=None remain a true no-op, and do existing scenes remain unaffected?

**Errors:**
- Paste any **egui, wgpu, or WGSL compilation error** from the native terminal or web console.
- Report any **visual artifacts** (z-fighting, NaN values, clipping) in the viewport.

### Keyframe Animation (SP1) verification

Verify keyframing and animation composition work correctly:

20. **Keyframing a parameter animates smoothly across the loop on Play?**
    - Create a layer with any noise type (e.g., **Simplex**).
    - Enable animation on **Opacity** by clicking ◇ (becomes ◆) at **Phase** = 0.0. Keep the value at 1.0.
    - Scrub **Phase** to 0.5. Set **Opacity** to 0.2. A second keyframe should be created.
    - Scrub to 1.0 and set **Opacity** back to 1.0. A third keyframe should be created.
    - Press **Play**. The layer's opacity should smoothly interpolate: 1.0 → 0.2 → 1.0 across the loop.
    - Report: Does the opacity animate smoothly and linearly across the keyframes?

21. **Multiple animated parameters compose?**
    - On the same layer, enable animation on **Offset X** (click ◇ at **Phase** = 0.0, value = 0.0).
    - At **Phase** = 0.5, set **Offset X** to 2.0 (creates a second keyframe).
    - At **Phase** = 1.0, set **Offset X** back to 0.0 (creates a third keyframe).
    - Also enable animation on **Opacity**: at Phase = 0.0, value = 1.0; at Phase = 0.5, value = 0.2; at Phase = 1.0, value = 1.0.
    - Press **Play**. Both **Offset X** and **Opacity** should animate at the same time.
    - Report: Do both parameters animate simultaneously? Does the layer move and fade as expected?

22. **Scrubbing Phase shows interpolated values live?**
    - With the animated layer from (21) above, pause playback (or start paused).
    - Drag the **Phase** slider from 0.0 to 1.0.
    - Watch the **Offset X** and **Opacity** sliders in the Properties panel.
    - The values should update smoothly as you scrub (not snap). The viewport should also render the interpolated scene in real time.
    - Report: Do the sliders and viewport update smoothly as you scrub Phase?

23. **Evolutions defaults to 0 (off) and re-enabling it works?**
    - Create a new scene or reset the existing one.
    - Check the **Evolutions** slider. It should start at **0.0** (or very close to 0).
    - Add a layer with **Simplex** noise. It should render without the domain-swirl distortion (clean noise field).
    - Raise **Evolutions** to 0.5 or higher. The noise field should now show the built-in swirl (visible distortion / warping).
    - Lower **Evolutions** back to 0. The swirl should disappear.
    - Report: Does Evolutions start at 0, and does raising/lowering it toggle the domain swirl on/off?

24. **Un-keyframed scenes look the same as before (aside from Evolutions off)?**
    - Load or recreate a scene using only non-animated parameters and **Evolutions** = 0.
    - Compare the output to a similar scene from an earlier v3 run (without keyframe animation).
    - They should look identical, except that **Evolutions** is no longer auto-applied.
    - Report: Do un-keyframed scenes render the same way, with no unexpected changes (other than Evolutions defaulting to 0)?

25. **Toggling ◆ off removes the animation?**
    - Create an animated layer (e.g., **Opacity** keyframed from 1.0 → 0.2 → 1.0 as in item 20).
    - Press **Play**. Verify the animation works.
    - Click the ◆ toggle next to **Opacity** to turn it off (becomes ◇).
    - Press **Play** again. The layer should now have a constant opacity (the slider's current value) and not animate.
    - Click ◆ again to re-enable. The animation should resume.
    - Report: Does toggling ◆ off freeze the animation and toggle ◇ back on resume it?

### Loop Offset (Loopable Warp)

Verify the new Loop Offset toggle enables seamless loopable distortion:

1. **Loop Offset OFF = unchanged infinite scroll?**
   - Create a noise layer with **Simplex** or **Perlin**.
   - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
   - Ensure **Loop Offset** is toggled **OFF** (default).
   - Adjust **Warp Offset Z** from 0 to 5 and back. The warp field should scroll infinitely (no obvious repeating pattern).
   - Compare to a scene from before this release (same distortion setup). Should look identical.
   - Report: Does Loop OFF produce unchanged infinite scroll?

2. **Loop Offset ON + keyframe Warp Offset 0→1 over the loop = seamless drift?**
   - Create a noise layer with **Simplex** or **Perlin**.
   - Set distortion **Type** to **Turbulence**, **Strength** = 1.0.
   - Toggle **Loop Offset** to **ON**.
   - Enable animation on **Warp Offset Z** at **Phase** = 0.0 (value = 0.0).
   - At **Phase** = 1.0, set **Warp Offset Z** to 1.0 (creates a second keyframe; note: in loop mode, 1.0 = one full cycle).
   - Press **Play**. The warp field should smoothly drift over the loop with **no jump or discontinuity at the loop seam**.
   - Compare the loop point (where Phase = 1.0 wraps back to 0.0). The distortion should be visually continuous, as if drifting seamlessly.
   - Report: Does keyframing Warp Offset Z from 0 to 1 over the loop produce seamless drift with no jump at the seam?

3. **Toggling Loop Offset doesn't break existing Distortion?**
   - Load a scene with **Domain Warp**, **Curl**, or **Turbulence** distortion (any Warp Noise, any Warp Offset, animated or not).
   - Toggle **Loop Offset** ON and OFF several times.
   - Verify no crashes, shader errors, or visual glitches.
   - Toggle back to the original state; the distortion should restore to its previous appearance.
   - Report: Does toggling Loop Offset work without errors or visual breakage?

### Scene Persistence verification

Verify the save/reset and auto-load mechanism work correctly:

1. **Build a scene → Save as default → reload/relaunch → scene comes back?**
   - Create a scene with multiple layers (e.g., a Simplex layer + a Worley layer with different colors).
   - Adjust the box dimensions (e.g., 64 × 64 × 256).
   - Add a keyframe or two (e.g., animate Opacity on one layer).
   - Adjust the camera (pan/zoom).
   - Click **💾 Save as default**.
   - **Web:** Reload the page (F5 or browser refresh).
   - **Native:** Close the app (exit `cargo run`) and relaunch it.
   - Your scene should come back with all layers, box dims, colors, keyframes, and camera position intact.
   - Report: Does your scene reappear after reload/relaunch with layers, dims, colors, keyframes, and camera unchanged?

2. **Reset reverts to the demo?**
   - Click **↺ Reset**.
   - The scene should change to the built-in demo (typically one Simplex layer, default [128, 128, 128] box, no keyframes, default camera).
   - Report: Does Reset revert to the demo scene?

3. **First run (no saved data) shows the demo?**
   - **Web:** Open the app in a **new private/incognito browser tab** (no localStorage history).
   - **Native:** Delete `~/.vol3d/scene.json` if it exists, then relaunch the app.
   - The app should start with the built-in demo scene (no crash, no blank canvas).
   - Report: Does the first run (no saved data) load the demo scene cleanly?

4. **No crash after Save, then Reset, then editing?**
   - Build a scene and click **💾 Save as default**.
   - Click **↺ Reset** to revert to the demo.
   - Edit the demo scene (add a layer, change a color, adjust box dims).
   - No errors or crashes should occur.
   - Report: Can you safely switch between your saved scene and the demo without crashing?

### HDR Color

Verify HDR color (float RGBA16F, Emission, Exposure, ACES tonemap) works correctly:

1. **A fire layer with high Emission looks bright/glowing and rolls off (no flat-white clip)?**
   - Create a layer with any noise type (e.g., **Simplex**).
   - Set the **Color** to a warm orange or red (fire-like).
   - Raise the **Emission** slider to 12–16.
   - The layer should appear bright and emissive (glowing fire look), with smooth rolloff at the bright edges — **no flat white clipping**.
   - Report: Does the bright fire look glowing and smooth at the edges?

2. **Exposure brightens/darkens the whole render?**
   - With the high-Emission fire layer visible, adjust the **Exposure** slider in the top bar.
   - Raise **Exposure** to 2.0+. The entire render should brighten (including the fire).
   - Lower **Exposure** to 0.5. The entire render should darken.
   - Return to **Exposure** = 1.0 (default).
   - Report: Does Exposure brighten/darken the entire scene?

3. **A plain scene (normal Emission = 1) looks ~like before (slightly filmic)?**
   - Create or load a scene with normal layer Emission (1.0, the default).
   - Set **Exposure** = 1.0.
   - Compare the render to a similar scene from before this release. Should look very similar, with a subtle filmic tonemap applied (not flat/washed).
   - If you prefer a brighter or darker baseline, adjust **Exposure** slightly (0.8–1.2 is typical).
   - Report: Does a normal scene look ~like before, with a subtle filmic character?

4. **Playback still works; VRAM readout shows larger MB/frame?**
   - Create a scene with multiple layers and press **Bake**.
   - Press **Play**. Animation should play smoothly without stutters.
   - Watch the **VRAM readout** in the UI (displayed as `box X×Y×Z — MB/frame`). It should show a larger value than before (RGBA16F = 2× the bytes).
   - Example: a 128×128×128 box that was 4 MB/frame before is now ~8 MB/frame. Playback cache auto-reduces all axes to stay within the 4 GB budget.
   - Report: Does playback run smoothly, and does the readout show larger MB/frame values?

5. **A pre-HDR saved scene (from the previous build) still loads?**
   - From the previous build, create and save a scene using **💾 Save as default**.
   - Update to this build (or simulate by loading an old `scene.json`).
   - The scene should load cleanly with **Emission** = 1.0 on all layers and **Exposure** = 1.0 applied.
   - The scene's appearance should match (or be very close to) what it was before, with the filmic tonemap applied.
   - Report: Does a pre-HDR saved scene load without error and look correct?

## Known this cycle

- **Worley/Voronoi GPU hash stability:** Worley and Voronoi use a fast hash (`hash13`) for cell seeding; results are consistent per voxel per frame, but the hash is not bit-exact across platforms. Expect minor visual differences between native and web.
- **White noise varies frame-to-frame:** White noise is re-hashed on each frame; to use it in a static (non-animated) scene, set **Evolutions** to 0. For animation, White will look like TV static transitioning over time (expected behavior).

## HDR Color Roadmap

Remaining work for the HDR color cycle (SP2+):
- **SP2:** Visual timeline lanes — drag keyframe dots directly on the timeline; see parameter curves over time.
- **Named presets & import/export:** Save/load multiple custom scenes and settings.
- **HDR export:** Save renders to high-bit-depth formats (e.g., EXR, TIFF 16-bit) for post-production.

## Scene Persistence

Save your current scene (layers, box dimensions, colors, keyframes, and camera state) as the **default startup scene**. Every time you launch the app, your saved scene auto-loads.

### Save & Reset

Two top-bar buttons:
- **💾 Save as default** — Saves your current scene state (all layers, box X/Y/Z, layer colors, keyframes on the timeline, camera position/zoom) as the startup default. On the next reload (web) or relaunch (native), the app opens with your saved scene.
- **↺ Reset** — Reverts to the **built-in demo scene** (one Simplex layer, default box dimensions, no keyframes, default camera).

### Auto-Load on Startup

A saved scene loads automatically when you start the app:
- **Web (localStorage):** The scene is stored in your browser's **localStorage** for the site. Reload the page → your scene comes back.
- **Native (file):** The scene is saved to **`~/.vol3d/scene.json`**. Relaunch the app → your scene comes back.

**Fallback:** If the saved scene file is corrupt, missing, or parsing fails, the app falls back to the **built-in demo scene** (no crash; you're never left with a blank canvas).

### Notes

- **Single default slot:** You can only save one default scene at a time. Named presets and import/export are planned for a later cycle.
- **What changes in a saved scene:** Layers (all properties), box dimensions, keyframes and animation timeline, camera position and zoom. UI state (panel width, scroll position) resets on each load.

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
