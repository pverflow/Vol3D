mod app;
mod camera;
mod layer;
mod ramp;
mod render;
mod ui_logic;
use app::Vol3dApp;

#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result<()> {
    env_logger::init();
    let native_options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        ..Default::default()
    };
    eframe::run_native(
        "Vol3D v3",
        native_options,
        Box::new(|cc| Ok(Box::new(Vol3dApp::new(cc)))),
    )
}

#[cfg(target_arch = "wasm32")]
fn main() {
    use eframe::wasm_bindgen::JsCast as _;
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Debug);

    // Global Constraint: web must use the WebGPU backend, not WebGL2 (no compute).
    // Pin the wgpu instance to WebGPU-only so a non-WebGPU browser fails cleanly with
    // "no WebGPU adapter" instead of silently falling back to WebGL2 and crashing later
    // at compute-pipeline creation.
    let mut wgpu_setup = egui_wgpu::WgpuSetup::without_display_handle();
    if let egui_wgpu::WgpuSetup::CreateNew(ref mut create_new) = wgpu_setup {
        create_new.instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    }
    let web_options = eframe::WebOptions {
        wgpu_options: egui_wgpu::WgpuConfiguration {
            wgpu_setup,
            ..Default::default()
        },
        ..Default::default()
    };
    wasm_bindgen_futures::spawn_local(async {
        let document = web_sys::window().unwrap().document().unwrap();
        let canvas = document
            .get_element_by_id("the_canvas_id")
            .unwrap()
            .dyn_into::<web_sys::HtmlCanvasElement>()
            .unwrap();
        eframe::WebRunner::new()
            .start(
                canvas,
                web_options,
                Box::new(|cc| Ok(Box::new(Vol3dApp::new(cc)))),
            )
            .await
            .expect("failed to start eframe");
    });
}
