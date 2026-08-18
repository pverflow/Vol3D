# Vol3D v3 — Animation Timeline SP3: Value & Interpolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Per-keyframe interpolation (Linear / Hold / Ease) honored by sampling + interp preserved through edits, plus direct value editing of the selected keyframe in the timeline panel.

**Spec:** `docs/superpowers/specs/2026-08-03-vol3d-v3-timeline-sp3-value-curves-design.md`.

**Tech Stack:** Rust 1.97, `egui`/`eframe` `=0.35.0`, `serde`. All under `v3/`. No shader change.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green.
- **All-`Linear` sampling MUST equal today** (byte-identical); a pre-SP3 saved scene (Keyframe JSON without `interp`) MUST load (serde default `Linear`). No generation/render/shader change; zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/anim_timeline.rs  # MOD: Interp enum; Keyframe.interp (serde default); Track::sample per-key interp; upsert/move_key preserve interp; set_value_at/set_interp_at/interp_at/key_at + Timeline wrappers; tests
v3/src/app.rs            # MOD: selected-key value DragValue + Lin/Hold/Ease buttons in the timeline panel
v3/RUN.md                # MOD (Task 3)
```

---

## Task 1: Data model — Interp + per-key sampling + edit helpers

**Files:** `v3/src/anim_timeline.rs`.

**Interfaces produced:**
- `pub enum Interp { Linear, Hold, Ease }` (`#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]`, `#[default] Linear`).
- `Keyframe { phase: f32, value: f32, #[serde(default)] interp: Interp }`.
- `Track`: `key_at(&self, phase) -> Option<Keyframe>`, `set_value_at(&mut self, phase, v)`, `set_interp_at(&mut self, phase, i: Interp)`, `interp_at(&self, phase) -> Option<Interp>`; `upsert` preserves interp on replace; sample honors interp.
- `Timeline`: `set_key_value(&mut self, id, f: ParamField, phase, v)`, `set_key_interp(&mut self, id, f, phase, i: Interp)`, `key_interp(&self, id, f, phase) -> Option<Interp>`; `move_key` preserves value+interp.

- [ ] **Step 1: `Interp` + `Keyframe.interp` (TDD)** — add the enum; add `#[serde(default)] pub interp: Interp` to `Keyframe`. Everywhere a `Keyframe { phase, value }` literal is built (grep — `upsert`, tests), add `interp: Interp::default()` (or a helper `Keyframe::new(phase, value)`). Test: `serde_json::to_string`/`from_str` of a `Keyframe { interp: Ease, .. }` round-trips; a hand-written JSON `{"phase":0.0,"value":1.0}` (no interp) deserializes with `interp == Interp::Linear`.
- [ ] **Step 2: `Track::sample` per-key interp (TDD)** — in the `windows(2)` segment, remap `t`:
```rust
let raw = ((phase - w[0].phase) / span).clamp(0.0, 1.0);
let t = match w[0].interp {
    Interp::Linear => raw,
    Interp::Hold => 0.0,
    Interp::Ease => raw * raw * (3.0 - 2.0 * raw),
};
return w[0].value + (w[1].value - w[0].value) * t;
```
Test: track keys (0.0→0.0, 1.0→4.0). All Linear: `sample(0.25)==1.0`. Set key0 Hold: `sample(0.25)==0.0`, `sample(0.99)≈0.0`. Set key0 Ease: `sample(0.5)==2.0` (smoothstep(0.5)=0.5→half the delta), `sample(0.25)≈4.0*0.15625=0.625`. Run → fail → implement → pass.
- [ ] **Step 3: preserve interp through upsert/move_key + edit helpers (TDD)** — `Track::upsert(phase, value)`: if a key exists within `1e-5`, update only its `value` (keep `interp`/`phase`); else insert `Keyframe { phase, value, interp: Linear }` (sorted). Add `key_at`/`set_value_at`/`set_interp_at`/`interp_at`. `Timeline::move_key`: read `track.key_at(from)`, `remove_at(from)`, re-insert a `Keyframe { phase: to.clamp(0,1), value: k.value, interp: k.interp }` (add a `Track::insert_key(Keyframe)` or reuse an internal sorted-insert). Add the `Timeline` wrappers. Tests:
```rust
// upsert keeps interp on value-replace
let mut t = Track::default(); t.upsert(0.5, 1.0); t.set_interp_at(0.5, Interp::Ease);
t.upsert(0.5, 9.0); assert_eq!(t.interp_at(0.5), Some(Interp::Ease)); assert_eq!(t.value_at_key(0.5), Some(9.0));
// move_key preserves value + interp
let mut tl = Timeline::default();
tl.upsert(7, ParamField::Opacity, 0.2, 0.5); tl.set_key_interp(7, ParamField::Opacity, 0.2, Interp::Hold);
tl.move_key(7, ParamField::Opacity, 0.2, 0.6);
assert_eq!(tl.key_interp(7, ParamField::Opacity, 0.6), Some(Interp::Hold));
```
Run → fail → implement → pass.
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): per-keyframe interpolation (Linear/Hold/Ease) + interp-preserving edits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: UI — selected-key value + interp buttons

**Files:** `v3/src/app.rs`.

- [ ] **Step 1:** in the timeline panel's control row (where the `🗑` button is, ~app.rs:1388), when `self.selected_key` is `Some((id, field, phase))`, show:
  - a **value** `DragValue`: seed from `self.timeline.value_at_key`-equivalent (add a `Timeline::key_value(id,f,phase)->Option<f32>` if not present, or read via `to_entries`); on `.changed()` → `self.timeline.set_key_value(id, field, phase, v); self.mark_dirty(ui.ctx());`.
  - three small toggle buttons **Lin / Hold / Ease**: highlight the one equal to `self.timeline.key_interp(id, field, phase)`; on click → `self.timeline.set_key_interp(id, field, phase, <that>); self.mark_dirty(ui.ctx());`. (Use `SelectableLabel` or `Button` with a highlight.)
  Read `selected_key` into locals first (Copy) to avoid borrow conflicts with `&mut self.timeline`.
- [ ] **Step 2: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): timeline — edit selected keyframe value + interpolation (Lin/Hold/Ease)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document: select a keyframe (SP2) → edit its **value** directly + set its **interpolation** — **Lin** (constant ramp), **Hold** (steps, holds until the next key), **Ease** (smooth in/out). Interp is preserved when you retime a key; old scenes are all Linear. Ask the user to report: Hold steps (no ramp); Ease is visibly smooth vs Linear; editing the selected key's value updates playback; retiming keeps the interp; a pre-SP3 saved scene loads + plays the same. Note SP3.5/SP4: full bezier tangent handles + a value-vs-time graph are the next refinement.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): timeline SP3 value/interpolation run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** `Interp` + `Keyframe.interp` serde-default (T1 S1) ✓; `sample` per-key Linear/Hold/Ease (T1 S2) ✓; interp preserved through upsert/move_key (T1 S3) ✓; value+interp edit helpers + Timeline wrappers (T1 S3) ✓; UI value field + interp buttons (T2) ✓; all-Linear identity + old-save default (T1 tests) ✓; GPU run (T3) ✓; no shader change ✓.
**Placeholder scan:** sample remap + tests concrete; the only lookup is the exact `Keyframe {}` literal sites to add `interp` to (grep).
**Type consistency:** `Interp` (T1) on `Keyframe`, in `sample`/`set_interp_at`/`key_interp` (T1) + the UI buttons (T2); `set_key_value`/`set_key_interp`/`key_interp`/`key_value` (T1) used by the panel (T2); `move_key` preserves both (T1 S3) — the SP2 retime keeps interp.
