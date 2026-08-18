# Vol3D v3 — Bounding-Box Wireframe Overlay — Design

**Date:** 2026-08-02
**Status:** Approved (user: show the volume's bounding box on hover; flash it for a couple seconds then fade when the size changes).
**Parent:** the raymarch (`raymarch.wgsl` + `CamUniform`) + `app.rs` viewport.

## Goal

Draw a wireframe of the volume's bounding box `[0, box_aspect]` over the raymarch, visible: (a) while the mouse **hovers the viewport**, and (b) as a **flash** (~2 s hold, ~1 s fade) whenever the box **dimensions change** — so a size change reads clearly. One float `wire_alpha` (0 = invisible) drives it; at `0` the render is byte-identical to today.

## Approach — in-shader overlay (no new pipeline)

The raymarch is already a fullscreen pass with the camera basis + `box_aspect`. Overlay the wireframe inside `raymarch.wgsl` after computing the volume color — **no second pipeline / vertex buffer**. See-through (all 12 edges drawn, not depth-occluded by the volume) for clarity.

- **`CamUniform.wire_alpha`**: reuse the existing `_pad0` slot (offset 100) → **size stays 112** (no layout test change). `basis()` leaves it `0.0`; `app.rs` sets it each frame.
- **Guard:** `if (C.wire_alpha <= 0.0) { return volume_color; }` → byte-identical when off.
- **Projection** (world → the same `screen ∈[-1,1]` space the rays use): for a point `P`, `v=P-eye; z=dot(v,fwd); sx=dot(v,right)/(z*aspect*tan_half); sy=dot(v,up)/(z*tan_half)` → `(sx, sy, z)`.
- **8 corners** = `vec3(select(0,asp.x,bx), select(0,asp.y,by), select(0,asp.z,bz))` for `bx,by,bz ∈ {0,1}`; **12 edges** = the corner pairs differing in exactly one axis (enumerate explicitly).
- **Per edge:** project both endpoints; if either `z ≤ 1e-4` (behind camera) skip that edge; else 2D point-to-segment distance from the fragment's `screen` to the projected segment, **aspect-weighted** on x (`dx*C.aspect`) so thickness is ~uniform. Coverage `= 1 - smoothstep(TH-AA, TH+AA, dist)` with `TH≈0.004`, `AA≈0.0025` (NDC units → resolution-relative thickness; acceptable). Take the **max** coverage over the 12 edges.
- **Blend:** `col = mix(col, WIRE_COLOR, cov * C.wire_alpha)`, `WIRE_COLOR = vec3(0.55,0.78,1.0)` (soft cyan-white). Return `vec4(col, 1.0)`.

Behind-camera edge-skip means the wireframe degrades gracefully only when the camera is inside/clipping the box (rare — you view it from outside); acceptable.

## `wire_alpha` driver (`app.rs`)

Each frame: `wire_alpha = clamp(max(hover_alpha, flash_env), 0, 1)`, written onto the `CamUniform` after `basis()`.

- **Hover:** the viewport response (the same rect used for orbit/zoom input) — `hovered`. Smooth it: `self.wire_hover = lerp(self.wire_hover, if hovered {1.0} else {0.0}, 0.18)` each frame; `hover_alpha = self.wire_hover * HOVER_MAX` (`HOVER_MAX = 0.55`). Soft fade in/out.
- **Flash on dims change:** state `wire_flash_start: f64` (init `-1e9`). In the dims-selector `.changed()` block, set `self.wire_flash_start = ctx.input(|i| i.time)`. Envelope from `now = ctx.input(|i| i.time)`: `let e = now - self.wire_flash_start;` `flash_env = if e < HOLD {1.0} else if e < HOLD+FADE {1.0 - (e-HOLD)/FADE} else {0.0}` (`HOLD=2.0`, `FADE=1.0`, as f64→f32). Continuous repaint is already on (fps counter) → the fade animates.

## Scope

**In:** in-shader box wireframe + `CamUniform.wire_alpha` (reuse pad); hover + flash-on-dims-change driver.
**Out:** hover only over the box's screen projection (viewport-hover is enough); depth-occluded (front-only) wireframe; thickness in exact pixels; a separate line pipeline; wireframe for anything but the outer box.

## Testing

- **Unit (Rust):** a pure `flash_envelope(elapsed, hold, fade) -> f32` helper (1.0 during hold, linear fade, 0 after) + test; `CamUniform` size still 112 (existing test).
- **Shader:** `naga shaders/raymarch.wgsl` validates with the overlay.
- **Both targets:** `cargo check` native + wasm32, `cargo clippy -D warnings`, `cargo test`.
- **User GPU run:** hovering the viewport shows the box wireframe (soft fade in/out); leaving hides it; changing a Box dim flashes the wireframe ~2 s then fades; `wire_alpha=0` (not hovering, no recent change) looks exactly like before; the wireframe matches the actual box (tall for `[64,64,256]`, cube for `[128,128,128]`).

## Success criteria

- Wireframe on hover + flash-on-resize-then-fade; matches the box shape; off = byte-identical; gates green; no regression.

## Risks

- **Projection/edge math** first-try correctness (GPU-untested here) — spec gives the exact formulas; naga validates syntax; user GPU confirms visually; reviewer verifies the `wire_alpha=0` early-out keeps it byte-identical.
- **Aspect-weighted thickness / fixed NDC threshold** — thickness varies a little with viewport size; acceptable for an overlay.
- **CamUniform pad reuse** — `wire_alpha` at offset 100 (was `_pad0`); Rust ↔ WGSL must both rename that slot; size unchanged (112).
