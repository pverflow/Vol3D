# Future Features

This file tracks deferred or larger-scope feature work for the volume generator.

## Current direction

Recently completed / in progress:
- Non-cubic volume data support
- Cubic-by-default slice locking
- Better non-cubic preview proportions
- Edge feather
- Tiling preview
- Global cutoff / contrast shaping
- Loopable animation controls and preview playback

## Context carry-forward TODO (2026-04-09)

Use this section as a short handoff list if conversation context is lost.

Recent UI bugfix batch / carry-forward:
- [x] Move add-layer button/menu so the popup stays inside the frame.
- [x] Move per-layer opacity and blend controls into the layer row.
- [x] Replace blend-mode click-cycling with a popup selector.
- [x] Cap inline layer renaming to 16 characters.
- [x] Fix Bézier curve handle dragging / snapping behavior.
- [x] Stop rebuilding the whole layer list on every small layer update to remove row flicker.

- [ ] Finish animated export / frame sequence generation so looping previews can be rendered out, not just scrubbed in-app.
- [ ] Add export controls for FPS, total frame count, and/or duration so animation export settings are explicit.
- [ ] Make sure exported animation timing matches preview playback and scrubbing behavior.
- [ ] Consider saving animation settings in export metadata sidecars alongside dimensions, cutoff/contrast, tileability, and seed values.
- [ ] Keep stronger 4D / cyclic-noise support as an optional later upgrade rather than blocking the current looping workflow.
- [ ] Revisit OpenVDB only through a converter / helper pipeline, not as a small browser-only feature.
- [ ] Revisit 1024^3+ generation only as chunked offline/export-only work with no expectation of realtime preview.

## Active feature track

### 1. Looping time-based animation
Priority: High
Status: In progress

Current scope:
- Loop duration in seconds
- Number of evolutions / cycles
- Preview scrubbing / playback

Still to do:
- Animated export / frame sequence pipeline
- FPS / frame count export controls
- Optional stronger 4D/cyclic-noise implementation later

## Deferred features

### 2. OpenVDB export
Priority: Medium
Status: Deferred for now

Reason:
- Likely requires a different pipeline (WASM/native helper/converter tool)
- Not a good small incremental feature for the current browser-first app

Recommended path:
- Keep current raw/slice exports
- Add converter or companion tool later

### 3. Offline / export-only ultra-high resolutions
Priority: Medium
Status: Deferred

Scope:
- 1024^3
- 2048^3

Reason:
- Interactive browser memory budget is too high for these resolutions
- Should be revisited only as chunked/offline/export-only generation

Recommended path:
- Chunked generation
- Worker/WASM/native helper
- Possibly no realtime preview at those sizes

## Possible polish / smaller follow-ups

### 4. Projection UX polish
Potential improvements:
- Rename modes to `Max Density` / `Average Density`
- Stronger help text / tooltips
- Optional histogram or normalization controls

### 5. Tiling diagnostics
Potential improvements:
- Outline repeated cubes in tile preview
- Show edge/corner mismatch highlights
- Difference view for seams

### 6. Export metadata bundle
Potential improvements:
- Save JSON metadata alongside raw exports
- Include dimensions, slice count, tileable flag, cutoff, contrast, and seed values
- Useful precursor for future converter tooling (including OpenVDB)

