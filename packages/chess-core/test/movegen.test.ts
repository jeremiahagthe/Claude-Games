import { describe, expect, it } from 'vitest'
import { nameSq } from '../src/board.js'
import { fromFEN } from '../src/fen.js'
import { applyMove, isInCheck, legalMoves } from '../src/movegen.js'

describe('movegen edge pins', () => {
  it('en passant capture removes the captured pawn (not just the destination square)', () => {
    // White pawn e5, black just played d7-d5 -> ep square d6.
    const s = fromFEN('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1')
    const next = applyMove(s, { from: nameSq('e5'), to: nameSq('d6') })
    expect(next.board[nameSq('d6')]).toEqual({ type: 'p', color: 'w' })
    expect(next.board[nameSq('e5')]).toBeNull()
    // The captured black pawn sat on d5, not on the destination square d6.
    expect(next.board[nameSq('d5')]).toBeNull()
  })

  it('castling is illegal through an attacked square (not in check, but f1 is attacked)', () => {
    // Black rook on f8 attacks f1, the square the king passes through on O-O.
    const s = fromFEN('5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1')
    expect(isInCheck(s, 'w')).toBe(false)
    const moves = legalMoves(s)
    expect(moves.some((m) => m.from === nameSq('e1') && m.to === nameSq('g1'))).toBe(false)
    // Queen-side castle is unaffected.
    expect(moves.some((m) => m.from === nameSq('e1') && m.to === nameSq('c1'))).toBe(true)
  })

  it('castling illegal while in check', () => {
    const s = fromFEN('4r3/8/8/8/8/8/8/R3K2R w KQ - 0 1')
    expect(isInCheck(s, 'w')).toBe(true)
    const moves = legalMoves(s)
    expect(moves.some((m) => m.from === nameSq('e1') && (m.to === nameSq('g1') || m.to === nameSq('c1')))).toBe(false)
  })

  it('castling illegal when the king would land on an attacked square', () => {
    // Black rook on the g-file attacks g1, the king's destination on O-O.
    const s = fromFEN('6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1')
    const moves = legalMoves(s)
    expect(moves.some((m) => m.from === nameSq('e1') && m.to === nameSq('g1'))).toBe(false)
  })

  it('promotion generates exactly 4 moves for a push to the last rank', () => {
    const s = fromFEN('8/P3k3/8/8/8/8/8/4K3 w - - 0 1')
    const moves = legalMoves(s).filter((m) => m.from === nameSq('a7'))
    expect(moves).toHaveLength(4)
    expect(new Set(moves.map((m) => m.promotion))).toEqual(new Set(['q', 'r', 'b', 'n']))
  })

  it('promotion generates exactly 4 moves for a capture to the last rank', () => {
    const s = fromFEN('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1')
    const moves = legalMoves(s).filter((m) => m.from === nameSq('a7') && m.to === nameSq('b8'))
    expect(moves).toHaveLength(4)
    expect(new Set(moves.map((m) => m.promotion))).toEqual(new Set(['q', 'r', 'b', 'n']))
  })

  it('applyMove throws on an illegal move', () => {
    const s = fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    // Knight cannot jump straight ahead like a rook.
    expect(() => applyMove(s, { from: nameSq('b1'), to: nameSq('b3') })).toThrow(Error)
    // Moving to a square occupied by one's own piece.
    expect(() => applyMove(s, { from: nameSq('a1'), to: nameSq('a2') })).toThrow(Error)
    // No piece on the from-square.
    expect(() => applyMove(s, { from: nameSq('e4'), to: nameSq('e5') })).toThrow(Error)
  })
})
