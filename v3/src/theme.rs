//! v2's dark/light palette (`src/ui/styles/base.css` custom properties), mapped onto
//! `egui::Visuals` so the native/web UI matches v2's look. Presentation-only: no behavior here,
//! just colors/spacing applied once at startup (`apply`). Theme *switching* UI is Task 2.

use egui::{Color32, CornerRadius, Stroke};

/// Parse a `#rrggbb` hex string into a `Color32`. Inputs are our own `Palette` constants below
/// (never user input), so malformed input falls back to black rather than panicking.
pub fn hex(s: &str) -> Color32 {
    let s = s.strip_prefix('#').unwrap_or(s);
    if s.len() != 6 || !s.is_char_boundary(2) || !s.is_char_boundary(4) {
        return Color32::from_rgb(0, 0, 0);
    }
    let channel = |slice: &str| u8::from_str_radix(slice, 16);
    match (channel(&s[0..2]), channel(&s[2..4]), channel(&s[4..6])) {
        (Ok(r), Ok(g), Ok(b)) => Color32::from_rgb(r, g, b),
        _ => Color32::from_rgb(0, 0, 0),
    }
}

/// v2's named color tokens (see `src/ui/styles/base.css` `:root` / `:root[data-theme="light"]`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub bg_base: Color32,
    pub bg_panel: Color32,
    pub bg_elevated: Color32,
    pub bg_control: Color32,
    pub bg_hover: Color32,
    pub bg_active: Color32,
    pub border: Color32,
    pub border_focus: Color32,
    pub text: Color32,
    pub text_weak: Color32,
    pub text_muted: Color32,
    pub accent: Color32,
    pub accent_hover: Color32,
    pub danger: Color32,
}

impl Palette {
    /// v2 `:root` (dark) tokens.
    pub fn dark() -> Self {
        Self {
            bg_base: hex("#0b0b0f"),
            bg_panel: hex("#13131a"),
            bg_elevated: hex("#1a1a24"),
            bg_control: hex("#22222e"),
            bg_hover: hex("#2a2a3a"),
            bg_active: hex("#32324a"),
            border: hex("#2a2a3a"),
            border_focus: hex("#5555aa"),
            text: hex("#e8e8f0"),
            text_weak: hex("#8888aa"),
            text_muted: hex("#55556a"),
            accent: hex("#6c6cff"),
            accent_hover: hex("#8080ff"),
            danger: hex("#ff4d6d"),
        }
    }

