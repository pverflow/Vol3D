# Vol3D v3 — Export SP1: Volume Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Export the live volume texture (current phase) to a **sprite-sheet PNG** (tonemapped, tiled Z-slices) and **raw bytes** (`RGBA16F`/`RGBA8`/`R8` + `.json` sidecar), on native (fs) and web (download), via a poll-based GPU→CPU readback that never blocks the render loop.

**Spec:** `docs/superpowers/specs/2026-08-03-vol3d-v3-export-design.md`.

**Tech Stack:** Rust 1.97, `wgpu =29.0.4`, `egui`/`eframe` `=0.35.0`, `png`, `half`, `serde_json`, `web-sys`. All under `v3/`.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green. No shader change (SP1) → `naga` unaffected.
- **Live render + generation semantics unchanged.** Adding `COPY_SRC` to the volume texture usage is a superset (no behavior change). Readback runs only while an export job is in flight.
- **CPU tonemap MUST equal `raymarch.wgsl`:** `aces(x)=clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0,1)`; `ldr=pow(aces(rgb*exposure), 1.0/2.2)`; `u8=round(clamp(ldr,0,1)*255)`. Density→`round(clamp(d,0,1)*255)` (linear).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/Cargo.toml              # MOD: png, half deps; web-sys feature additions
v3/src/render/volume.rs    # MOD: volume texture usage += COPY_SRC
v3/src/export.rs           # NEW: readback job + un-pad; tonemap; encode_spritesheet_png; encode_raw; save_bytes; tests
v3/src/main.rs (or lib)    # MOD: `mod export;`
v3/src/app.rs              # MOD: export state machine in ui(); Export UI section
v3/RUN.md                  # MOD (Task 4)
```

---

## Task 1: Deps + COPY_SRC + pure-CPU encode/tonemap core (TDD)

**Files:** `v3/Cargo.toml`, `v3/src/render/volume.rs`, `v3/src/export.rs`, module registration (`main.rs`/`lib.rs`).

**Interfaces produced:**
- `pub struct VolumeData { pub dims: [u32;3], pub rgba16f: Vec<u8> }` (tight, X-fastest→Y→Z, 8 B/texel).
- `pub fn align_up(n: u32, a: u32) -> u32`
- `pub fn unpad_rows(padded: &[u8], dims: [u32;3], padded_bpr: u32, bytes_per_texel: u32) -> Vec<u8>`
- `pub fn tonemap_texel(rgba16f_texel: [half::f16;4], exposure: f32) -> [u8;4]`
- `pub enum RawFmt { Rgba16f, Rgba8, R8 }`
- `pub fn encode_spritesheet_png(vol: &VolumeData, cols: u32, exposure: f32) -> Vec<u8>`
- `pub fn encode_raw(vol: &VolumeData, fmt: RawFmt) -> (Vec<u8>, String)` (bytes + sidecar JSON)

- [ ] **Step 1: deps + COPY_SRC** — `Cargo.toml`: add `png = "0.17"` and `half = { version = "2", features = ["bytemuck"] }` to `[dependencies]`; extend the wasm `web-sys` features to `["Window", "Storage", "Blob", "BlobPropertyBag", "Url", "HtmlAnchorElement", "HtmlElement", "Document", "Element"]`. In `volume.rs::make_volume_texture`, change the volume texture `usage` to `wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC`. Register the module (`mod export;`).
- [ ] **Step 2: stride/un-pad (TDD)** — write `align_up` (`(n + a - 1) / a * a`) and `unpad_rows`. Test: `align_up(24,256)==256`, `align_up(256,256)==256`, `align_up(300,256)==512`. `unpad_rows`: a synthetic `dims=[3,2,2]`, `bytes_per_texel=8` → `unpadded_bpr=24`, `padded_bpr=align_up(24,256)=256`; build a `256*2*2`-byte buffer where each row's first 24 bytes are `z*100 + y*10 + [0..24)` and the pad is `0xFF`; assert `unpad_rows` returns `24*2*2` bytes with the pad stripped and the row order preserved. Run → fail → implement → pass.
- [ ] **Step 3: tonemap (TDD)** — `tonemap_texel`: decode each `f16`→f32, apply the Global-Constraints formula. Test: `tonemap_texel([f16(0.0);4], 1.0)` → `[0,0,0,0]`; a mid value `rgb=0.5` (alpha 1.0) matches hand-computed `round(pow(aces(0.5),1/2.2)*255)`; a bright HDR `rgb=4.0` with `exposure=1.0` gives `aces(4.0)` near but ≤1 so the channel is high but **not** overflowing (`<=255`), proving rolloff; alpha is linear (`density=0.5`→`128`). Run → fail → implement → pass.
- [ ] **Step 4: raw encode (TDD)** — `encode_raw`. Test on a 2×2×2 `VolumeData`: `Rgba16f` len `== 2*2*2*8 == 64` and bytes equal the input; `Rgba8` len `== 32`; `R8` len `== 8`; the sidecar string parses via `serde_json::from_str::<serde_json::Value>` and has `dims==[2,2,2]` and the matching `format`. Run → fail → implement → pass.
- [ ] **Step 5: sprite-sheet encode (TDD)** — `encode_spritesheet_png`. Test on a 2×2×2 volume, `cols=2` → `rows=ceil(2/2)=1`, sheet `= (2*2) × (1*2) = 4×2`; decode the produced PNG with the `png` crate (reader in a `#[cfg(test)]`) and assert width==4, height==2, color type RGBA, and that slice-0's top-left texel decodes to its tonemapped value. Also `cols=1` on depth 2 → `rows=2`, sheet `2×4`. Run → fail → implement → pass.
- [ ] **Step 6: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): export core — readback un-pad, CPU tonemap, sprite-sheet PNG + raw encoders (COPY_SRC volume, png/half deps)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: GPU readback job (state machine) + save

