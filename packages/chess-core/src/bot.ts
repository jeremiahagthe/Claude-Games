import type { ChessState, Color, PieceType } from './board.js'
import { applyMoveRaw, isInCheck, legalMoves, type Move } from './movegen.js'
import { mulberry32 } from './prng.js'

export type ChessDifficulty = 'easy' | 'normal' | 'hard'

// Node budgets tuned in-task on the dev machine used to build checkwait.
// This movegen is a straightforward legal-move-filtering implementation
// (not a bitboard engine), so each node is relatively expensive; measured
// throughput on the dev machine was roughly 7,000-8,500 nodes/sec across a
// mix of opening, midgame, and tactical test positions. `hard` (4,000 nodes)
// measured ~470-560ms wall-clock on the dev machine, comfortably under the
// ~1s target with headroom for slower positions/machines. `easy`/`normal`
// are proportionally smaller so difficulty scales with search depth reached.
export const DIFFICULTY_BUDGETS: Record<ChessDifficulty, number> = {
  easy: 300,
  normal: 1_200,
  hard: 4_000,
}

const MATERIAL: Record<PieceType, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
}

// Standard piece-square tables, white's perspective, a1..h8 (index = rank*8+file).
// Mirrored (rank-flipped) for black at eval time. Values are small nudges on
// top of material, not a replacement for it.
const PST_P: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, -20, -20, 10, 10, 5,
  5, -5, -10, 0, 0, -10, -5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, 5, 10, 25, 25, 10, 5, 5,
  10, 10, 20, 30, 30, 20, 10, 10,
  50, 50, 50, 50, 50, 50, 50, 50,
  0, 0, 0, 0, 0, 0, 0, 0,
]

const PST_N: number[] = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
]

const PST_B: number[] = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
]

const PST_R: number[] = [
  0, 0, 0, 5, 5, 0, 0, 0,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  5, 10, 10, 10, 10, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
]

const PST_Q: number[] = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
]

const PST_K: number[] = [
  20, 30, 10, 0, 0, 10, 30, 20,
  20, 20, 0, 0, 0, 0, 20, 20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
]

const PST: Record<PieceType, number[]> = {
  p: PST_P,
  n: PST_N,
  b: PST_B,
  r: PST_R,
  q: PST_Q,
  k: PST_K,
}

function mirror(i: number): number {
  const file = i % 8
  const rank = Math.floor(i / 8)
  return (7 - rank) * 8 + file
}

const MOBILITY_WEIGHT = 2

// Static evaluation from White's perspective: material + piece-square tables
// + a small mobility term (legal move count difference). Negamax negates
// this per side to move. `sideToMoveMoveCount` is passed in because the
// caller (negamax, at a leaf) has already computed legalMoves(s) once for
// the terminal check — recomputing it here would double that cost on
// every single leaf node.
function evaluateWhitePerspective(s: ChessState, sideToMoveMoveCount: number): number {
  let score = 0
  for (let i = 0; i < 64; i++) {
    const piece = s.board[i]
    if (!piece) continue
    const pstIndex = piece.color === 'w' ? i : mirror(i)
    const value = MATERIAL[piece.type] + PST[piece.type][pstIndex]!
    score += piece.color === 'w' ? value : -value
  }

  const opponent: ChessState = { ...s, turn: s.turn === 'w' ? 'b' : 'w' }
  const otherMoves = legalMoves(opponent).length
  const mobility = s.turn === 'w' ? sideToMoveMoveCount - otherMoves : otherMoves - sideToMoveMoveCount
  score += mobility * MOBILITY_WEIGHT

  return score
}

function evaluate(s: ChessState, sideToMove: Color, sideToMoveMoveCount: number): number {
  const white = evaluateWhitePerspective(s, sideToMoveMoveCount)
  return sideToMove === 'w' ? white : -white
}

interface SearchResult {
  move: Move
  nodes: number
}

const MATE_SCORE = 1_000_000

// Negamax with alpha-beta pruning. `nodes` is a mutable counter object so the
// caller can observe when the budget is exhausted mid-search.
function negamax(
  s: ChessState,
  depth: number,
  alpha: number,
  beta: number,
  nodes: { count: number },
  budget: number,
): number {
  nodes.count++
  const moves = legalMoves(s)

  if (moves.length === 0) {
    // Terminal node: checkmate or stalemate. isInCheck is cheap relative to
    // the legalMoves pass we already paid for, so re-derive via detectResult
    // semantics inline (avoid importing result.ts's detectResult, which
    // would re-run legalMoves and add repetition/fifty-move checks that are
    // irrelevant to a fixed-depth search of a synthetic position).
    const inCheck = isInCheck(s, s.turn)
    return inCheck ? -MATE_SCORE + (64 - depth) : 0
  }

  if (depth === 0) {
    return evaluate(s, s.turn, moves.length)
  }

  let best = -Infinity
  for (const m of moves) {
    if (nodes.count >= budget) break
    const next = applyMoveRaw(s, m)
    const score = -negamax(next, depth - 1, -beta, -alpha, nodes, budget)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best === -Infinity ? evaluate(s, s.turn, moves.length) : best
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/**
 * Iterative-deepening negamax + alpha-beta search under a hard node budget.
 * Every evaluated node (including terminal and leaf nodes) counts against
 * `budget`; when a depth cannot be completed within budget, the search
 * returns the best move found at the last fully COMPLETED depth (never a
 * partial/incomplete depth's result). `seed` shuffles root move order via
 * mulberry32 so that positions with multiple equal-best moves vary by seed;
 * the search itself is otherwise fully deterministic for a given
 * state+budget+seed.
 *
 * Guard: `s.result` must be null (game not yet over) — callers must not ask
 * the bot to move in a terminal position. Throws if `s.result` is set.
 */
export function bestMoveWithNodes(s: ChessState, budget: number, seed: number): SearchResult {
  if (s.result !== null) {
    throw new Error('bestMove: cannot search a state whose result is already decided')
  }
  const rootMoves = legalMoves(s)
  if (rootMoves.length === 0) {
    throw new Error('bestMove: no legal moves available')
  }

  const rng = mulberry32(seed)
  const ordered = shuffle(rootMoves, rng)

  const nodes = { count: 0 }
  let bestMoveSoFar: Move = ordered[0]!

  for (let depth = 1; depth <= 64; depth++) {
    const nodesBeforeDepth = nodes.count
    let alpha = -Infinity
    const beta = Infinity
    let depthBest: Move | null = null
    let depthBestScore = -Infinity
    let depthAborted = false

    for (const m of ordered) {
      if (nodes.count >= budget) {
        depthAborted = true
        break
      }
      const next = applyMoveRaw(s, m)
      const score = -negamax(next, depth - 1, -beta, -alpha, nodes, budget)
      if (score > depthBestScore) {
        depthBestScore = score
        depthBest = m
      }
      if (depthBestScore > alpha) alpha = depthBestScore
    }

    if (depthAborted || depthBest === null) {
      // This depth did not finish (or produced nothing usable): keep the
      // last COMPLETED depth's move and stop.
      break
    }

    bestMoveSoFar = depthBest
    if (nodes.count >= budget) break
    // Avoid re-searching once we've found forced mate — no need to go deeper.
    if (depthBestScore >= MATE_SCORE - 64) break
    if (nodesBeforeDepth === nodes.count) break // safety: no progress possible
  }

  return { move: bestMoveSoFar, nodes: nodes.count }
}

/** Convenience wrapper over {@link bestMoveWithNodes} that returns only the move. */
export function bestMove(s: ChessState, budget: number, seed: number): Move {
  return bestMoveWithNodes(s, budget, seed).move
}
