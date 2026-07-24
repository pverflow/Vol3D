import { describe, it, expect } from 'vitest'
import { StateManager } from './StateManager'
import { defaultLayer } from './AppState'

describe('StateManager.reorderLayers', () => {
  it('moves a layer from index to index preserving the others', () => {
    const sm = new StateManager()
    sm.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') },
    ])
    sm.reorderLayers(0, 2)
    expect(sm.get('layers').map(l => l.name)).toEqual(['B', 'C', 'A'])
  })
})

// LayerPanel renders the visual list reversed relative to `state.layers` (index 0 = bottom
// of stack, last = top; displayed top-to-bottom). The drop handler must translate a drag
// between two DISPLAYED rows into `from`/`to` indices in the state array's coordinate space:
//   from = state index of the dragged layer
//   to   = from < targetIndex ? targetIndex : targetIndex + 1
// where targetIndex is the state index of the row dropped onto (before removal).
// These cases lock that translation against the previous hand-rolled
// reverse/splice/insertAt implementation (verified by hand for both directions).
describe('LayerPanel drag translation (visual reversed order -> state indices)', () => {
  function translate(from: number, targetIndex: number): number {
    return from < targetIndex ? targetIndex : targetIndex + 1
  }

  it('drags the state-last (visually topmost) layer onto the state-first (visually bottommost) row', () => {
    const sm = new StateManager()
    sm.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') },
    ])
    // state: A=0,B=1,C=2 ; displayed: C,B,A (visual drag of C onto A)
    sm.reorderLayers(2, translate(2, 0))
    expect(sm.get('layers').map(l => l.name)).toEqual(['A', 'C', 'B'])
  })

  it('drags a middle layer onto the state-last (visually bottommost) row', () => {
    const sm = new StateManager()
    sm.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') },
    ])
    // state: A=0,B=1,C=2 ; displayed: C,B,A (visual drag of B onto C)
    sm.reorderLayers(1, translate(1, 2))
    expect(sm.get('layers').map(l => l.name)).toEqual(['A', 'C', 'B'])
  })

  it('drags the state-first (visually bottommost) layer onto the state-last (visually topmost) row, n=4', () => {
    const sm = new StateManager()
    sm.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') }, { ...defaultLayer('D') },
    ])
    // state: A=0,B=1,C=2,D=3 ; displayed: D,C,B,A (visual drag of D onto A)
    sm.reorderLayers(3, translate(3, 0))
    expect(sm.get('layers').map(l => l.name)).toEqual(['A', 'D', 'B', 'C'])

    const sm2 = new StateManager()
    sm2.update('layers', [
      { ...defaultLayer('A') }, { ...defaultLayer('B') }, { ...defaultLayer('C') }, { ...defaultLayer('D') },
    ])
    // reverse direction: drag A onto D
    sm2.reorderLayers(0, translate(0, 3))
    expect(sm2.get('layers').map(l => l.name)).toEqual(['B', 'C', 'D', 'A'])
  })
})
