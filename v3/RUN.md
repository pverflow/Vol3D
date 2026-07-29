# Running the v3 PoC — Cycle ③

## Interactive Authoring UI

Build a colored volumetric scene with a live-updating UI. Start with a blank canvas or a preset scene, add/modify layers to author custom color clouds, and see edits regenerate with ~120ms debounce.

### Layout

**Left panel (Layers):**
- Rows of layer buttons: select (highlight), visibility (eye icon toggle), blend-mode combo (Add/Multiply/Screen/Overlay)
- Layer actions: **Add**, **Duplicate**, **Delete**, **Move ↑**, **Move ↓** buttons
- **Resolution:** combo for voxel grid size (64³, 128³, 256³)
- **Global seed:** field for random noise variation across all layers

**Right panel (Properties, for selected layer):**
- **Noise type:** combo (Value, Perlin, Simplex, FBM, SdfSphere)
- **Transform:** Scale, Rotation, Offset (X, Y, Z)
- **Amplitude:** layer intensity multiplier
- **Opacity:** layer alpha (0–1)
- **Invert:** checkbox to invert the noise
- **Blend mode:** combo (Add, Multiply, Screen, Overlay)
- **Remap:** In/Out range sliders (remap noise from [0,1] to custom range for contrast/clipping)
- **FBM params** (when Noise = FBM): Octaves, Persistence, Lacunarity
- **SDF params** (when Noise = SdfSphere): Radius
- **Color gradient editor:** Interactive gradient bar
  - Click an empty area to **add** a stop
  - Drag a stop to **move** it along the bar
  - Right-click or button to **remove** a stop
  - Click a stop to pick its color and alpha
  - Stops map [0,1] noise to [color] for this layer only
  - **Changes apply live** to the viewport (debounced ~120ms)

**Center (Viewport):**
- 3D view of the current volume
- **Orbit:** click + drag to rotate
- **Zoom:** scroll wheel to zoom in/out
- Any property change triggers a recompile of that layer's shader and regenerates the volume after ~120ms debounce

### Native
    cd v3 && cargo run

Expect a window with the UI on left/right and viewport in the center. The terminal shows the "v3 adapter:" line (GPU backend, capabilities).

### Web (WebGPU)
    cd v3 && trunk serve        # (cargo install trunk, once)

Open the shown localhost URL in a WebGPU browser (Chrome/Edge/Safari 26).
Same UI and viewport, same interactivity. If the canvas is blank, open devtools console for WebGPU/adapter errors.

## What to report back

**Layer editing:**
- Can you **add, duplicate, delete, and reorder layers** with the buttons? Does visibility toggle work?
- Do **property changes** (scale, rotation, offset, amplitude, opacity, invert, blend mode) **regenerate the volume** with ~120ms debounce? (No lag; no stutter from immediate recompile.)

**Gradient editor (per-layer color):**
- Can you **add stops** by clicking the empty gradient bar? (Click → stop appears.)
- Can you **drag stops** left/right to change their position? (Smooth dragging, no stutter.)
- Can you **pick color and alpha** for each stop? (Click stop → color picker.)
- Can you **remove stops**? (Right-click or remove button.)
- Does the **multi-layer color** now reflect your choice? (Layer 1's color stops map to its noise; Layer 2's gradient is independent. Not a single flat color.)

**Scene authoring:**
- Build a **fire or smoke-ish scene:** Start with a base FBM layer (orange/red gradient), add a detail Perlin layer (lighter orange/yellow), blend with Add or Screen. Does the result look like fire/smoke with layered colors?
- **Noise type:** Switch a layer's noise type from Perlin to FBM or Simplex—does the structure change visibly?

**Performance:**
- At **128³**, drag the viewport around—is rotation smooth? (60 fps target.)
- At **256³**, same test—does the frame rate drop noticeably? (Note the threshold for your GPU.)
- Any lag or stutter when adding/deleting layers or updating the gradient?

**Errors:**
- Paste any **egui or wgpu error** from the native terminal or web console, especially:
  - UI widget crashes (egui-0.35 signature mismatches)
  - Compute shader compilation errors (FBM, Simplex, SdfSphere)
  - Binding or buffer updates
  - WebGPU adapter fallback (web only)

### Deferred (not in this cycle)
- Bezier curve editor for remap (planned for cycle ④)
- Feather / soft mask blending
- Layer presets and animation
- Undo/redo
