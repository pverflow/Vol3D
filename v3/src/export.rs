// Export (Export SP1): pure-CPU encode/tonemap core (task 1) — un-pad a padded GPU readback,
// tonemap an RGBA16F texel to match the viewport (`raymarch.wgsl`), and encode a tiled
// sprite-sheet PNG or raw bytes + JSON sidecar — plus the GPU readback job and platform save
// (task 2): a non-blocking poll-based state machine that copies a render target into a
// `MAP_READ` buffer and, once mapped, hands back a `VolumeData` for the encoders above.
// Nothing here is wired into `app.rs` yet (that's task 3), so `allow(dead_code)` still applies.
#![allow(dead_code)]

/// Tight (no row padding) RGBA16F volume bytes, X-fastest -> Y -> Z, 8 bytes/texel.
/// Produced by the (later) GPU readback + `unpad_rows`; consumed by the encoders below.
pub struct VolumeData {
    pub dims: [u32; 3],
    pub rgba16f: Vec<u8>,
}

/// Raw-bytes export format for `encode_raw`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawFmt {
    Rgba16f,
    Rgba8,
    R8,
}

impl RawFmt {
    fn as_str(self) -> &'static str {
        match self {
            RawFmt::Rgba16f => "rgba16f",
            RawFmt::Rgba8 => "rgba8",
            RawFmt::R8 => "r8",
        }
    }
}

/// What `run_export` should encode once a `VolumeData` readback lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportKind {
    SpritePng,
    Raw(RawFmt),
}

/// User-facing export choice, captured at the moment a readback is kicked off (`ReadbackJob`
/// carries this alongside the in-flight GPU copy so `run_export` knows what to do once the
/// bytes are back). No `Eq` (unlike `ExportKind`) — `exposure` is an `f32`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExportRequest {
    pub kind: ExportKind,
    pub cols: u32,
    pub exposure: f32,
}

/// Round `n` up to the next multiple of `a`.
pub fn align_up(n: u32, a: u32) -> u32 {
    n.div_ceil(a) * a
}

/// Strip `wgpu` buffer-readback row padding: `padded` has `padded_bpr` bytes per row (the
/// `COPY_BYTES_PER_ROW_ALIGNMENT`-aligned stride), of which only the first
/// `dims[0] * bytes_per_texel` bytes are real texel data. Rows are ordered z-major then
/// y-minor (one z-slice's `dims[1]` rows, then the next slice), matching a 3D texture copy.
/// Returns the tight buffer with padding removed and row order preserved.
pub fn unpad_rows(padded: &[u8], dims: [u32; 3], padded_bpr: u32, bytes_per_texel: u32) -> Vec<u8> {
    let unpadded_bpr = (dims[0] * bytes_per_texel) as usize;
    let padded_bpr = padded_bpr as usize;
    let rows = (dims[1] * dims[2]) as usize;
    let mut out = Vec::with_capacity(unpadded_bpr * rows);
    for row in 0..rows {
        let start = row * padded_bpr;
        out.extend_from_slice(&padded[start..start + unpadded_bpr]);
    }
    out
}

// ACES filmic tonemap (Narkowicz fit), single channel — exact port of `aces()` in
// `shaders/raymarch.wgsl`.
fn aces_channel(x: f32) -> f32 {
    ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
}

