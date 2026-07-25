import { describe, it, expect } from 'vitest'
import { defaultFlipbookCols, flipbookRows, flipbookCell } from './flipbookGrid'

describe('defaultFlipbookCols', () => {
  it('is ceil(sqrt(frames))', () => {
    expect(defaultFlipbookCols(32)).toBe(6)
    expect(defaultFlipbookCols(16)).toBe(4)
  })
  it('never returns less than 1', () => {
    expect(defaultFlipbookCols(1)).toBe(1)
    expect(defaultFlipbookCols(0)).toBe(1)
  })
})

describe('flipbookRows', () => {
  it('divides evenly when frames is a multiple of cols', () => {
    expect(flipbookRows(16, 4)).toBe(4)
  })
  it('rounds up a partial last row', () => {
    expect(flipbookRows(17, 4)).toBe(5)
  })
  it('never returns less than 1', () => {
    expect(flipbookRows(1, 8)).toBe(1)
  })
  it('stacks every frame into one column when cols is 1', () => {
    expect(flipbookRows(4, 1)).toBe(4)
  })
})

describe('flipbookCell', () => {
  it('places frame i at (i % cols, floor(i / cols))', () => {
    expect(flipbookCell(0, 4)).toEqual({ x: 0, y: 0 })
    expect(flipbookCell(3, 4)).toEqual({ x: 3, y: 0 })
    expect(flipbookCell(4, 4)).toEqual({ x: 0, y: 1 })
    expect(flipbookCell(13, 4)).toEqual({ x: 1, y: 3 })
  })
  it('stacks vertically when cols is 1', () => {
    expect(flipbookCell(2, 1)).toEqual({ x: 0, y: 2 })
  })
})
