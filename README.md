# Vol3D

Vol3D is a browser-first and Windows-desktop-ready **3D volume texture generator** for seamless procedural noise, shader lookdev, VFX prototyping, and game content workflows.

It lets you stack procedural layers, preview them as a raymarched volume, inspect slices and projections, shape density with remapping and feathering, and export the generated volume data in several formats.

---

## Repository docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor workflow and expectations
- [`LICENSE`](LICENSE) — current repository license terms
- [`docs/third-party-licenses.md`](docs/third-party-licenses.md) — current dependency license audit
- [`docs/windows-release.md`](docs/windows-release.md) — Windows executable / installer / signing flow
- [`FutureFeatures.md`](FutureFeatures.md) — deferred and in-progress feature tracking

---

## Highlights

- **3D procedural noise generation**
  - Perlin
  - Simplex
  - Worley
  - Voronoi
  - Value
  - White
  - FBM with selectable base noise
- **Layer-based workflow**
  - multiple layers
  - blend modes
  - opacity
  - inversion
  - reorder / duplicate / delete
- **Noise transforms**
  - scale
  - rotation
  - offset
  - per-layer seed
- **Distortion options**
  - Domain Warp
  - Curl
  - Swirl
  - Polar
- **Advanced remap shaping**
  - input/output remap ranges
  - editable Bézier remap curve
  - feather widths per axis
  - box or sphere feather shape
  - editable Bézier feather curve
- **Preview modes**
  - Volume / raymarched
  - Slice
  - Projection
- **Tiling diagnostics**
  - 3×3×3 tile preview for seam inspection
- **Animation controls**
  - loop phase
  - loop duration
  - evolution count
  - preview playback
- **Export formats**
  - PNG sequence (ZIP)
  - Sprite sheet (PNG)
  - Raw R8
  - Raw RGBA8
  - Raw R32F
- **Desktop packaging**
  - Windows executable
  - NSIS installer
  - local self-signed signing workflow

---

## Tech stack

- **TypeScript**
- **Vite**
- **Vanilla DOM UI + CSS**
- **WebGL2**
- **GLSL ES 3.00 shaders**
- **Tauri** for desktop packaging
- **fflate** for ZIP export

---

## Requirements

### Runtime
- A browser or desktop environment with **WebGL2** support
- Modern GPU drivers / hardware acceleration enabled

### Development
- **Node.js** 18+
- **npm**
- For desktop builds: **Rust toolchain**
- For signed Windows releases: **Windows SDK signing tools** (`signtool.exe`)

---

## Quick start

### Run the web app in development
```powershell
npm install
npm run dev
```

Then open the local Vite URL shown in the terminal.

### Build the web app
```powershell
npm run build
```

### Preview the built web app
```powershell
npm run preview
```

---

## Desktop app (Tauri)

### Run the desktop app in development
```powershell
npm run tauri:dev
```

### Build the desktop executable + installer
```powershell
npm run tauri:build
```

This produces:
- executable: `src-tauri/target/release/vol3d.exe`
- installer: `src-tauri/target/release/bundle/nsis/Vol3D_1.0.0_x64-setup.exe`

### Create or reuse a local self-signed code-signing certificate
```powershell
npm run release:windows:cert
```

### Build a signed Windows release
```powershell
npm run release:windows
```

More detail is available in [`docs/windows-release.md`](docs/windows-release.md).

---

## Screenshots / demo views

### Main volume preview

![Vol3D main volume preview](docs/images/Vol3d_simple.png)

Raymarched preview of a generated volume in the main authoring view.

### Tile preview / seam inspection

![Vol3D tile preview](docs/images/Vold3d_tiled.png)

3×3×3 tile preview used to inspect how well the generated volume repeats across neighboring cubes.

---

## How to use Vol3D

### Basic workflow
1. Start with a broad base layer such as **FBM**, **Perlin**, or **Simplex**.
2. Add detail layers and combine them with blend modes like **Multiply**, **Overlay**, or **Subtract**.
3. Adjust **Scale**, **Rotation**, and **Offset** to place the structure in 3D.
4. Use the **Remap** section to isolate useful density ranges.
5. Shape the final volume using the editable **Bézier remap curve**.
6. Add **Feather** to soften boundaries or sculpt the volume into a box-like or spherical mass.
7. Preview the result in:
   - **Volume** mode for final look
   - **Slice** mode for internal structure
   - **Projection** mode for density inspection
8. Use **Tile Preview** to verify repetition visually.
9. Export when the volume is ready.

### Resolution and slice count
Available resolutions:
- `32³`
- `64³`
- `128³`
- `256³`
- `512³`

Available slice counts:
- `16`
- `32`
- `64`
- `128`
- `256`
- `512`

By default, the volume stays **cubic**. You can enable **Custom Slices** to use a non-cubic depth.

### Cutoff and contrast
The top-bar **Cutoff** and **Contrast** settings affect the stored volume density itself, not only the preview. That means they also affect exported textures.

