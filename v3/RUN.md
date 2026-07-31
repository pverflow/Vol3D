# Running the v3 PoC — Cycle ④ (Animation + Dense GPU Frame Cache)

## Interactive Authoring & Animation

Build a colored volumetric scene with a live-updating UI, now with real-time animation playback. Start with a blank canvas or a preset scene, add/modify layers to author custom color clouds, and animate them by pressing Play. Edits still regenerate with ~120ms debounce; playing bakes frames to a GPU-resident 3D texture cache for smooth playback (no per-frame CPU regeneration). The UI retains the dark pro-tool theme from cycle ③ with light/dark toggle.

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

**Animation controls:**
- Does the **Play/Pause button** start and stop the animation loop?
- Do the **loop duration, evolutions, and frame count controls** update correctly?
- Can you **scrub the phase slider** to jump to any point in the loop while paused?
- Does the **cache readout** show "baked N @res" (e.g., "baked 60 @128³") when cache is ready, and "stale" after an edit?

**Noise evolution (the core animation feature):**
- Does the **noise visibly EVOLVE** as the loop plays? (The noise pattern should smoothly change over time, driven by the rotating `animatedDomainOffset` in the domain. This is the essence of cycle ④.)
- Does the animation look **smooth and continuous**, or does it loop with a visible discontinuity at the frame boundary?

**Dense GPU frame cache & playback:**
- Does **Play bake then play SMOOTHLY**? (Watch the FPS/MS counter in the top bar during playback.)
  - First play (or first play after editing): Expect a brief one-time bake pause (~1–2 sec for 128³), then smooth playback.
  - After that: Playback should be smooth with **steady high FPS** (≥60 fps target), **NOT per-frame regen stutter**. If you see stuttering or fps dips, the cache is not working.
- **Playback FPS at 128³:** Report the frame rate during a full loop on your GPU. (This is the key metric: cache hit should hold steady fps, while live-edit regen would stutter.)
- **Playback FPS at 256³ (if your GPU allows):** Note this is memory-heavy for the dense cache (256³ × 4 frames × 4 bytes = ~1 GB+). If you hit memory limits or bad perf, that's expected—cycle ⑤ adds a sparse cache to handle 256³+.

**Layer editing during playback:**
- While playing, **edit a layer** (change amplitude, scale, noise type, etc.).
- Does the **cache readout flip to "stale"**?
- Does **playback continue smoothly** with the old cached frames?
- Press **Play again** (or let it loop): Does it **re-bake with the new edits** before resuming playback? (Expect a brief bake pause.)

**Memory & stability:**
- At **128³** playback, is memory usage stable and reasonable? (The dense cache holds N frames; ~60 frames at 128³ is ~480 MB.)
- Any **OOM or crash** at higher resolutions or frame counts? (Note: 256³ dense cache is heavy; deferred sparse cache will fix this.)

**Rendering & UI regression:**
- Does the **viewport rotate smoothly**? (No regression from cycle ③.)
- Do **layer editing and gradient controls** still work as before?
- Any **UI crashes or shader compilation errors**?

**Errors:**
- Paste any **egui, wgpu, or WGSL compilation error** from the native terminal or web console, especially:
  - Animation phase clock or cache invalidation crashes
  - Compute shader bind errors (FrameCache texture creation)
  - WebGPU adapter fallback (web only)

**Deferred (not in this cycle):**
- GPU sparse brick cache for 256³+
- Reduced-resolution baking (half-res cache, interpolate at playback)
- Temporal interpolation between frames (smoother animation with fewer baked frames)

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
