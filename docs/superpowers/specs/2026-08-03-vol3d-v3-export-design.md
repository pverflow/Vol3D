# Vol3D v3 — Export — Design

**Date:** 2026-08-03
**Status:** Approved (user picked all three formats: rendered flipbook + sprite-sheet PNG + raw volume; build phased SP1 → SP2).

## Goal

Get assets *out* of v3 — the missing product value (v3 can currently produce nothing). Two subsystems: **GPU→CPU readback** and (SP2) **offscreen render**. Export is an explicit user action, so readback is allowed here — the "zero readback" rule governs only the live render loop, which is untouched.

## Phasing

- **SP1 — Volume export:** readback the live volume texture (at the current phase) once → **sprite-sheet PNG** (tonemapped, tiled Z-slices) + **raw volume bytes** (`RGBA16F` / `RGBA8` / `R8` + a `.json` sidecar). This is the "3D-texture asset" — the highest-value output and the readback infrastructure SP2 reuses.
- **SP2 — Rendered flipbook (later):** for each loop frame, render the raymarch offscreen into an RGBA8 target → readback → tile into a sprite sheet PNG + a JSON sidecar (fps/frames/cols/loop_seconds). Reuses SP1's readback + encode + save; adds the offscreen render pass.

**This spec details SP1.** SP2 gets its own spec after SP1's GPU test.

## Architecture (SP1)

New module `v3/src/export.rs` (single file; split if it grows). Pure-CPU encode/tonemap functions are unit-tested; the GPU readback + platform save are thin glue driven from `app.rs`.

### Readback (`export.rs`)

- The volume texture (`Renderer.volume.texture`, `Rgba16Float`, `dims:[u32;3]`) gains `wgpu::TextureUsages::COPY_SRC` (added in `volume.rs::make_volume_texture` — a superset; live render/generation unchanged).
- `copy_texture_to_buffer` copies all depth layers into a mapped-readback buffer. Row stride must be 256-aligned: `unpadded_bpr = width * 8` (RGBA16F = 8 B/texel), `padded_bpr = align_up(unpadded_bpr, 256)`, `rows_per_image = height`; buffer size = `padded_bpr * height * depth`.
- **State machine**, driven at the top of `Vol3dApp::ui` (eframe 0.35 uses `App::ui(&mut self, ui, frame)`, not `update`; render state via `frame.wgpu_render_state()`):
  - `Idle` → on an export request: create the readback buffer, encode + submit the copy, `buffer.map_async(Read, cb)` where `cb` sets an `Arc<AtomicBool>` (mapped-ready flag); store `Awaiting { buffer, dims, padded_bpr, ready, request }`.
  - each frame while `Awaiting`: `device.poll(<wgpu 29 non-blocking poll>)`; when `ready` is set → read the mapped range, **un-pad** rows into a tight `Vec<u8>` (RGBA16F bytes, X-fastest → Y → Z), `unmap`, then encode(request) + save, back to `Idle`.
  - (Native has `pollster`, but the same poll-each-frame path is used on both targets — it completes in ~1–2 frames, imperceptible, and avoids a second code path.)
- Nothing polls the device today; export introduces the first poll. It runs only while a job is `Awaiting`.

### Encoders (`export.rs`, pure CPU — unit-tested)

- **CPU tonemap** (exact port of `raymarch.wgsl`): `aces(x) = clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0, 1)` per channel; `ldr = pow(aces(rgb * exposure), 1/2.2)`; `u8 = round(clamp(ldr,0,1) * 255)`. Density/alpha → `round(clamp(density,0,1)*255)` (linear, no tonemap). RGBA16F halves decoded to f32 via the `half` crate.
- **`encode_spritesheet_png(rgba16f_bytes, dims, cols, exposure) -> Vec<u8>`** — tile the `depth` Z-slices into a grid: `cols` (default `ceil(sqrt(depth))`, user-editable), `rows = ceil(depth/cols)`; sheet = `(cols*width) × (rows*height)` RGBA8; slice *z* goes at cell `(z%cols, z/cols)`, left→right, top→bottom; each texel tonemapped as above. Encode with the `png` crate (8-bit RGBA). Cells past `depth` are transparent.
- **`encode_raw(rgba16f_bytes, dims, fmt) -> (Vec<u8>, String)`** — `fmt ∈ {Rgba16f, Rgba8, R8}`:
  - `Rgba16f`: the tight readback bytes verbatim (lossless HDR, linear).
  - `Rgba8`: per-texel tonemapped RGBA8 (4 B/texel).
  - `R8`: density only, `round(clamp(density,0,1)*255)` (1 B/texel).
  - Byte order X-fastest → Y → Z (standard 3D-texture upload order). Returns the bytes + a `.json` sidecar string `{"dims":[w,h,d],"format":"rgba16f","layout":"x-fastest,y,z"}` so an importer knows the layout.