fn to_u8(unit: f32) -> u8 {
    (unit.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Tonemap one RGBA16F texel to display RGBA8, byte-exact port of `raymarch.wgsl`'s
/// `pow(aces(acc * C.exposure), vec3(1.0/2.2))` for color; density/alpha is linear
/// (`round(clamp(density,0,1)*255)`, no tonemap).
pub fn tonemap_texel(rgba16f_texel: [half::f16; 4], exposure: f32) -> [u8; 4] {
    let [r, g, b, a] = rgba16f_texel.map(half::f16::to_f32);
    let tm = |c: f32| to_u8(aces_channel(c * exposure).powf(1.0 / 2.2));
    [tm(r), tm(g), tm(b), to_u8(a)]
}

/// Read texel `index` (flat, X-fastest -> Y -> Z) out of a tight RGBA16F byte buffer.
/// wgpu writes little-endian, so each of the 4 channels is a `u16::from_le_bytes` half-float.
fn read_texel(rgba16f: &[u8], index: usize) -> [half::f16; 4] {
    let base = index * 8;
    std::array::from_fn(|c| {
        let off = base + c * 2;
        half::f16::from_bits(u16::from_le_bytes([rgba16f[off], rgba16f[off + 1]]))
    })
}

fn sidecar_json(dims: [u32; 3], format: &str) -> String {
    serde_json::json!({
        "dims": dims,
        "format": format,
        "layout": "x-fastest,y,z",
    })
    .to_string()
}

/// Encode the volume's raw bytes in `fmt` (X-fastest -> Y -> Z) plus a `.json` sidecar string
/// (`{"dims":[w,h,d],"format":"...","layout":"x-fastest,y,z"}`). `Rgba16f` returns the tight
/// readback bytes verbatim (lossless HDR); `Rgba8`/`R8` are tonemapped at `exposure = 1.0`
/// (raw exports are as-authored data, not a viewport-matched preview).
pub fn encode_raw(vol: &VolumeData, fmt: RawFmt) -> (Vec<u8>, String) {
    let [w, h, d] = vol.dims;
    let texel_count = (w * h * d) as usize;
    let bytes = match fmt {
        RawFmt::Rgba16f => vol.rgba16f.clone(),
        RawFmt::Rgba8 => (0..texel_count)
            .flat_map(|i| tonemap_texel(read_texel(&vol.rgba16f, i), 1.0))
            .collect(),
        RawFmt::R8 => (0..texel_count)
            .map(|i| tonemap_texel(read_texel(&vol.rgba16f, i), 1.0)[3])
            .collect(),
    };
    (bytes, sidecar_json(vol.dims, fmt.as_str()))
}

/// Tile the volume's `depth` Z-slices into an RGBA8 sprite-sheet PNG: `cols` columns
/// (`0` treated as `1`), `rows = ceil(depth / cols)`, sheet size `(cols*w) x (rows*h)`; slice
/// `z` goes at cell `(z % cols, z / cols)`, left-to-right then top-to-bottom. Cells beyond
/// `depth` stay fully transparent. Each texel is tonemapped via `tonemap_texel(_, exposure)`
/// so the sheet matches the live viewport at the same exposure.
pub fn encode_spritesheet_png(vol: &VolumeData, cols: u32, exposure: f32) -> Vec<u8> {
    let cols = cols.max(1);
    let [w, h, d] = vol.dims;
    let rows = d.div_ceil(cols);
    let sheet_w = cols * w;
    let sheet_h = rows * h;
    let mut sheet = vec![0u8; (sheet_w * sheet_h * 4) as usize];

    for z in 0..d {
        let cell_x = (z % cols) * w;
        let cell_y = (z / cols) * h;
        for y in 0..h {
            for x in 0..w {
                let texel_index = (z * h * w + y * w + x) as usize;
                let rgba8 = tonemap_texel(read_texel(&vol.rgba16f, texel_index), exposure);
                let dst = (((cell_y + y) * sheet_w + (cell_x + x)) * 4) as usize;
                sheet[dst..dst + 4].copy_from_slice(&rgba8);
            }
        }
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, sheet_w, sheet_h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .expect("png header write can't fail for an in-memory Vec<u8> sink");
        writer
            .write_image_data(&sheet)
            .expect("image data matches the declared width/height/color type by construction");
    }
    png_bytes
}

/// Bytes per RGBA16F texel — the only format the GPU readback copies (encoders above tonemap
/// down to RGBA8/R8 in CPU-land once the bytes are back).
const READBACK_BYTES_PER_TEXEL: u32 = 8;

/// A non-blocking GPU->CPU readback in flight: `begin` submits a `copy_texture_to_buffer` and
/// starts the async map; `poll_take` is meant to be called once per frame (or whenever
/// convenient) and returns `Some(VolumeData)` only once the map has completed, without ever
/// blocking the caller.
pub struct ReadbackJob {
    buffer: wgpu::Buffer,
    dims: [u32; 3],
    padded_bpr: u32,
    ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    request: ExportRequest,
}

impl ReadbackJob {
    /// Kick off a readback of `texture` (an RGBA16F render target sized `dims`) into a fresh
    /// `MAP_READ` buffer, and start the async map. Non-blocking: submits the copy and returns
    /// immediately: poll `poll_take` to find out when the bytes are ready.
    pub fn begin(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        dims: [u32; 3],
        request: ExportRequest,
    ) -> ReadbackJob {
        let padded_bpr = align_up(dims[0] * READBACK_BYTES_PER_TEXEL, 256);
        let size = (padded_bpr as u64) * (dims[1] as u64) * (dims[2] as u64);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("export-readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("export-readback"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bpr),
                    rows_per_image: Some(dims[1]),
                },
            },
            wgpu::Extent3d {
                width: dims[0],
                height: dims[1],
                depth_or_array_layers: dims[2],
            },
        );
        queue.submit(std::iter::once(encoder.finish()));

        let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ready_cb = ready.clone();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |res| {
            if res.is_ok() {
                ready_cb.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });

        ReadbackJob {
            buffer,
            dims,
            padded_bpr,
            ready,
            request,
        }
    }

    /// Pump the device's async work without blocking, then return the unpadded `VolumeData`
    /// once the map callback has fired — `None` while the copy/map is still in flight. Callers
    /// should stop polling this job (and drop it) once `Some` comes back: the returned buffer
    /// has already been unmapped.
    pub fn poll_take(&self, device: &wgpu::Device) -> Option<VolumeData> {
        let _ = device.poll(wgpu::PollType::Poll);
        if !self.ready.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }

        let view = self.buffer.slice(..).get_mapped_range();
        let padded: &[u8] = &view;
        let rgba16f = unpad_rows(padded, self.dims, self.padded_bpr, READBACK_BYTES_PER_TEXEL);
        drop(view);
        self.buffer.unmap();

        Some(VolumeData {
            dims: self.dims,
            rgba16f,
        })
    }

    /// The export choice this job was started for, so the caller can decide how to encode the
    /// `VolumeData` `poll_take` eventually hands back.
    pub fn request(&self) -> &ExportRequest {
        &self.request
    }
}