**Files:** `v3/src/export.rs`.

**Interfaces produced:**
- `pub struct ExportRequest { pub kind: ExportKind, pub cols: u32, pub exposure: f32 }`; `pub enum ExportKind { SpritePng, Raw(RawFmt) }`.
- `pub struct ReadbackJob { buffer: wgpu::Buffer, dims: [u32;3], padded_bpr: u32, ready: std::sync::Arc<std::sync::atomic::AtomicBool>, request: ExportRequest }`
- `ReadbackJob::begin(device, queue, texture: &wgpu::Texture, dims, request) -> ReadbackJob` (creates the readback buffer, encodes `copy_texture_to_buffer` with `bytes_per_row = padded_bpr`, `rows_per_image = height`, submits, calls `map_async(Read, cb)` setting `ready`).
- `ReadbackJob::poll_take(&self, device) -> Option<VolumeData>` (`device.poll(<non-blocking>)`; if `ready` → map the range, `unpad_rows` into a `VolumeData`, `unmap`, return `Some`; else `None`).
- `pub fn save_bytes(basename: &str, ext: &str, bytes: &[u8])` (cfg native fs / web download).
- `pub fn run_export(vol: &VolumeData, request: &ExportRequest)` — matches `kind`: `SpritePng` → `encode_spritesheet_png` → `save_bytes("vol3d_volume","png",..)`; `Raw(fmt)` → `encode_raw` → `save_bytes(name, ext, data)` **and** `save_bytes(name, "json", sidecar.as_bytes())` (name/ext per fmt: `vol3d_volume_rgba16f.raw`, `_rgba8.raw`, `_r8.raw`).