### Tile Preview
The **Tile Preview** button is a visualization tool. It helps inspect seam continuity by showing repeated neighbors around the main volume. It does **not** change the generated texture itself.

---

## Controls and shortcuts

### Keyboard
- `Tab` — cycle preview mode
- `T` — toggle 3×3×3 tile preview
- `F` — reset / focus the camera
- `Delete` — delete selected layer
- `Ctrl+D` — duplicate selected layer
- `Ctrl+Shift+N` — add a new default layer
- `Ctrl+E` — open export dialog

### Viewport
- `LMB drag` — orbit / grab the volume depending on camera mode
- `RMB drag` — pan the view
- `Mouse wheel` — zoom
- `Double-click` — reset camera

### Sliders and curves
- Drag a slider to adjust continuously
- Hold `Shift` while dragging for finer control
- Use the mouse wheel over a slider to nudge by one step
- Double-click a slider value to type a precise number
- Right-click a slider to reset it to its default value
- Drag Bézier curve handles to shape remap / feather response
- Right-click a Bézier curve editor to reset it

### Layers
- Click a layer to select it
- Drag a layer row to reorder it
- Click the eye icon to toggle visibility
- Double-click the name to rename
- Click the blend badge to cycle blend modes
- Right-click a layer row for duplicate / move / delete actions

---

## Export formats

Current export options:
- **PNG Sequence (ZIP)** — one image per slice, zipped
- **Sprite Sheet (PNG)** — all slices packed into a single sheet
- **Raw R8** — single-channel grayscale bytes
- **Raw RGBA8** — 4-channel byte data
- **Raw R32F** — 32-bit float single-channel data

Desktop builds use **native save dialogs**.
Web builds fall back to normal browser downloads.

Preset import/export also supports native file dialogs in the desktop build.

---

## Repository structure

```text
src/
  core/
    export/        Volume export pipeline
    renderer/      WebGL setup, shader compilation, volume generation
    volume/        Slice buffers and 3D texture management
  shaders/
    common/        Shared GLSL helpers
    distortion/    Domain warping and spatial distortions
    generation/    Volume generation and compositing shaders
    noise/         Procedural noise implementations
    preview/       Raymarch, slice, and projection shaders
  state/           App state and preset management
  types/           Shared TypeScript types
  ui/
    components/    Reusable UI controls
    panels/        Top bar, properties, layers
    styles/        Application CSS
    viewport/      Preview rendering and camera controls
  utils/           General helpers
src-tauri/
  Desktop wrapper, Tauri config, Windows packaging assets
scripts/windows/
  Self-signed cert creation and release signing scripts
docs/
  Packaging and release notes
```

---

## Browser vs desktop behavior

### Web build
- runs entirely in the browser
- exports through browser downloads
- preset import uses file input fallback

### Desktop build
- packaged with Tauri
- uses native Windows save/open dialogs
- can produce `.exe` and NSIS installer artifacts
- supports local self-signed Windows signing

---

## Troubleshooting

### “WebGL2 Required” appears
Your browser or GPU does not currently provide a WebGL2 context.

Try:
- current Chrome / Edge / Firefox
- enabling hardware acceleration
- updating GPU drivers
- avoiding remote desktop / VM graphics fallback environments

### Volume looks washed out or too faint
Check:
- global **Cutoff**
- global **Contrast**
- preview **Density**
- layer **Opacity** and **Blend Mode**
- remap ranges and curves

### Tiling preview looks wrong
Remember that **Tile Preview** only visualizes neighboring repetitions. Use it to inspect seams, but shape and remap settings still control how readable those seams are.

### Signed Windows release fails
Check:
- `signtool.exe` is installed
- your certificate exists in `Cert:\CurrentUser\My`
- or `VOL3D_CERT_THUMBPRINT` / `VOL3D_SIGN_SUBJECT` is set correctly

### Desktop build works but SmartScreen still warns
That is expected with a **self-signed** certificate. Self-signed signing is useful for internal/testing distribution, but it does not create public reputation like a commercial certificate.

---

## Current status / roadmap notes

Recent focus areas include:
- non-cubic volume support
- cubic-by-default slice locking
- better non-cubic preview proportions
- edge feather and curve shaping
- tiling preview
- global cutoff / contrast shaping
- loopable animation controls and preview playback

Still planned / deferred:
- animated export pipeline
- stronger 4D / cyclic-noise options later
- OpenVDB via a helper/converter workflow
- ultra-high offline-only resolutions

See [`FutureFeatures.md`](FutureFeatures.md) for the full carry-forward list.

---

## Development notes

This repository is currently optimized around:
- a fast shader-driven authoring workflow
- browser-first iteration
- Windows desktop packaging for distribution

If you are extending the project, keep changes aligned with:
- WebGL2 compatibility
- browser + desktop dual operation
- minimal-friction export workflows
- preserving current layer/preset behavior when changing data schemas

---

## License / repository note

This repository is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for the full text.

That means the project is permissively licensed, but third-party dependency licenses still matter for redistribution. See [`docs/third-party-licenses.md`](docs/third-party-licenses.md) for the current dependency audit.

