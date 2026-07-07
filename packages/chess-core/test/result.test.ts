import { describe, expect, it } from 'vitest'
import { INCREMENT_MS, INITIAL_CLOCK_MS, initialState, nameSq } from '../src/board.js'
import { fromFEN } from '../src/fen.js'
import { applyMove, legalMoves } from '../src/movegen.js'
import { detectResult, tickClock } from '../src/result.js'

describe('detectResult', () => {
  it('checkmate: fool\'s mate — white to move, no legal moves, in check', () => {
    const s = fromFEN('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')
    expect(legalMoves(s)).toHaveLength(0)
    expect(s.turn).toBe('w')
    expect(detectResult(s)).toEqual({ kind: 'checkmate', winner: 'b' })
  })

  it('stalemate: black to move, no legal moves, not in check', () => {
    const s = fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
    expect(legalMoves(s)).toHaveLength(0)
    expect(detectResult(s)).toEqual({ kind: 'stalemate' })
  })

  it('fifty-move: halfmoveClock >= 100 with legal moves and sufficient material', () => {
    const s = fromFEN('4k3/8/8/8/8/8/4P3/4K3 w - - 100 60')
    expect(legalMoves(s).length).toBeGreaterThan(0)
    expect(detectResult(s)).toEqual({ kind: 'fifty-move' })
  })

  it('threefold: Nf3 Nf6 Ng1 Ng8 twice returns to the start position a third time', () => {
    const moves: Array<[string, string]> = [
      ['g1', 'f3'],
      ['g8', 'f6'],
      ['f3', 'g1'],
      ['f6', 'g8'],
      ['g1', 'f3'],
      ['g8', 'f6'],
      ['f3', 'g1'],
      ['f6', 'g8'],
    ]
    let s = initialState()
    for (const [from, to] of moves) {
      s = applyMove(s, { from: nameSq(from), to: nameSq(to) })
    }
    expect(detectResult(s)).toEqual({ kind: 'threefold' })
  })

  it('insufficient material: K+N vs K after any move', () => {
    const s = fromFEN('8/8/8/4k3/8/8/8/4K2N w - - 0 1')
    const moves = legalMoves(s)
    expect(moves.length).toBeGreaterThan(0)
    const next = applyMove(s, moves[0]!)
    expect(detectResult(next)).toEqual({ kind: 'insufficient' })
  })
})

describe('tickClock', () => {
  it('is pure and clamps to 0 with a flag result when the clock runs out', () => {
    const s = initialState()
    const next = tickClock(s, 180_001)
    expect(s.clocksMs.w).toBe(INITIAL_CLOCK_MS)
    expect(next.clocksMs.w).toBe(0)
    expect(next.result).toEqual({ kind: 'flag', winner: 'b' })
  })

  it('subtracts elapsed time from the to-move player without flagging', () => {
    const s = initialState()
    const next = tickClock(s, 5_000)
    expect(next.clocksMs.w).toBe(INITIAL_CLOCK_MS - 5_000)
    expect(next.result).toBeNull()
  })

  it('flags to insufficient when the flagged player\'s opponent cannot mate', () => {
    const s = fromFEN('8/8/8/4k3/8/8/8/4K2N w - - 0 1')
    const next = tickClock(s, INITIAL_CLOCK_MS + 1)
    expect(next.result).toEqual({ kind: 'insufficient' })
  })
})

describe('applyMove clock increment', () => {
  it('adds INCREMENT_MS to the mover clock after ticking it down', () => {
    const s = initialState()
    const ticked = tickClock(s, 5_000)
    const next = applyMove(ticked, { from: nameSq('e2'), to: nameSq('e4') })
    expect(next.clocksMs.w).toBe(INITIAL_CLOCK_MS - 5_000 + INCREMENT_MS)
    expect(next.clocksMs.w).toBe(177_000)
  })
})