- [ ] **Step 1: ReadbackJob** — implement `begin`/`poll_take`. Use `wgpu::TexelCopyTextureInfo`/`TexelCopyBufferInfo` + `TexelCopyBufferLayout { offset:0, bytes_per_row: Some(padded_bpr), rows_per_image: Some(height) }` (match the exact wgpu 29.0.4 type names used elsewhere in the repo — grep `copy_` / `ImageCopy` / `TexelCopy` in `src/render/` for the version's spelling). `ready` set inside the `map_async` closure. For the non-blocking poll use the wgpu 29 poll form (grep the crate/docs; e.g. `device.poll(wgpu::PollType::Poll)` or `wgpu::Maintain::Poll` — whichever this version exposes). Buffer usage `MAP_READ | COPY_DST`.
- [ ] **Step 2: save_bytes** — native (`cfg(not(target_arch="wasm32"))`): `std::fs::write(format!("./{basename}.{ext}"), bytes)`, `log::info!` the `std::fs::canonicalize` path (fall back to the relative path on error). web (`cfg(target_arch="wasm32")`): `Uint8Array::from(bytes)` → `Blob::new_with_u8_array_sequence_and_options` (array-of-array via `js_sys::Array`) → `Url::create_object_url_with_blob` → create an `HtmlAnchorElement` via `document.create_element("a")`, set `href`+`download`, `.click()`, then `Url::revoke_object_url`. Mirror the web-sys access style in `persistence.rs`.
- [ ] **Step 3: run_export** — the match above. (No new test infra required beyond Task 1's encoder tests; `save_bytes` native path: a test writes to a `std::env::temp_dir()` file and reads it back equal. Keep `run_export` thin.)
- [ ] **Step 4: native save test (TDD)** — test `save_bytes` writes exact bytes to a temp path and they read back identical (native only; `#[cfg(all(test, not(target_arch="wasm32")))]`). Run → pass.
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): export readback job (poll-based, non-blocking) + native/web save

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire into the app — state machine in ui() + Export UI

**Files:** `v3/src/app.rs`.

- [ ] **Step 1: state** — add `Vol3dApp.export_job: Option<export::ReadbackJob>` (default `None`), `pending_export: Option<export::ExportRequest>` (set by a UI click), `export_status: String` (default empty), `export_cols: u32` (default 0 = "auto = ceil(sqrt(depth))"). Import `crate::export`.
- [ ] **Step 2: drive the state machine at the top of `ui()`** — after the frame-time EMA / `request_repaint`, before the panels:
  - If `export_job` is `Some`, get `rs = frame.wgpu_render_state()`; `if let Some(vol) = job.poll_take(&rs.device)` → `export::run_export(&vol, &job.request); self.export_status = format!("exported {}", ...); self.export_job = None;`.
  - Else if `self.pending_export` is `Some(req)` and `export_job` is `None`: get `rs`, and the volume texture — `let mut w = rs.renderer.write(); let r = w.callback_resources.get::<crate::render::Renderer>().unwrap();` read `&r.volume.texture` + `self.committed_dims` (the live dims). Build `let job = export::ReadbackJob::begin(&rs.device, &rs.queue, &r.volume.texture, self.committed_dims, req);` (drop the `RwLock` write guard before storing). `self.export_job = Some(job); self.pending_export = None; self.export_status = "exporting…".into();`.
  - Borrow note: `frame.wgpu_render_state()` returns `Option<&RenderState>`; scope the `renderer.write()` guard so it drops before you touch `self.export_*`. If a texture handle must outlive the guard, `.clone()` the `wgpu::Texture` (it's an `Arc` handle — cheap) before dropping the guard, then pass the clone to `begin`.
- [ ] **Step 3: Export UI** — an **Export** collapsing section (match the existing panel/collapsing style; near the other bottom/side controls). Compute `default_cols = ceil(sqrt(depth))` from `self.committed_dims[2]`; a **cols** `DragValue` bound to `self.export_cols` (0 shows as "auto"; the effective cols = `if self.export_cols==0 { default_cols } else { self.export_cols }`). Buttons: **Sprite-sheet PNG** → `self.pending_export = Some(ExportRequest{kind:SpritePng, cols: effective, exposure: self.exposure})`; **Raw RGBA16F** / **Raw RGBA8** / **Raw R8** → `Raw(fmt)` (cols unused). Show `self.export_status` as a small label. Disable the buttons while `export_job.is_some()`.
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): export UI + in-frame readback state machine (sprite-sheet/raw, non-blocking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document Export (SP1): an **Export** section with **Sprite-sheet PNG** (tiled Z-slices, tonemapped to match the viewport, editable **cols**) + **Raw RGBA16F/RGBA8/R8** (+ a `.json` sidecar with dims/format). Native writes files to the run dir (path logged); web downloads them. Note it exports the volume at the **current phase**, doesn't block the render, and the rendered-flipbook export is SP2 (next). Ask the user to report: the PNG opens and shows the volume's slices tiled looking like the viewport (no flat-white clip); raw + sidecar write with the right size; web downloads work; a tall non-cubic volume tiles right; no render hitch on export.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): export SP1 (volume) run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** COPY_SRC + deps (T1 S1) ✓; stride/un-pad (T1 S2) ✓; CPU tonemap = shader port (T1 S3) ✓; raw encode + sidecar (T1 S4) ✓; sprite-sheet PNG (T1 S5) ✓; readback state machine + poll (T2 S1) ✓; native/web save (T2 S2) ✓; run_export dispatch (T2 S3) ✓; app wiring + Export UI (T3) ✓; GPU run (T4) ✓; no shader change ✓.
**Placeholder scan:** the two version-specific spellings (wgpu 29 texel-copy types + the non-blocking poll form) are called out as "grep the repo / match this version" rather than guessed — appropriate, they're mechanical lookups the implementer resolves against the installed crate. Everything else is concrete (formulas, byte lengths, feature list, test values).
**Type consistency:** `VolumeData`/`RawFmt`/`tonemap_texel`/`encode_*` (T1) consumed by `run_export`/`ReadbackJob` (T2) and the app (T3); `ExportRequest`/`ExportKind`/`ReadbackJob` (T2) stored in `Vol3dApp` + driven in `ui()` (T3); `committed_dims` is the live dims source (T3); `self.exposure` feeds the tonemap (T1/T3).
