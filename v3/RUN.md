# Running the v3 PoC — Cycle ②

## Demo scene
A hardcoded multi-layer colored volume:
- **Layer 1 (base):** FBM cloud, Multiply blended, blue→cyan color ramp
- **Layer 2 (detail):** Perlin noise, Multiply blended, orange→red color ramp
- **Mask:** SdfSphere, clips both layers

The viewport shows a colored blobby ball; distinct colors from each layer should be visibly blended at the edges and interior (not one flat color).

## Left panel sliders (3 + Resolution combo)
1. **Scale:** global multiplier for both noise layers (0.1–10×)
2. **Mask radius:** SdfSphere radius, controls the ball shape (visible shrink/grow)
3. **Seed:** global random seed, regenerates noise pattern
- **Resolution combo:** voxel grid size (64³, 128³, 256³)

Moving any slider regenerates the volume in real time.

## Native
    cd v3 && cargo run
Expect: a window with the colored sphere. Dragging orbits; wheel zooms. Check the terminal
for the "v3 adapter:" line (logs adapter name, backend, max_texture_dimension_3d).

## Web (WebGPU)
    cd v3 && trunk serve        # (cargo install trunk, once)
Open the shown localhost URL in a WebGPU browser (Chrome/Edge/Safari 26).
Expect the same colored sphere view. If the canvas is blank, open devtools console for
WebGPU/adapter errors.

## What to report back
- **Render:** Does the multi-layer **colored** volume render? (Distinct color contributions from both layers—not a single flat color.)
- **Sliders:** Do all 3 sliders react visibly? (Scale shrinks/grows features; Mask radius shapes the ball; Seed changes the noise.)
- **Parity:** Compare the look to v2's equivalent multi-layer Multiply scene (`v2/run-scene.md`, if available). Same feel?
- **Errors:** Paste any wgpu validation warning/error from the native terminal or web console. Pay special attention to:
  - Creating the compute pipeline
  - Binding the layers storage buffer
  - The 256×N ramp LUT texture
  - `GpuLayer` layout (std430 contract)
