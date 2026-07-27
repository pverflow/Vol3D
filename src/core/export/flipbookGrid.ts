// Pure sprite-sheet grid layout for the rendered-flipbook exporter (VFX-0
// Task 5) — no GL/DOM deps so it's unit-testable in isolation from the
// bake/render code in FlipbookExporter.ts.

// Default column count so the sheet is roughly square: ceil(sqrt(frames)).
export function defaultFlipbookCols(frames: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, frames))))
}

// Grid row count for a given frame count and column count.
export function flipbookRows(frames: number, cols: number): number {
  return Math.max(1, Math.ceil(frames / Math.max(1, cols)))
}

// Sprite-sheet cell (column, row) for frame index i, row-major left-to-right.
export function flipbookCell(index: number, cols: number): { x: number; y: number } {
  const c = Math.max(1, cols)
  return { x: index % c, y: Math.floor(index / c) }
}