/// Save `bytes` as `{basename}.{ext}`: on native, a file next to the working directory; on
/// web, a browser download via a synthetic anchor click. Failures are logged, never panics.
#[cfg(not(target_arch = "wasm32"))]
pub fn save_bytes(basename: &str, ext: &str, bytes: &[u8]) {
    let path = format!("./{basename}.{ext}");
    match std::fs::write(&path, bytes) {
        Ok(()) => {
            let shown = std::fs::canonicalize(&path)
                .map(|p| p.display().to_string())
                .unwrap_or(path);
            log::info!("export: saved {shown}");
        }
        Err(e) => log::error!("export: failed to write {path}: {e}"),
    }
}

/// Save `bytes` as `{basename}.{ext}`: on native, a file next to the working directory; on
/// web, a browser download via a synthetic anchor click. Failures are logged, never panics.
#[cfg(target_arch = "wasm32")]
pub fn save_bytes(basename: &str, ext: &str, bytes: &[u8]) {
    use wasm_bindgen::JsCast;

    let array = js_sys::Array::new();
    array.push(&js_sys::Uint8Array::from(bytes));
    let blob = match web_sys::Blob::new_with_u8_array_sequence(&array) {
        Ok(blob) => blob,
        Err(e) => {
            log::error!("export: failed to build blob: {e:?}");
            return;
        }
    };
    let url = match web_sys::Url::create_object_url_with_blob(&blob) {
        Ok(url) => url,
        Err(e) => {
            log::error!("export: failed to create object url: {e:?}");
            return;
        }
    };

    let Some(document) = web_sys::window().and_then(|w| w.document()) else {
        log::error!("export: no window/document to trigger a download from");
        let _ = web_sys::Url::revoke_object_url(&url);
        return;
    };
    let anchor = document
        .create_element("a")
        .ok()
        .and_then(|e| e.dyn_into::<web_sys::HtmlAnchorElement>().ok());
    match anchor {
        Some(anchor) => {
            anchor.set_href(&url);
            anchor.set_download(&format!("{basename}.{ext}"));
            anchor.click();
        }
        None => log::error!("export: failed to create download anchor element"),
    }
    let _ = web_sys::Url::revoke_object_url(&url);
}

