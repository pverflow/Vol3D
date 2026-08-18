# Vol3D v3 — Animation Timeline SP2: Visual Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** A visual timeline panel — ruler, draggable playhead, one lane per animated track, keyframe dots you select / drag-to-retime / delete.

**Spec:** `docs/superpowers/specs/2026-08-03-vol3d-v3-timeline-sp2-panel-design.md`.

**Tech Stack:** Rust 1.97, `egui`/`eframe` `=0.35.0`, `wgpu =29.0.4`. All under `v3/`. No shader change.

## Global Constraints

- All under `v3/`; v2 (`src/`) REFERENCE ONLY. `source "$HOME/.cargo/env"` before every cargo.
- Both `cargo check` (native) AND `--target wasm32-unknown-unknown` green every task; `cargo clippy --all-targets -- -D warnings` clean; `cargo test` green.
- No change to SP1 keyframe DATA semantics (the panel edits the same `Timeline`); no generation/render/shader change; zero readback.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File structure

```
v3/src/anim_timeline.rs  # MOD: Track::remove_at/value_at_key; Timeline::remove_key/move_key; tests
v3/src/app.rs            # MOD: selected_key state; timeline_panel() (ruler/lanes/dots/playhead) in animation_panel; interactions
v3/RUN.md                # MOD (Task 4)
```

---

## Task 1: Timeline/Track edit helpers

**Files:** `v3/src/anim_timeline.rs`.

**Interfaces produced:**
- `Track::remove_at(&mut self, phase: f32) -> bool`; `Track::value_at_key(&self, phase: f32) -> Option<f32>`.
- `Timeline::remove_key(&mut self, id: u64, f: ParamField, phase: f32)`; `Timeline::move_key(&mut self, id: u64, f: ParamField, from: f32, to: f32)`.

- [ ] **Step 1: `Track` helpers (TDD)** —
```rust
pub fn value_at_key(&self, phase: f32) -> Option<f32> {
    self.keys.iter().find(|k| (k.phase - phase).abs() < 1e-4).map(|k| k.value)
}
pub fn remove_at(&mut self, phase: f32) -> bool {
    if let Some(i) = self.keys.iter().position(|k| (k.phase - phase).abs() < 1e-4) {
        self.keys.remove(i); true
    } else { false }
}
```
Test: build a Track (upsert 0.0/1.0, 0.5/2.0, 1.0/3.0); `value_at_key(0.5)==Some(2.0)`; `remove_at(0.5)` true, `len()==2`, `value_at_key(0.5)==None`; `remove_at(0.9)` false.
- [ ] **Step 2: run → fail → implement → pass.**
- [ ] **Step 3: `Timeline` helpers (TDD)** —
```rust
pub fn remove_key(&mut self, id: u64, f: ParamField, phase: f32) {
    let key = (id, f as u8);
    if let Some(t) = self.tracks.get_mut(&key) {
        t.remove_at(phase);
        if t.is_empty() { self.tracks.remove(&key); }
    }
}
pub fn move_key(&mut self, id: u64, f: ParamField, from: f32, to: f32) {
    let key = (id, f as u8);
    if let Some(t) = self.tracks.get_mut(&key) {
        if let Some(v) = t.value_at_key(from) { t.remove_at(from); t.upsert(to.clamp(0.0, 1.0), v); }
    }
}
```
Test: upsert (7,Opacity,0.2,0.5) + (7,Opacity,0.8,0.9); `move_key(7,Opacity,0.2,0.4)` → `is_animated` still true, `track_len==2`, sampling at 0.4 gives the moved value, no key left at 0.2; `remove_key` both keys → track dropped → `is_animated(7,Opacity)==false`; `hash()` changes after a move.
- [ ] **Step 4: run → fail → implement → pass.**
- [ ] **Step 5: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): timeline edit helpers — remove_key / move_key (retime) / Track remove_at

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Timeline panel — display (ruler / lanes / dots / playhead)

**Files:** `v3/src/app.rs`.

- [ ] **Step 1: state** — add `Vol3dApp.selected_key: Option<(u64, layer::ParamField, f32)>` (default `None`).
- [ ] **Step 2: `timeline_panel(&mut self, ui)`** — called at the end of `animation_panel` (below the Phase slider). Structure:
  - `let entries = self.timeline.to_entries();` — if empty, draw a faint "no keyframes — click ◆ next to a value to animate it" hint and return.
  - Allocate a full-width rect (`ui.available_width()`) for the ruler (~16 px) + a `ScrollArea::vertical().max_height(160.0)` holding the lanes (each ~18 px). Use one shared **x-mapping**: `fn phase_to_x(phase, rect) = rect.left() + LABEL_W + phase * (rect.width() - LABEL_W)` and its inverse `x_to_phase` (LABEL_W ~90 px left gutter for labels). Keep this pair the single source for paint + hit-test.
  - **Ruler:** `painter.text` labels `0s` / `{loop_seconds/2}s` / `{loop_seconds}s` at the corresponding x; a baseline line.
  - **Lanes:** for each entry, a row rect; left gutter text `format!("L{}·{}", layer_index_of(id), field.label())` (`layer_index_of` = `self.layers.iter().position(|l| l.id==id)`, fallback `?`); a faint lane baseline; a **dot** (`painter.circle_filled`, r~3) at `phase_to_x(key.phase)` for each key. If `(id, field, key.phase)` == `selected_key`, draw it larger + a ring.
  - **Playhead:** a vertical line at `phase_to_x(self.phase)` from the ruler through all lanes (`painter.line_segment`), a contrasting color.
  (Read-only this task — no interaction yet; just correct positions. Use `ui.visuals()` colors.)
