import { describe, expect, it } from 'vitest'
import { cellsAt, KICKS_I, KICKS_JLSTZ, KINDS, spawnPiece } from '../src/pieces.js'

describe('shapes & rotation (hand-traced pins)', () => {
  it('T rotations at (3,10)', () => {
    expect(new Set(cellsAt('T', 0, 3, 10).map(String))).toEqual(new Set([[4,10],[3,11],[4,11],[5,11]].map(String)))
    expect(new Set(cellsAt('T', 1, 3, 10).map(String))).toEqual(new Set([[4,10],[5,11],[4,11],[4,12]].map(String)))
    expect(new Set(cellsAt('T', 2, 3, 10).map(String))).toEqual(new Set([[3,11],[4,11],[5,11],[4,12]].map(String)))
    expect(new Set(cellsAt('T', 3, 3, 10).map(String))).toEqual(new Set([[4,10],[3,11],[4,11],[4,12]].map(String)))
  })
  it('I vertical (rot 1) occupies column x+2, rows y..y+3', () => {
    expect(new Set(cellsAt('I', 1, 7, 20).map(String))).toEqual(new Set([[9,20],[9,21],[9,22],[9,23]].map(String)))
  })
  it('O rotation is identity', () => {
    for (const r of [0,1,2,3] as const) expect(new Set(cellsAt('O', r, 4, 2).map(String))).toEqual(new Set([[4,2],[5,2],[4,3],[5,3]].map(String)))
  })
  it('every kind/rot yields 4 distinct in-box cells', () => {
    for (const k of KINDS) for (const r of [0,1,2,3] as const) expect(new Set(cellsAt(k, r, 0, 0).map(String)).size).toBe(4)
  })
  it('spawn: rot 0, y=2, x=3 (O at x=4); all spawn cells in hidden rows 2-3', () => {
    for (const k of KINDS) {
      const p = spawnPiece(k)
      expect(p.rot).toBe(0); expect(p.y).toBe(2); expect(p.x).toBe(k === 'O' ? 4 : 3)
      for (const [, y] of cellsAt(k, p.rot, p.x, p.y)) expect(y).toBeLessThan(4)
    }
  })
  it('kick tables have 8 transitions × 5 offsets, first always (0,0)', () => {
    for (const t of [KICKS_JLSTZ, KICKS_I]) {
      expect(Object.keys(t)).toHaveLength(8)
      for (const offs of Object.values(t)) { expect(offs).toHaveLength(5); expect(offs[0]).toEqual([0,0]) }
    }
  })
})
