export class HelpModal {
  open(): void {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const modal = document.createElement('div')
    modal.className = 'modal help-modal'

    modal.innerHTML = `
      <div class="modal-header">
        <h2>Help & Shortcuts</h2>
        <button class="modal-close">✕</button>
      </div>
      <div class="modal-body help-body">
        <div class="help-section">
          <h3>Keyboard</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Tab</span><span>Cycle preview mode</span></div>
            <div class="help-item"><span class="help-key">T</span><span>Toggle the 3×3×3 tile preview</span></div>
            <div class="help-item"><span class="help-key">F</span><span>Reset / focus the camera</span></div>
            <div class="help-item"><span class="help-key">Delete</span><span>Delete the selected layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+D</span><span>Duplicate the selected layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+Shift+N</span><span>Add a new default layer</span></div>
            <div class="help-item"><span class="help-key">Ctrl+E</span><span>Open the export dialog</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Viewport</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">LMB drag</span><span>Orbit / grab the volume depending on the camera mode</span></div>
            <div class="help-item"><span class="help-key">RMB drag</span><span>Pan the view</span></div>
            <div class="help-item"><span class="help-key">Wheel</span><span>Zoom in and out</span></div>
            <div class="help-item"><span class="help-key">Double-click</span><span>Reset the camera</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Curves & sliders</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Slider drag</span><span>Adjust values continuously</span></div>
            <div class="help-item"><span class="help-key">Shift+drag</span><span>Fine-adjust slider values</span></div>
            <div class="help-item"><span class="help-key">Wheel on slider</span><span>Nudge slider values by one step</span></div>
            <div class="help-item"><span class="help-key">Double-click value</span><span>Type a precise slider value</span></div>
            <div class="help-item"><span class="help-key">Right-click</span><span>Reset sliders and Bézier curves to their defaults</span></div>
            <div class="help-item"><span class="help-key">Curve handles</span><span>Drag the two control points to shape remap and feather falloff</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Layers</h3>
          <div class="help-list">
            <div class="help-item"><span class="help-key">Click</span><span>Select a layer</span></div>
            <div class="help-item"><span class="help-key">Drag row</span><span>Reorder layers</span></div>
            <div class="help-item"><span class="help-key">Eye button</span><span>Toggle layer visibility</span></div>
            <div class="help-item"><span class="help-key">Double-click name</span><span>Rename a layer</span></div>
            <div class="help-item"><span class="help-key">Blend badge</span><span>Cycle blend modes quickly</span></div>
            <div class="help-item"><span class="help-key">Right-click row</span><span>Open duplicate / move / delete actions</span></div>
          </div>
        </div>

        <div class="help-section">
          <h3>Basic workflow</h3>
          <div class="help-copy">
            <p>Start with one large base noise layer, then stack detail layers using <strong>Multiply</strong>, <strong>Overlay</strong>, or <strong>Subtract</strong>.</p>
            <p>Use <strong>In Min / In Max</strong> to isolate ranges, then shape the result with the Bézier <strong>Remap Curve</strong>.</p>
            <p>Use <strong>Feather Shape</strong> plus the <strong>Feather</strong> widths and curve to carve the volume into a box-like or spherical falloff.</p>
            <p>The top-bar <strong>Cutoff</strong> and <strong>Contrast</strong> affect the stored/exported density, not just the preview.</p>
            <p>The <strong>Tile Preview</strong> button only visualizes repetition. It does not change the generated texture itself.</p>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="top-btn accent modal-close-primary">Close</button>
      </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    overlay.querySelector('.modal-close')?.addEventListener('click', close)
    overlay.querySelector('.modal-close-primary')?.addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  }
}