/// Encode `vol` per `request.kind` and hand the bytes to `save_bytes`. Raw exports also write a
/// `.json` sidecar next to the `.raw` file (same basename, `encode_raw`'s second return value).
pub fn run_export(vol: &VolumeData, request: &ExportRequest) {
    match request.kind {
        ExportKind::SpritePng => {
            let png = encode_spritesheet_png(vol, request.cols, request.exposure);
            save_bytes("vol3d_volume", "png", &png);
        }
        ExportKind::Raw(fmt) => {
            let basename = match fmt {
                RawFmt::Rgba16f => "vol3d_volume_rgba16f",
                RawFmt::Rgba8 => "vol3d_volume_rgba8",
                RawFmt::R8 => "vol3d_volume_r8",
            };
            let (bytes, sidecar) = encode_raw(vol, fmt);
            save_bytes(basename, "raw", &bytes);
            save_bytes(basename, "json", sidecar.as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn align_up_examples() {
        assert_eq!(align_up(24, 256), 256);
        assert_eq!(align_up(256, 256), 256);
        assert_eq!(align_up(300, 256), 512);
    }

    #[test]
    fn unpad_rows_strips_padding_and_preserves_row_order() {
        let dims = [3u32, 2, 2];
        let bytes_per_texel = 8u32;
        let unpadded_bpr = (dims[0] * bytes_per_texel) as usize; // 24
        let padded_bpr = align_up(unpadded_bpr as u32, 256); // 256
        let rows = (dims[1] * dims[2]) as usize; // 4 (z-major, y-minor)

        let mut padded = vec![0xFFu8; padded_bpr as usize * rows];
        for row in 0..rows {
            let z = row / dims[1] as usize;
            let y = row % dims[1] as usize;
            let base = row * padded_bpr as usize;
            for i in 0..unpadded_bpr {
                padded[base + i] = (z * 100 + y * 10 + i) as u8;
            }
        }

        let out = unpad_rows(&padded, dims, padded_bpr, bytes_per_texel);
        assert_eq!(out.len(), unpadded_bpr * rows);
        for row in 0..rows {
            let z = row / dims[1] as usize;
            let y = row % dims[1] as usize;
            let base = row * unpadded_bpr;
            for i in 0..unpadded_bpr {
                assert_eq!(
                    out[base + i],
                    (z * 100 + y * 10 + i) as u8,
                    "row {row} byte {i}"
                );
            }
        }
    }

    #[test]
    fn tonemap_zero_is_zero() {
        assert_eq!(
            tonemap_texel([half::f16::from_f32(0.0); 4], 1.0),
            [0, 0, 0, 0]
        );
    }

    #[test]
    fn tonemap_mid_gray_matches_hand_computed() {
        let texel = [
            half::f16::from_f32(0.5),
            half::f16::from_f32(0.5),
            half::f16::from_f32(0.5),
            half::f16::from_f32(1.0),
        ];
        let aces = (0.5f32 * (2.51 * 0.5 + 0.03)) / (0.5 * (2.43 * 0.5 + 0.59) + 0.14);
        let expected_rgb = (aces.powf(1.0 / 2.2).clamp(0.0, 1.0) * 255.0).round() as u8;
        assert_eq!(
            tonemap_texel(texel, 1.0),
            [expected_rgb, expected_rgb, expected_rgb, 255]
        );
    }

    #[test]
    fn tonemap_bright_hdr_rolls_off_without_overflow() {
        // aces(4.0) rolls off to <=1 (proven directly on the pre-quantization value — the u8
        // output can't overflow by construction, so that alone wouldn't prove the rolloff).
        assert!(aces_channel(4.0) <= 1.0);
        let texel = [half::f16::from_f32(4.0); 4];
        for c in &tonemap_texel(texel, 1.0)[..3] {
            assert!(*c > 200); // still a bright highlight, not crushed
        }
    }

    #[test]
    fn tonemap_alpha_is_linear() {
        let texel = [
            half::f16::from_f32(0.0),
            half::f16::from_f32(0.0),
            half::f16::from_f32(0.0),
            half::f16::from_f32(0.5),
        ];
        assert_eq!(tonemap_texel(texel, 1.0)[3], 128);
    }

    fn solid_volume(dims: [u32; 3], value: f32) -> VolumeData {
        let n = (dims[0] * dims[1] * dims[2]) as usize;
        let mut rgba16f = Vec::with_capacity(n * 8);
        for _ in 0..n {
            for _ in 0..4 {
                rgba16f.extend_from_slice(&half::f16::from_f32(value).to_bits().to_le_bytes());
            }
        }
        VolumeData { dims, rgba16f }
    }

    #[test]
    fn encode_raw_lengths_bytes_and_sidecar() {
        let vol = solid_volume([2, 2, 2], 0.25);

        let (bytes16, json16) = encode_raw(&vol, RawFmt::Rgba16f);
        assert_eq!(bytes16.len(), 2 * 2 * 2 * 8);
        assert_eq!(bytes16, vol.rgba16f);
        let v16: serde_json::Value = serde_json::from_str(&json16).unwrap();
        assert_eq!(v16["dims"], serde_json::json!([2, 2, 2]));
        assert_eq!(v16["format"], "rgba16f");

        let (bytes8, json8) = encode_raw(&vol, RawFmt::Rgba8);
        assert_eq!(bytes8.len(), 32);
        let v8: serde_json::Value = serde_json::from_str(&json8).unwrap();
        assert_eq!(v8["dims"], serde_json::json!([2, 2, 2]));
        assert_eq!(v8["format"], "rgba8");

        let (bytes1, json1) = encode_raw(&vol, RawFmt::R8);
        assert_eq!(bytes1.len(), 8);
        let v1: serde_json::Value = serde_json::from_str(&json1).unwrap();
        assert_eq!(v1["dims"], serde_json::json!([2, 2, 2]));
        assert_eq!(v1["format"], "r8");
    }

    fn decode_png(bytes: &[u8]) -> (u32, u32, png::ColorType, Vec<u8>) {
        let decoder = png::Decoder::new(bytes);
        let mut reader = decoder
            .read_info()
            .expect("valid png produced by the encoder");
        let mut buf = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut buf).expect("single-frame png");
        let info = reader.info();
        (info.width, info.height, info.color_type, buf)
    }

    #[test]
    fn spritesheet_cols2_tiles_2x2x2_into_4x2() {
        let mut vol = solid_volume([2, 2, 2], 0.0);
        // Slice 0's top-left texel (x=0,y=0,z=0) is a bright white texel; every other texel
        // stays at 0 so the corner pixel is unambiguous.
        let bits = half::f16::from_f32(1.0).to_bits().to_le_bytes();
        for c in 0..4 {
            vol.rgba16f[c * 2..c * 2 + 2].copy_from_slice(&bits);
        }

        let png_bytes = encode_spritesheet_png(&vol, 2, 1.0);
        let (width, height, color_type, buf) = decode_png(&png_bytes);
        assert_eq!(width, 4);
        assert_eq!(height, 2);
        assert_eq!(color_type, png::ColorType::Rgba);

        let expected = tonemap_texel([half::f16::from_f32(1.0); 4], 1.0);
        assert_eq!(&buf[0..4], &expected[..]);
    }

    #[test]
    fn spritesheet_cols1_stacks_2x2x2_into_2x4() {
        let vol = solid_volume([2, 2, 2], 0.0);
        let png_bytes = encode_spritesheet_png(&vol, 1, 1.0);
        let (width, height, color_type, _buf) = decode_png(&png_bytes);
        assert_eq!(width, 2);
        assert_eq!(height, 4);
        assert_eq!(color_type, png::ColorType::Rgba);
    }

    #[test]
    fn spritesheet_zero_cols_treated_as_one() {
        let vol = solid_volume([2, 2, 2], 0.0);
        let png_bytes = encode_spritesheet_png(&vol, 0, 1.0);
        let (width, height, _color_type, _buf) = decode_png(&png_bytes);
        assert_eq!(width, 2);
        assert_eq!(height, 4);
    }

    // `save_bytes` (native) writes to `./{basename}.{ext}`, so this test `cd`s into a scratch
    // dir under `std::env::temp_dir()` for the call, then restores the process cwd immediately
    // (before reading the file back or asserting) so a failed assertion can't leave the whole
    // test binary running from a deleted temp dir.
    // ponytail: mutates the process-global cwd, so this must stay the only fs-cwd-dependent
    // test in the crate; if a second one shows up, give `save_bytes` a caller-supplied base dir
    // instead of hardcoding `./`.
    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn save_bytes_native_writes_exact_bytes_readable_back() {
        let original_cwd = std::env::current_dir().expect("read cwd");
        let dir = std::env::temp_dir().join(format!(
            "vol3d_export_save_bytes_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        std::env::set_current_dir(&dir).expect("cd into scratch dir");

        let bytes: Vec<u8> = (0..=255u8).collect();
        save_bytes("save_bytes_test", "bin", &bytes);

        std::env::set_current_dir(&original_cwd).expect("restore cwd");

        let readback = std::fs::read(dir.join("save_bytes_test.bin")).expect("read back");
        assert_eq!(readback, bytes);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
