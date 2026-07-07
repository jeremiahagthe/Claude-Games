import { describe, expect, it } from 'vitest'
import { fromFEN } from '../src/fen.js'
import { applyMove, legalMoves } from '../src/movegen.js'
import type { ChessState } from '../src/board.js'

function perft(s: ChessState, depth: number): number {
  if (depth === 0) return 1
  let n = 0
  for (const m of legalMoves(s)) n += perft(applyMove(s, m), depth - 1)
  return n
}
// Standard perft suite — these node counts are the industry-accepted ground
// truth for a correct legal-move generator (castling/ep/promotion edges included).
const CASES: Array<[string, number[]]> = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
]
describe('perft', () => {
  for (const [fen, counts] of CASES) {
    counts.forEach((expected, i) => {
      it(
        `${fen.split(' ')[0]} depth ${i + 1} = ${expected}`,
        () => {
          expect(perft(fromFEN(fen), i + 1)).toBe(expected)
        },
        // applyMove now stamps `result` via detectResult (which itself runs a
        // full legalMoves pass) on every move, so deep perft nodes cost more
        // than the default 5s test timeout allows.
        30_000,
      )
    })
  }
})
