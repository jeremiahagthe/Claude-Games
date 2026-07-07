import { describe, expect, it } from 'vitest'
import { nameSq } from '../src/board.js'
import { fromFEN } from '../src/fen.js'
import { legalMoves } from '../src/movegen.js'
import { parseMove, toSAN } from '../src/notation.js'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'

describe('notation round-trip', () => {
  it('round-trips every legal move in the start position through toSAN -> parseMove', () => {
    const s = fromFEN(START)
    for (const m of legalMoves(s)) {
      const san = toSAN(s, m)
      expect(parseMove(s, san)).toEqual(m)
    }
  })

  it('round-trips every legal move in Kiwipete through toSAN -> parseMove', () => {
    const s = fromFEN(KIWIPETE)
    for (const m of legalMoves(s)) {
      const san = toSAN(s, m)
      expect(parseMove(s, san)).toEqual(m)
    }
  })
})

describe('parseMove: coordinate notation', () => {
  it('parses a plain coordinate move', () => {
    const s = fromFEN(START)
    expect(parseMove(s, 'e2e4')).toEqual({ from: nameSq('e2'), to: nameSq('e4') })
  })

  it('parses a coordinate move case-insensitively', () => {
    const s = fromFEN(START)
    expect(parseMove(s, 'G1F3')).toEqual({ from: nameSq('g1'), to: nameSq('f3') })
  })

  it('parses a coordinate promotion move', () => {
    const s = fromFEN('k7/4P3/8/8/8/8/8/4K3 w - - 0 1')
    expect(parseMove(s, 'e7e8q')).toEqual({ from: nameSq('e7'), to: nameSq('e8'), promotion: 'q' })
  })
})

describe('parseMove/toSAN: disambiguation', () => {
  // Verified with legalMoves: from rnbqkbnr/.../5N2/... with full pawns on
  // rank 2, d2 is occupied so no knight can reach it — the brief's FEN was
  // wrong. Corrected to a minimal position (kings + the two knights only)
  // where legalMoves confirms Nb1-d2 and Nf3-d2 are both legal.
  const FEN = '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1'

  it('disambiguates two knights that can both reach d2 by source file', () => {
    const s = fromFEN(FEN)
    expect(toSAN(s, { from: nameSq('b1'), to: nameSq('d2') })).toBe('Nbd2')
    expect(toSAN(s, { from: nameSq('f3'), to: nameSq('d2') })).toBe('Nfd2')
    expect(parseMove(s, 'Nbd2')).toEqual({ from: nameSq('b1'), to: nameSq('d2') })
    expect(parseMove(s, 'Nfd2')).toEqual({ from: nameSq('f3'), to: nameSq('d2') })
  })
})

describe('parseMove/toSAN: castling', () => {
  const FEN = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'

  it('parses and produces O-O', () => {
    const s = fromFEN(FEN)
    const move = { from: nameSq('e1'), to: nameSq('g1') }
    expect(toSAN(s, move)).toBe('O-O')
    expect(parseMove(s, 'O-O')).toEqual(move)
  })

  it('parses and produces O-O-O', () => {
    const s = fromFEN(FEN)
    const move = { from: nameSq('e1'), to: nameSq('c1') }
    expect(toSAN(s, move)).toBe('O-O-O')
    expect(parseMove(s, 'O-O-O')).toEqual(move)
  })
})

describe('toSAN: captures, checks, and mate', () => {
  it('marks captures with x', () => {
    const s = fromFEN('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1')
    expect(toSAN(s, { from: nameSq('e4'), to: nameSq('d5') })).toBe('exd5')
  })

  it('marks a checking move with +', () => {
    const s = fromFEN('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1')
    expect(toSAN(s, { from: nameSq('a1'), to: nameSq('a8') })).toBe('Ra8+')
  })

  it('marks a checkmating move with #', () => {
    // Verified via legalMoves/applyMove/isInCheck: Ra1-a8 is checkmate with
    // the white king on g6 cutting off h8/g7/g8 and the rook covering the
    // back rank.
    const s = fromFEN('7k/8/6K1/8/8/8/8/R7 w - - 0 1')
    expect(toSAN(s, { from: nameSq('a1'), to: nameSq('a8') })).toBe('Ra8#')
  })
})

describe('parseMove: garbage input never throws and returns null', () => {
  it.each(['zzzz', '', 'e9e9'])('returns null for %s', (input) => {
    const s = fromFEN(START)
    expect(() => parseMove(s, input)).not.toThrow()
    expect(parseMove(s, input)).toBeNull()
  })

  it('returns null for the SAN of an illegal move', () => {
    const s = fromFEN(START)
    // No knight can reach e5 from the start position.
    expect(parseMove(s, 'Ne5')).toBeNull()
  })
})
