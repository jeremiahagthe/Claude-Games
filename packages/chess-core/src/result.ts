import type { ChessState, Color, Piece, Result } from './board.js'
import { isInCheck, legalMoves, positionKey } from './movegen.js'

function other(c: Color): Color {
  return c === 'w' ? 'b' : 'w'
}

function squareColor(i: number): 0 | 1 {
  const file = i % 8
  const rank = Math.floor(i / 8)
  return ((file + rank) % 2) as 0 | 1
}

// True when `color` alone lacks mating material: bare K, K+single N, or
// K+single B. Used by tickClock — a flag is only a win for the opponent if
// the OPPONENT could ever deliver mate; the flagged player's own material
// is irrelevant (FIDE 6.9).
function sideHasInsufficientMaterial(s: ChessState, color: Color): boolean {
  const pieces: Piece[] = []
  for (const piece of s.board) {
    if (piece && piece.color === color && piece.type !== 'k') pieces.push(piece)
  }
  if (pieces.length === 0) return true
  if (pieces.length === 1) {
    const type = pieces[0]!.type
    return type === 'n' || type === 'b'
  }
  return false
}

// Whole-board symmetric check: K vs K, K+N/B vs K, or K+B vs K+B with
// same-colored bishops — NO side can force checkmate. Used by detectResult
// to declare a dead-material draw.
export function isInsufficientMaterial(s: ChessState): boolean {
  const pieces: Array<{ piece: Piece; square: number }> = []
  for (let i = 0; i < 64; i++) {
    const piece = s.board[i]
    if (piece && piece.type !== 'k') pieces.push({ piece, square: i })
  }
  if (pieces.length === 0) return true
  if (pieces.length === 1) {
    const type = pieces[0]!.piece.type
    return type === 'n' || type === 'b'
  }
  if (pieces.length === 2) {
    const [a, b] = pieces as [{ piece: Piece; square: number }, { piece: Piece; square: number }]
    if (a.piece.type === 'b' && b.piece.type === 'b' && a.piece.color !== b.piece.color) {
      return squareColor(a.square) === squareColor(b.square)
    }
  }
  return false
}

/**
 * Determine whether the game has ended in the given position. Checked in
 * order: checkmate/stalemate (no legal moves for the side to move), then
 * fifty-move rule, then threefold repetition, then insufficient material.
 * Returns null if the game is still ongoing.
 *
 * Contract: this reflects only the position `s` describes — it does not
 * know about clocks. Callers combine this with tickClock's flag/insufficient
 * results to get the full game-ending picture.
 */
export function detectResult(s: ChessState): Result | null {
  if (legalMoves(s).length === 0) {
    return isInCheck(s, s.turn) ? { kind: 'checkmate', winner: other(s.turn) } : { kind: 'stalemate' }
  }
  if (s.halfmoveClock >= 100) return { kind: 'fifty-move' }
  const key = positionKey(s)
  const occurrences = s.history.filter((k) => k === key).length
  if (occurrences >= 3) return { kind: 'threefold' }
  if (isInsufficientMaterial(s)) return { kind: 'insufficient' }
  return null
}

/**
 * PURE: subtracts elapsedMs from the to-move player's clock. Contract: the
 * caller ticks the mover's clock down via tickClock BEFORE calling
 * applyMove; applyMove then adds INCREMENT_MS to the mover's clock after
 * the move completes. At <= 0 the clock clamps to 0 and the game ends: a
 * {kind:'flag', winner: opponent} loss for the flagged player, unless the
 * opponent has insufficient mating material, in which case it's a draw
 * {kind:'insufficient'}.
 */
export function tickClock(s: ChessState, elapsedMs: number): ChessState {
  const mover = s.turn
  const remaining = s.clocksMs[mover] - elapsedMs
  const clocksMs = { ...s.clocksMs, [mover]: Math.max(0, remaining) }
  if (remaining > 0) {
    return { ...s, clocksMs }
  }
  // Scope the check to the flagged player's OPPONENT: the flag is only a
  // win if the opponent could ever mate (e.g. white K+Q flags vs bare black
  // K → draw; but bare black K flags vs white K+Q → white wins).
  const result: Result = sideHasInsufficientMaterial(s, other(mover))
    ? { kind: 'insufficient' }
    : { kind: 'flag', winner: other(mover) }
  return { ...s, clocksMs, result }
}
