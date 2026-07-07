import { describe, expect, it } from 'vitest'
import { initialState, nameSq, sqName } from '../src/board.js'
import { fromFEN, toFEN } from '../src/fen.js'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'

describe('board + FEN', () => {
  it('square helpers round-trip', () => {
    expect(sqName(0)).toBe('a1'); expect(sqName(63)).toBe('h8')
    expect(nameSq('e4')).toBe(28); expect(sqName(nameSq('c6'))).toBe('c6')
  })
  it('initialState serializes to the start FEN', () => {
    expect(toFEN(initialState())).toBe(START)
  })
  it('FEN round-trips (start, kiwipete, ep square, no castling)', () => {
    for (const f of [START, KIWIPETE,
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1']) {
      expect(toFEN(fromFEN(f))).toBe(f)
    }
  })
  it('fromFEN sets fresh clocks and empty bookkeeping', () => {
    const s = fromFEN(KIWIPETE)
    expect(s.clocksMs).toEqual({ w: 180_000, b: 180_000 })
    expect(s.history).toEqual([]); expect(s.result).toBeNull()
  })
})
