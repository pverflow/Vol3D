// Custom color gradient editor widget (cycle 3, Task 3): the payoff of the authoring UI — a
// draggable-stop gradient bar bound to a layer's `ColorRamp`, mounted in the Properties panel
// (replacing Task 2's placeholder label). Paints the gradient by sampling `ramp::sample_stops`,
// the same function `ramp::build_ramp_lut_atlas` uses to bake the GPU LUT, so what's shown in
// the bar is exactly what gets baked. All stop mutation (add/move/remove) routes through
// `ui_logic`'s already-tested, panic-safe helpers — this file only hit-tests, paints, and wires
// pointer events to those calls.

use crate::ramp::{sample_stops, ColorRamp, RampStop};
use crate::ui_logic::{add_stop, move_stop, remove_stop};
use egui::{pos2, vec2, Color32, Rect, Response, Sense, Stroke, Ui};

/// Bar height in points.
const BAR_HEIGHT: f32 = 24.0;
/// Handle hit-test radius in points (x-distance only — every handle sits on the same row).
const HANDLE_HIT_PX: f32 = 8.0;
const HANDLE_RADIUS: f32 = 5.0;
const HANDLE_RADIUS_SELECTED: f32 = 7.0;

/// Draw and drive the gradient bar for `ramp`. Mutates `ramp.stops` via `ui_logic`'s add/move/
/// remove helpers (never re-implements the stop math) plus `ramp.enabled` and the selected
/// stop's color directly. Returns the bar's `Response` with `.changed()` set whenever any edit
/// happened this frame, so `app.rs` can gate `mark_dirty` off a single `.changed()` check.
pub fn gradient_editor(
    ui: &mut Ui,
    ramp: &mut ColorRamp,
    selected_stop: &mut Option<usize>,
) -> Response {
    let mut changed = ui.checkbox(&mut ramp.enabled, "Enabled").changed();

    let (rect, mut resp) = ui.allocate_exact_size(
        vec2(ui.available_width(), BAR_HEIGHT),
        Sense::click_and_drag(),
    );

    paint_checker_backdrop(ui.painter(), rect);
    paint_gradient(ui.painter(), rect, &ramp.stops);

    let to_t = |x: f32| ((x - rect.left()) / rect.width().max(1.0)).clamp(0.0, 1.0);
    let hit_test = |stops: &[RampStop], x: f32| {
        stops
            .iter()
            .enumerate()
            .map(|(i, s)| (i, (rect.left() + s.t * rect.width() - x).abs()))
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .filter(|(_, dist)| *dist <= HANDLE_HIT_PX)
            .map(|(i, _)| i)
    };

    if let Some(p) = resp.interact_pointer_pos() {
        if resp.drag_started() || resp.clicked() {
            // A fresh press: select the handle under it, or plant a new stop there. Checking
            // both `drag_started` and `clicked` (rather than `clicked` alone) means a press-and-
            // immediately-move gesture on an unselected handle still selects it — `clicked()`
            // alone would miss that, since egui reclassifies a moved press as a drag, not a click.
            match hit_test(&ramp.stops, p.x) {
                Some(i) => *selected_stop = Some(i),
                None => {
                    let i = add_stop(&mut ramp.stops, to_t(p.x));
                    *selected_stop = Some(i);
                    changed = true;
                }
            }
        } else if resp.dragged() {
            if let Some(i) = *selected_stop {
                *selected_stop = Some(move_stop(&mut ramp.stops, i, to_t(p.x)));
                changed = true;
            }
        }
    }

    let accent = ui.visuals().selection.stroke.color;
    paint_handles(ui.painter(), rect, &ramp.stops, *selected_stop, accent);

    ui.horizontal(|ui| match *selected_stop {
        Some(i) if i < ramp.stops.len() => {
            let stop = &mut ramp.stops[i];
            let mut rgba = [stop.color[0], stop.color[1], stop.color[2], stop.alpha];
            if ui.color_edit_button_srgba_unmultiplied(&mut rgba).changed() {
                stop.color = [rgba[0], rgba[1], rgba[2]];
                stop.alpha = rgba[3];
                changed = true;
            }
            if ui
                .add_enabled(ramp.stops.len() > 1, egui::Button::new("Remove stop"))
                .clicked()
            {
                remove_stop(&mut ramp.stops, i);
                *selected_stop = None;
                changed = true;
            }
        }
        Some(_) => *selected_stop = None, // stale index (shouldn't happen; defensive)
        None => {
            ui.label("Click the bar to add a stop.");
        }
    });

    if changed {
        resp.mark_changed();
    }
    resp
}

/// Checker pattern behind the gradient so partial alpha is visible (mirrors egui's own
/// `color_picker::background_checkers`, which is private to that module).
fn paint_checker_backdrop(painter: &egui::Painter, rect: Rect) {
    painter.rect_filled(rect, 0.0, Color32::from_gray(32));
    let cell = rect.height() / 2.0;
    let cols = (rect.width() / cell).ceil() as u32;
    for col in 0..cols {
        let x0 = rect.left() + col as f32 * cell;
        let x1 = (x0 + cell).min(rect.right());
        let y0 = if col % 2 == 0 {
            rect.top()
        } else {
            rect.center().y
        };
        painter.rect_filled(
            Rect::from_min_max(pos2(x0, y0), pos2(x1, y0 + cell)),
            0.0,
            Color32::from_gray(96),
        );
    }
}

/// Paint the gradient as ~2px-wide vertical strips, each sampled from `stops` at its x-fraction
/// (the same `sample_stops` the GPU LUT bake uses). No-op on an empty ramp (nothing to sample).
fn paint_gradient(painter: &egui::Painter, rect: Rect, stops: &[RampStop]) {
    if stops.is_empty() {
        return;
    }
    const STRIP_W: f32 = 2.0;
    let n = (rect.width() / STRIP_W).ceil().max(1.0) as u32;
    for i in 0..n {
        let x0 = rect.left() + i as f32 * STRIP_W;
        let x1 = (x0 + STRIP_W).min(rect.right());
        let t = ((x0 - rect.left()) / rect.width().max(1.0)).clamp(0.0, 1.0);
        let [r, g, b, a] = sample_stops(stops, t);
        painter.rect_filled(
            Rect::from_min_max(pos2(x0, rect.top()), pos2(x1, rect.bottom())),
            0.0,
            Color32::from_rgba_unmultiplied(r, g, b, a),
        );
    }
}

/// Draw a handle circle at each stop's `t`, highlighting the selected one with `accent`
/// (`ui.visuals().selection.stroke.color` — the active theme's accent, dark or light).
fn paint_handles(
    painter: &egui::Painter,
    rect: Rect,
    stops: &[RampStop],
    selected: Option<usize>,
    accent: Color32,
) {
    for (i, s) in stops.iter().enumerate() {
        let x = rect.left() + s.t * rect.width();
        let center = pos2(x, rect.bottom());
        let is_selected = selected == Some(i);
        let radius = if is_selected {
            HANDLE_RADIUS_SELECTED
        } else {
            HANDLE_RADIUS
        };
        let stroke = if is_selected {
            Stroke::new(2.0, accent)
        } else {
            Stroke::new(1.0, Color32::BLACK)
        };
        painter.circle_filled(center, radius, Color32::WHITE);
        painter.circle_stroke(center, radius, stroke);
    }
}