    /// v2 `:root[data-theme="light"]` tokens.
    pub fn light() -> Self {
        Self {
            bg_base: hex("#f4f4f8"),
            bg_panel: hex("#ffffff"),
            bg_elevated: hex("#eef0f5"),
            bg_control: hex("#e8e8f0"),
            bg_hover: hex("#e0e0ea"),
            bg_active: hex("#d4d4e4"),
            border: hex("#d2d2de"),
            border_focus: hex("#6c6cff"),
            text: hex("#1a1a24"),
            text_weak: hex("#55556a"),
            text_muted: hex("#9090a4"),
            accent: hex("#5555ee"),
            accent_hover: hex("#4040dd"),
            danger: hex("#d63a58"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    Dark,
    // Not yet constructed outside tests — the toggle button that switches to it is Task 2.
    #[allow(dead_code)]
    Light,
}

impl Theme {
    pub fn palette(&self) -> Palette {
        match self {
            Theme::Dark => Palette::dark(),
            Theme::Light => Palette::light(),
        }
    }
}

/// Build an `egui::Visuals` from `theme`'s palette. Starts from egui's own `dark()`/`light()`
/// defaults (for everything the palette doesn't opine on, e.g. shadows) and overrides fills,
/// strokes, and rounding to match v2.
pub fn visuals(theme: Theme) -> egui::Visuals {
    let p = theme.palette();
    let mut v = if matches!(theme, Theme::Dark) {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    v.panel_fill = p.bg_panel;
    v.window_fill = p.bg_panel;
    v.extreme_bg_color = p.bg_base;
    v.faint_bg_color = p.bg_elevated;
    v.override_text_color = Some(p.text);
    v.selection.bg_fill = p.accent.linear_multiply(0.5);
    v.selection.stroke = Stroke::new(1.0, p.accent);
    v.hyperlink_color = p.accent;

    // v2's --radius: 6px, applied to every widget state.
    let radius = CornerRadius::same(6);
    let w = &mut v.widgets;

    w.noninteractive.bg_fill = p.bg_panel;
    w.noninteractive.weak_bg_fill = p.bg_panel;
    w.noninteractive.fg_stroke = Stroke::new(1.0, p.text_weak);
    w.noninteractive.bg_stroke = Stroke::new(1.0, p.border);
    w.noninteractive.corner_radius = radius;

    w.inactive.bg_fill = p.bg_control;
    w.inactive.weak_bg_fill = p.bg_control;
    w.inactive.fg_stroke = Stroke::new(1.0, p.text);
    w.inactive.bg_stroke = Stroke::new(1.0, p.border);
    w.inactive.corner_radius = radius;

    w.hovered.bg_fill = p.bg_hover;
    w.hovered.weak_bg_fill = p.bg_hover;
    w.hovered.fg_stroke = Stroke::new(1.0, p.text);
    w.hovered.bg_stroke = Stroke::new(1.0, p.border_focus);
    w.hovered.corner_radius = radius;

    w.active.bg_fill = p.bg_active;
    w.active.weak_bg_fill = p.bg_active;
    w.active.fg_stroke = Stroke::new(1.0, p.text);
    w.active.bg_stroke = Stroke::new(1.0, p.accent);
    w.active.corner_radius = radius;

    w.open.bg_fill = p.bg_active;
    w.open.weak_bg_fill = p.bg_active;
    w.open.fg_stroke = Stroke::new(1.0, p.text);
    w.open.bg_stroke = Stroke::new(1.0, p.accent);
    w.open.corner_radius = radius;

    v
}

/// Apply `theme` to `ctx`: visuals plus v2-matching spacing (8x6 item spacing, 8x4 button
/// padding). Called once at startup from `Vol3dApp::new`; the toggle UI is Task 2.
///
/// egui 0.35's `Context` keeps separate dark/light `Style`s (selected by `Context::theme()`,
/// switched by `set_theme`) rather than the single `ctx.style()`/`set_style()` from older egui —
/// `set_theme` first so `self.theme()`-keyed writes below land in the right slot, then
/// `set_visuals_of`/`all_styles_mut` write directly to the keyed style instead of a read-clone-
/// write of a getter that no longer exists.
pub fn apply(ctx: &egui::Context, theme: Theme) {
    let egui_theme = match theme {
        Theme::Dark => egui::Theme::Dark,
        Theme::Light => egui::Theme::Light,
    };
    ctx.set_theme(egui_theme);
    ctx.set_visuals_of(egui_theme, visuals(theme));
    ctx.all_styles_mut(|style| {
        style.spacing.item_spacing = egui::vec2(8.0, 6.0);
        style.spacing.button_padding = egui::vec2(8.0, 4.0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_parses() {
        assert_eq!(hex("#6c6cff"), Color32::from_rgb(0x6c, 0x6c, 0xff));
        assert_eq!(hex("#0b0b0f"), Color32::from_rgb(11, 11, 15));
    }

    #[test]
    fn hex_malformed_falls_back_to_black() {
        assert_eq!(hex("#zzzzzz"), Color32::from_rgb(0, 0, 0));
        assert_eq!(hex("nope"), Color32::from_rgb(0, 0, 0));
    }

    #[test]
    fn palettes_differ_and_have_expected_accents() {
        assert_eq!(Theme::Dark.palette().accent, hex("#6c6cff"));
        assert_eq!(Theme::Light.palette().accent, hex("#5555ee"));
        assert_ne!(
            Theme::Dark.palette().bg_panel,
            Theme::Light.palette().bg_panel
        );
    }
}
