# AGENTS.md

## Big picture
- `Vol3D` is a browser-first WebGL2 volume-noise authoring app with a thin Tauri wrapper for Windows packaging; most behavior lives in `src/`, while `src-tauri/` mainly adds native dialogs/fs plugins and bundling.
- App bootstrap is in `src/main.ts`: it creates one `StateManager`, wires its dirty callback to `Viewport.scheduleGeneration()`, then instantiates `TopBar`, `Viewport`, `PropertiesPanel`, and `LayerPanel`.
- State is the backbone. `src/state/StateManager.ts` is a keyed pub/sub store, not a framework state library. UI classes subscribe to keys and rebuild/sync DOM manually.

## Data flow and rendering
- Regeneration is intentionally selective: `StateManager.update()` only schedules volume generation for `layers`, `settings`, and `animation.evolutions`; `preview` and `camera` updates are render-only.
- `Viewport` owns the runtime render stack: `WebGLContext` + `ShaderCompiler` + `VolumeGenerator` + `VolumeTexture` (`src/ui/viewport/Viewport.ts`).
- `VolumeGenerator` does not render the final preview directly. It renders each Z slice into a 2D `SliceBuffer`, composites visible layers, reads pixels back, applies top-bar `cutoff`/`contrast`, then uploads red-channel bytes into the 3D texture (`src/core/renderer/VolumeGenerator.ts`).
- Preview shaders (`raymarch`, `slice`, `projection`) read that stored 3D texture, so top-bar `Cutoff`/`Contrast` affect exports too, not just the viewport.
- Tile preview is preview-only (`preview.showTilePreview` in `Viewport` / `TopBar`); it should never change generated/exported voxel data.
- Animation preview uses a precomputed cache in `Viewport` capped by a ~96 MB budget. If you change animation/state inputs, review `getAnimationCacheKey()` and cache invalidation paths.

## Project-specific coding patterns
- Vanilla DOM only: panels/components create elements directly and subscribe to state (`src/ui/panels/*.ts`, `src/ui/components/*.ts`). Preserve this style unless a task explicitly requires a larger refactor.
- Right-click reset is a real UX convention, not a one-off. Examples: `attachNumberReset()` / `attachRangeReset()` in `TopBar.ts` and `Viewport.ts`; keep it when adding numeric/range controls.
- Preset/schema compatibility matters. `StateManager.loadState()` normalizes old/new state shapes, including legacy remap curves and `edgeFeather` fallback. Extend normalization when changing serialized state.
- Layer list order is reversed for display (`LayerPanel.render()`), but the underlying `layers` array is the source of truth for generation. Be careful when touching reorder logic.
- If you add a noise/distortion/remap uniform, trace the full path: `src/types/*` -> `defaultLayer`/`defaultState` -> panel/top-bar controls -> `VolumeGenerator` uniform upload -> `ShaderCompiler` assembly -> GLSL usage.
- New noise/distortion types usually require updates in multiple places: enums in `src/types/`, labels/colors in `src/utils/colorMap.ts`, shader snippet maps in `src/core/renderer/ShaderCompiler.ts`, and relevant UI selectors.

## Integration boundaries
- Use `src/platform/fileAccess.ts` for save/open flows. It switches between browser downloads/file input and Tauri native dialogs/fs at runtime; do not call Tauri plugins directly from feature code unless you are extending the abstraction.
- Export UI is event-driven, not directly coupled: `TopBar` dispatches `vol3d-show-export` / `vol3d-export`, and `Viewport` performs the export with `ExportManager`.
- Presets are split between built-ins in `src/state/PresetManager.ts`, user presets in `localStorage`, and JSON import/export through `fileAccess`.
- Tauri currently only registers `dialog` and `fs` plugins in `src-tauri/src/main.rs`; keep desktop additions minimal and mirrored with browser fallbacks.

## Workflows agents should use
- Web dev: `npm install`, `npm run dev`
- Production web build: `npm run build`; preview with `npm run preview`
- Desktop dev/build: `npm run tauri:dev`, `npm run tauri:build`
- Windows release/signing: `npm run release:windows:cert`, then `npm run release:windows`
- Useful signing env vars from `docs/windows-release.md` / `src-tauri/windows/sign-vol3d.ps1`: `VOL3D_SIGN_SUBJECT`, `VOL3D_CERT_THUMBPRINT`, `VOL3D_TIMESTAMP_URL`, `VOL3D_REQUIRE_SIGNING`
- There is no dedicated automated test script in `package.json`; the repo’s documented minimum validation is `npm run build`, plus `npm run tauri:build` for desktop/file-access/signing changes.

## When changing docs or UX
- Keep `README.md` and help text in `TopBar.showHelpModal()` aligned with any new shortcuts, export behavior, or desktop workflow changes.
- Keep browser + desktop behavior both working; this repo explicitly treats graceful desktop-only enhancements with browser fallback as a requirement.

