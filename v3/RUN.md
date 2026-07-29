# Running the v3 PoC

## Native
    cd v3 && cargo run
Expect: a window; left panel with Resolution / Iso / Noise scale; central viewport
showing a colored (blue→orange) blobby sphere; dragging orbits it; wheel zooms;
moving a slider regenerates it. Check the terminal for the "v3 adapter:" line
(logs adapter name, backend, max_texture_dimension_3d).

## Web (WebGPU)
    cd v3 && trunk serve        # (cargo install trunk, once)
Open the shown localhost URL in a WebGPU browser (Chrome/Edge, or Safari 26).
Expect the same view. If the canvas is blank, open devtools console for a
WebGPU/adapter error and copy it.

## What to report back
- Native: OS + the "v3 adapter:" line + does it render/orbit/regenerate? screenshot.
- Web: browser + version + renders? any console error? screenshot.
- Any backend where it fails to create the rgba8 3D storage texture / pipeline
  (copy the exact wgpu validation error) — this is the key capability finding.
