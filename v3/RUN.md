# Running the v3 PoC — Cycle ⑤ (Raymarch Perf: Empty-Space Skip + Reduced-Res Playback Bake)

## Interactive Authoring & Animation

Build a colored volumetric scene with a live-updating UI, now with real-time animation playback and **fast playback baking via empty-space skipping**. Start with a blank canvas or a preset scene, add/modify layers to author custom color clouds, and animate them by pressing Play. Edits still regenerate with ~120ms debounce; pressing Play now bakes at **reduced resolution** so the **full requested frame count fits in VRAM**, each frame is a smaller texture (far less raymarch bandwidth), and the **pause frame snaps to crisp full resolution**. The raymarch jumps over empty regions via a coarse occupancy structure, so sparse fire/smoke scenes render much faster. The UI retains the dark pro-tool theme from cycle ③ with light/dark toggle.

### Animation Controls & Top Bar

The UI retains the **dark pro-tool theme** matching v2's visual language. A **light/dark toggle** in the top bar lets you switch themes.

**Top bar** (always visible):
- **Title:** "Vol3D"
- **FPS / MS counter:** Live frame rate and frame time display (watch this during playback)
- **Resolution combo:** Quick access to voxel grid size (64³, 128³, 256³)
- **Global seed field:** Random noise variation across all layers
- **Theme toggle:** Switch between dark and light modes

**Animation panel** (controls below layers):
- **Play / Pause button:** Start/stop the loop animation
- **Loop duration (seconds):** How long one full loop takes
- **Evolutions slider:** Number of animated noise evolutions (raising this makes noise animate faster)
- **Frame count:** Total number of frames N in the baked cache
- **Phase scrub slider:** Jump to any point in the loop (0 to 1)
- **Cache readout:** Shows cache status — e.g., "baked 60 @128³" or "stale" (invalidated by edits)

### Layout

**Left panel (Layers):**
- **Layer rows:** Each layer shows:
  - **Eye toggle:** Click to show/hide the layer
  - **Layer name/button:** Select the layer (highlighted with accent color when selected)
  - **Delete button:** Red-tinted danger button to remove the layer
  - **Blend-mode combo** (on row): Add/Multiply/Screen/Overlay
- **Layer actions:** **Add**, **Duplicate**, **Move ↑**, **Move ↓** buttons

**Right panel (Properties, for selected layer):**
Organized into collapsible groups with tidy aligned rows:

- **Noise group:**
  - **Noise type:** combo (Value, Perlin, Simplex, FBM, SdfSphere)
  - **FBM params** (when Noise = FBM): Octaves, Persistence, Lacunarity
  - **SDF params** (when Noise = SdfSphere): Radius

- **Transform group:**
  - **Scale, Rotation, Offset (X, Y, Z):** Aligned rows for precise control

- **Remap group:**
  - **In/Out range sliders:** Remap noise from [0,1] to custom range for contrast/clipping

- **Color group:**
  - **Amplitude:** layer intensity multiplier
  - **Opacity:** layer alpha (0–1)
  - **Invert:** checkbox to invert the noise
  - **Blend mode:** combo (Add, Multiply, Screen, Overlay)
  - **Color gradient editor:** Interactive gradient bar
    - Click an empty area to **add** a stop
    - Drag a stop to **move** it along the bar (selected stop highlighted in accent color)
    - Right-click or button to **remove** a stop
    - Click a stop to pick its color and alpha
    - Stops map [0,1] noise to [color] for this layer only
    - **Changes apply live** to the viewport (debounced ~120ms)

**Bottom panel (Animation controls):**
- Play/Pause button
- Loop duration slider (in seconds)
- Evolutions slider (affects noise animation speed)
- Frame count display (set by bake)
- Phase scrub slider (jump to any point in the loop)
- Cache status readout (e.g., "baked 60 @128³" or "stale")

**Center (Viewport):**
- 3D view of the current volume, animated if playing
- **Orbit:** click + drag to rotate
- **Zoom:** scroll wheel to zoom in/out
- Any property change during playback invalidates the cache (readout shows "stale"), and re-baking happens on the next Play press
- During playback, the noise animates smoothly via `animatedDomainOffset` — the domain rotates over the loop duration


## What to report back

**At 256³ (the case that was 1–2 fps) — the key test:**
- **Is Play now smooth?** Report the ms/frame and fps during playback. (This is the target metric: empty-space skipping + reduced-res playback bake should make 256³ fast.)
- **Does the full requested frame count bake**, or is it still clamped? (Playback should bake all N frames you request, not just 8.)
- **Is the paused frame crisp and full-resolution?** (Pause should snap to the full requested resolution, not stay reduced.)

**Empty-space skipping behavior:**
- **Sparse scene (fire/smoke):** Does it speed up a lot compared to cycle ④? (Expected: big speedup from jumping over empty air.)
- **Dense cube-filling scene:** Is the speedup less than sparse? (Expected: less empty space to skip.)
- **Any visual holes or clipping of faint smoke?** (Report if you see clipping artifacts; this indicates the occupancy skip threshold needs tuning. Include a screenshot or description.)

**Animation controls & playback:**
- Does the **Play/Pause button** start and stop the animation loop?
- Do the **loop duration, evolutions, and frame count controls** update correctly?
- Does **Play bake then play SMOOTHLY**? (Watch the FPS/MS counter in the top bar during playback.)

**Layer editing during playback:**
- While playing, **edit a layer** (change amplitude, scale, noise type, etc.).
- Does the **cache readout flip to "stale"**?
- Does **playback continue smoothly** with the old cached frames?
- Press **Play again** (or let it loop): Does it **re-bake with the new edits** before resuming playback?

**Rendering & UI regression:**
- Does the **viewport rotate smoothly**? (No regression from cycle ④.)
- Do **layer editing and gradient controls** still work as before?
- Any **UI crashes or shader compilation errors**?

**Errors:**
- Paste any **egui, wgpu, or WGSL compilation error** from the native terminal or web console, especially:
  - Occupancy texture binding or compute errors
  - Raymarch empty-space skip shader issues
  - WebGPU adapter fallback (web only)

## Known this cycle

- **Paused scrubbing:** Currently, the phase slider only moves during Play; scrubbing while paused does NOT update the view. This is a deliberate trade-off to keep the paused frame at crisp full resolution. Can be restored on request.
- **Cache label:** The readout shows "baked N @res³" — the **res³ is the requested resolution, not the actual reduced bake resolution**. The actual bake is at a lower resolution to fit VRAM; pause restores full resolution.

## Deferred (not in this cycle)

- Lower-resolution screen-space raymarch (currently full-res raymarching)
- Temporal interpolation between frames (would allow fewer baked frames with smooth playback)
- True sparse brick atlas (current occupancy is a voxel grid; a brick atlas would be more memory-efficient for very sparse scenes)

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