- [ ] **Step 3: build/gate** — visual correctness is the GPU run; ensure it compiles + lays out (no panic on empty timeline / on a track whose layer was deleted — pruning keeps ids valid, but `layer_index_of` still guards with `?`). Borrow note: `to_entries()` clones (`&self.timeline`), so painting doesn't alias `&mut self`.
- [ ] **Step 4: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): visual timeline panel — ruler, per-track lanes, keyframe dots, playhead line

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Interactions — playhead scrub, keyframe select / drag-retime / delete

**Files:** `v3/src/app.rs`.

- [ ] **Step 1: response + hit-test** — allocate the timeline area with `Sense::click_and_drag()`. On the response: get `pointer` pos. **Priority:** (a) if a drag STARTS within ~5 px of a keyframe dot → grab that key (set `selected_key`, enter retime-drag); (b) else the interaction is a **playhead scrub** (set `phase` from `x_to_phase(pointer.x)`). Track the grab across frames with a small drag-state (e.g. reuse `selected_key` + a `bool` "dragging a key" or infer from `response.dragged()` + a stored grabbed key). Keep it simple: store the currently-grabbed key in a `dragging_key: Option<(u64,ParamField,f32)>` transient field (or fold into selected_key + a dragged flag).
- [ ] **Step 2: playhead scrub** — when scrubbing (not grabbing a dot) and `response.dragged()` or `clicked()`: `let p = x_to_phase(pointer.x).clamp(0.0,1.0); self.sync_playhead(p); self.mark_dirty(ui.ctx());` (mirrors the Phase slider).
- [ ] **Step 3: keyframe select + drag-retime** — click near a dot → `selected_key = Some((id,field,phase))`. While dragging a grabbed dot: `let np = x_to_phase(pointer.x).clamp(0.0,1.0); self.timeline.move_key(id, field, old_phase, np); self.selected_key = Some((id, field, np)); self.mark_dirty(ui.ctx());` (update `old_phase`→`np` for the next frame of the drag).
- [ ] **Step 4: delete** — if `selected_key` is Some and (`Delete`/`Backspace` pressed with the pointer over the panel, via `ui.input(|i| i.key_pressed(egui::Key::Delete))`, OR a small "🗑" button drawn in the panel is clicked): `let (id,f,p)=selected_key; self.timeline.remove_key(id,f,p); self.selected_key=None; self.mark_dirty(ui.ctx());`.
- [ ] **Step 5: keep selection valid** — if `selected_key`'s track/key no longer exists (e.g. layer deleted → tracks pruned), clear it (a guard where you read `selected_key`, or after any layer delete). 
- [ ] **Step 6: gate + commit**
```bash
source "$HOME/.cargo/env" && cd v3
cargo fmt && cargo test && cargo check && cargo check --target wasm32-unknown-unknown && cargo clippy --all-targets -- -D warnings
git add v3 && git commit -m "feat(v3): timeline interactions — playhead scrub + keyframe select / drag-retime / delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RUN.md + user GPU run handoff

**Files:** `v3/RUN.md`.

- [ ] **Step 1:** document the timeline panel (below the animation controls): animated params show as **lanes with keyframe dots** on the seconds ruler; **drag the playhead** to scrub; **click a dot** to select, **drag it** to retime, **Delete** (or 🗑) to remove; add keyframes via the **◆** stopwatch (SP1) as before. Ask the user to report: animated params appear as lanes with dots at the right spots; playhead-drag scrubs; dot-drag retimes (playback reflects it); Delete removes a key (◆ un-fills when its last key goes); many tracks scroll; non-animated scene = empty timeline. Note SP3 (value curves / vertical editing) is next.
- [ ] **Step 2:** commit + STOP for the user's GPU run.
```bash
git add v3/RUN.md && git commit -m "docs(v3): timeline SP2 visual panel run/verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** edit helpers remove_key/move_key/remove_at/value_at_key (T1) ✓; panel ruler/lanes/dots/playhead (T2) ✓; playhead scrub + select/drag-retime/delete (T3) ✓; selected_key state + validity (T2 S1, T3 S5) ✓; shared phase↔x mapping (T2 S2) ✓; GPU run (T4) ✓; no shader/gen change ✓.
**Placeholder scan:** helper code concrete; the egui painting is structured (painter calls + the phase↔x pair) with visual polish left to the GPU run — appropriate for a UI task.
**Type consistency:** `Track::remove_at/value_at_key` + `Timeline::remove_key/move_key` (T1) used by the panel interactions (T3); `selected_key:(u64,ParamField,f32)` (T2) set/read across T2/T3; `phase_to_x/x_to_phase` shared by paint (T2) + hit-test (T3).
