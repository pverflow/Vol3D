# Running the v3 PoC — Cycle ⑥ (FPS-Driven Cache + Interpolation Toggle)

## Interactive Authoring & Animation

Build a colored volumetric scene with a live-updating UI, now with **FPS-driven animation playback**. Start with a blank canvas or a preset scene, add/modify layers to author custom color clouds, and animate them by pressing Play. Edits still regenerate with ~120ms debounce; pressing Play now bakes `fps × loop_seconds` frames into a **4 GB cache** (auto-resolution: ~128³–192³ for typical game loops, 64³ for long ones) and plays them at real time — so **type 30 → ~30 updates/sec, type 60 → ~60**.

**NEW: FPS control replaces raw frame count.** Type any FPS value, and playback adapts the update rate accordingly. The **Interpolate checkbox** (off by default) lets you choose between **crisp true-FPS steps** (no ghosting) or **smooth crossfade blend** between frames (smoother on slow motion, but may ghost on fast-moving features).

**Minimum spec: 4 GB free VRAM.** A one-time bake hitch on Play scales with N (e.g. 30 fps × 17 s ≈ 510 frames); async/progressive bake is a deferred follow-up.

The UI retains the dark pro-tool theme from cycle ③ with light/dark toggle.

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
- **FPS field:** Playback framerate (default 30). Sets the update rate: `fps × loop_seconds` frames are baked into cache. Type 30 → ~30 updates/sec; type 60 → ~60 updates/sec.
- **Interpolate checkbox:** Off (default) = crisp true-FPS steps (no ghosting); On = crossfade blend between frames (smoother motion, may ghost on fast-moving features).
- **Phase scrub slider:** Jump to any point in the loop (0 to 1)
- **Cache readout:** Shows bake status — e.g., "baked 60 @ 128³ (0.5 GB) — 30 fps — steps" or "baked 60 @ 128³ (0.5 GB) — 30 fps — smooth" (if Interpolate on), or "stale" (invalidated by edits)

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
Refer to "Animation panel" above for the full list. Key controls:
- Play/Pause button
- Loop duration slider (in seconds)
- Evolutions slider (affects noise animation speed)
- **FPS field** (default 30) — type to adjust playback framerate
- **Interpolate checkbox** — toggle between crisp (off) and smooth (on) playback
- Phase scrub slider (jump to any point in the loop)
- Cache status readout (e.g., "baked 60 @ 128³ (0.5 GB) — 30 fps — steps" or "stale")

**Center (Viewport):**
- 3D view of the current volume, animated if playing
- **Orbit:** click + drag to rotate
- **Zoom:** scroll wheel to zoom in/out
- Any property change during playback invalidates the cache (readout shows "stale"), and re-baking happens on the next Play press
- During playback, the noise animates smoothly via `animatedDomainOffset` — the domain rotates over the loop duration


## What to report back

**The core FPS + interpolation test:**

1. **Typed FPS visibly matches update rate?** Type **30**, press Play, and watch the motion. Then type **60** and play again. The motion speed should stay the same (motion speed is set by Loop duration), but playback should look smoother/less stepped at 60 fps. Report the actual fps from the top-bar counter during playback.

2. **Interpolate toggle crisp vs smooth?** 
   - Set **Interpolate OFF** (default) and play a loop. Should see crisp, true-FPS stepping — no blur between frames.
   - Toggle **Interpolate ON**. Same loop should now crossfade smoothly between frames. Does it look smoother? 
   - On fast-moving features or high-evolution scenes, does **ON** cause visible ghosting (double-imaging)? Report any ghosting you see.

3. **Readout looks sane?** Watch the cache readout during playback. Does it show format like `"baked N @ res³ (X.X GB) — Y fps — steps/smooth"`? Do the numbers track with what you typed? (E.g. type 30 fps → should show 30; type 60 → should show 60.)

4. **Long loops soften, not crash?** Set **Loop duration** to a long value (e.g. 20–30 seconds) with **FPS 30**, then press Play. The bake should auto-downres to 64³ to fit the 4 GB budget, not crash or hang. Does it bake and play? Compare the cached resolution in the readout to a short loop (should soften from 128³–192³ to 64³).

**Layer editing during playback:**
- While playing, **edit a layer** (change amplitude, scale, noise type, etc.).
- Does the **cache readout flip to "stale"**?
- Does **playback continue smoothly** with the old cached frames?
- Press **Play again** (or let it loop): Does it **re-bake with the new edits** before resuming playback?

**Interpolation & live editing:**
- Is live editing + paused unchanged? Edit a layer while paused, and compare the paused frame to before. Should be identical (live edits do not use interpolation; they use static union of both frames, same as before).

**Rendering & UI regression:**
- Does the **viewport rotate smoothly**?
- Do **layer editing and gradient controls** still work as before?
- Any **UI crashes or shader compilation errors**?

**Errors:**
- Paste any **egui, wgpu, or WGSL compilation error** from the native terminal or web console.

## Known this cycle

- **One-time bake hitch on Play:** The cache bakes all N frames on the first Play press after an edit. This scales with N (e.g. 30 fps × 17 s ≈ 510 frames = noticeable delay). Async/progressive bake is deferred.
- **Paused scrubbing:** Currently, the phase slider only moves during Play; scrubbing while paused does NOT update the view. This is a deliberate trade-off to keep the paused frame at crisp full resolution. Can be restored on request.

## Deferred (not in this cycle)

- **Async / progressive bake:** Currently all N frames bake synchronously on Play press. Should defer baking to background thread, display a progress bar, and start playback with available frames.
- **Live-regen playback:** VRAM-free alternative that re-renders each frame on-demand (trades compute for memory). Ghost-free, no cache ceiling, but slower playback. For future exploration if the 4 GB cache becomes a bottleneck.
- Velocity-warp / optical-flow interpolation (ghost-free fast motion; current linear blend can ghost on fast-moving features)
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
