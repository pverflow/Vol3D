# Running the v3 PoC — Cycle ③ (Restyled UI)

## Interactive Authoring UI

Build a colored volumetric scene with a live-updating UI. Start with a blank canvas or a preset scene, add/modify layers to author custom color clouds, and see edits regenerate with ~120ms debounce. The UI now features a dark pro-tool theme (matching v2) with a light/dark toggle, organized panels, and polished layer interaction.

### Theme & Top Bar

The UI adopts a **dark pro-tool theme** matching v2's visual language. A **light/dark toggle** in the top bar lets you switch themes.

**Top bar** (always visible):
- **Title:** "Vol3D"
- **FPS / MS counter:** Live frame rate and frame time display
- **Resolution combo:** Quick access to voxel grid size (64³, 128³, 256³)
- **Global seed field:** Random noise variation across all layers
- **Theme toggle:** Switch between dark and light modes

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

**UI theme & visual polish:**
- Does the UI **read like v2's dark pro-tool theme**? (Dark panels/widgets, accent highlight on selected items.)
- Does the **light/dark toggle** in the top bar switch themes correctly?
- Is the **top bar** present and aligned? (Title, FPS/MS counter, Resolution combo, Global seed, theme toggle.)
- Are **layer rows polished**? (Eye toggle works; selected row highlighted in accent; Delete button red-tinted.)
- Are **Properties groups** (Noise, Transform, Remap, Color) **collapsible and tidy**? (Aligned rows, no clutter.)
- Is the **gradient editor's selected stop** highlighted in the accent color?

**Layer editing:**
- Can you **add, duplicate, delete, and reorder layers** with the buttons? Does visibility (eye toggle) work?
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

**Rendering & functionality:**
- At **128³**, drag the viewport around—is rotation smooth? (60 fps target.)
- At **256³**, same test—does the frame rate drop noticeably? (Note the threshold for your GPU.)
- Any lag or stutter when adding/deleting layers or updating the gradient?
- **Did anything regress?** (Rendering quality, layer authoring, gradient editing. This was visual-only; cycles ①–③ logic unchanged.)

**Errors:**
- Paste any **egui or wgpu error** from the native terminal or web console, especially:
  - UI widget crashes (egui-0.35 signature mismatches)
  - Compute shader compilation errors (FBM, Simplex, SdfSphere)
  - Binding or buffer updates
  - WebGPU adapter fallback (web only)

**Heads up:**
- Animation (cycle ④) lands next in this restyled UI. No animation in this cycle—visual restyle only.

### Deferred (not in this cycle)
- Bezier curve editor for remap (planned for cycle ④)
- Feather / soft mask blending
- Layer presets and animation
- Undo/redo