### Save (`export.rs`, platform-split)

- `save_bytes(basename, ext, bytes)`:
  - **native** (`cfg(not(wasm32))`): `std::fs::write` to the current dir (`./<basename>.<ext>`); `log::info!` the absolute path. (No file-picker dialog in v1; `rfd` is a later add if the user wants to choose location.)
  - **web** (`cfg(wasm32)`): make a `js_sys::Uint8Array` → `web_sys::Blob` → `Url::create_object_url_with_blob` → a synthesized `<a download=basename.ext>` clicked → `revoke_object_url`. New web-sys features: `Blob`, `BlobPropertyBag`, `Url`, `HtmlAnchorElement`, `HtmlElement`, `Document`, `Element`.
- The sprite-sheet writes the PNG; raw writes the data file **and** its `.json` sidecar (two saves).

### UI (`app.rs`)

An **Export** section (a collapsing header or a row in an existing panel — implementer matches the panel style): buttons **Sprite-sheet PNG**, **Raw RGBA16F**, **Raw RGBA8**, **Raw R8**; a **cols** `DragValue` (default `ceil(sqrt(depth))`, min 1) for the sprite sheet. A click sets the export request (captured into the state machine) and shows a brief "exporting…/exported <name>" status. Exposure (existing) feeds the tonemap so the PNG matches the viewport.

## Dependencies

- `png = "0.17"` (PNG encode; pure Rust, `miniz_oxide`, wasm-ok).
- `half = "2"` (RGBA16F half→f32 decode; tiny, wasm-ok).
- `serde_json` (already present) for the sidecar.
- web-sys feature additions above.

## Scope

**In (SP1):** volume readback (state machine, both targets); sprite-sheet PNG (tonemapped, tiled Z-slices, editable cols); raw `RGBA16F`/`RGBA8`/`R8` + JSON sidecar; native fs + web Blob download; Export UI; `COPY_SRC` on the volume texture; CPU tonemap = shader port; `png`+`half` deps.
**Out (SP1):** rendered flipbook (SP2); file-picker dialog (`rfd`); 16-bit PNG; EXR; import; presets; per-format options beyond cols. Live render/generation semantics unchanged.

## Testing

- **Unit (Rust, pure CPU):** `align_up`/row-stride math; un-pad indexing (padded→tight for a synthetic 3×2×2 with a non-256 row); `tonemap` matches hand-computed values (e.g. mid-gray, a >1 HDR value rolls off ≤1); `encode_spritesheet_png` on a 2×2×2 volume → PNG decodes to the expected `(cols*2)×(rows*2)` dims and known corner pixels; `encode_raw` lengths (`Rgba16f`=`w*h*d*8`, `Rgba8`=`*4`, `R8`=`*1`) + byte order + sidecar JSON parses with the right dims/format; native `save_bytes` writes a temp file with the exact bytes.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`. `naga` unaffected (no shader change in SP1). wasm build must link with the new web-sys features.
- **User GPU run:** export a sprite-sheet PNG → opens, shows the volume's Z-slices tiled, looks like the viewport (tonemapped, no flat-white clip); raw RGBA16F + sidecar write with the right size; on web the browser downloads the files; a tall non-cubic volume tiles correctly; export doesn't stall or hitch the render (completes in ~a frame).

## Success criteria

- One click produces a correct sprite-sheet PNG and raw volume files (both platforms); the PNG matches the viewport tonemap; readback never blocks the render loop meaningfully; live render/generation unchanged; both `cargo check` + clippy + tests green.

## Risks

- **Row alignment (256):** the classic readback bug — wrong un-pad = skewed/garbage image. Unit-tested with a non-256-aligned width.
- **wasm async readback:** `map_async` can't block on web; the poll-each-frame state machine handles it. Reviewer checks the job can't be double-submitted and the buffer is unmapped before reuse.
- **Half-float decode:** use `half` (correct on subnormals/inf) rather than a hand-rolled bit-twiddle.
- **Tonemap parity:** the CPU port must equal the shader (same aces constants + `1/2.2`) so the PNG matches the viewport — reviewer diffs the constants.
- **Web-sys feature gaps:** missing a feature = wasm link error; listed explicitly above.
