// Pure selection/input state machine: no I/O, no terminal, no clocks. game.ts
// drives it with events derived from mouse/keyboard input and applies the
// move it emits (if any) via chess-core's applyMove.
import type { ChessState, Color, Move } from 'checkwait-core'
import { legalMoves, parseMove } from 'checkwait-core'

export interface SelectState {
  selected: number | null
  cursor: number
  pendingPromotion: { from: number; to: number } | null
}

export type SelectEvent =
  | { kind: 'click'; square: number }
  | { kind: 'cursor'; dir: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'enter' }
  | { kind: 'typed'; text: string }
  | { kind: 'promo'; piece: 'q' | 'r' | 'b' | 'n' }

export const INITIAL_SELECT_STATE: SelectState = { selected: null, cursor: 0, pendingPromotion: null }

function isOwnPiece(s: ChessState, square: number, selfColor: Color): boolean {
  const piece = s.board[square]
  return !!piece && piece.color === selfColor
}

function moveCursor(cursor: number, dir: 'up' | 'down' | 'left' | 'right'): number {
  const file = cursor % 8
  const rank = Math.floor(cursor / 8)
  if (dir === 'up') return Math.min(7, rank + 1) * 8 + file
  if (dir === 'down') return Math.max(0, rank - 1) * 8 + file
  if (dir === 'left') return rank * 8 + Math.max(0, file - 1)
  return rank * 8 + Math.min(7, file + 1) // right
}

// Shared by 'click' and 'enter' (enter mirrors a click at the cursor square).
function handleTarget(
  s: ChessState,
  sel: SelectState,
  square: number,
  selfColor: Color,
): { sel: SelectState; move: Move | null } {
  if (sel.selected === null || sel.selected === square) {
    // Nothing selected yet, or re-clicking the current selection: select the
    // square's own piece (a no-op reselect for the "same square" case doubles
    // as a deselect-toggle), else do nothing.
    if (sel.selected === square) return { sel: { ...sel, selected: null }, move: null }
    if (isOwnPiece(s, square, selfColor)) return { sel: { ...sel, selected: square }, move: null }
    return { sel, move: null }
  }

  const candidates = legalMoves(s).filter((m) => m.from === sel.selected && m.to === square)
  if (candidates.length === 0) {
    // Not a legal target: reselect if it's another own piece, else clear.
    if (isOwnPiece(s, square, selfColor)) return { sel: { ...sel, selected: square }, move: null }
    return { sel: { ...sel, selected: null }, move: null }
  }
  if (candidates.length > 1) {
    // Multiple candidates for the same from/to pair only happens for
    // promotions (one per q/r/b/n) — park it for the promo event to resolve.
    return { sel: { ...sel, selected: null, pendingPromotion: { from: sel.selected, to: square } }, move: null }
  }
  return { sel: { ...sel, selected: null }, move: candidates[0]! }
}

export function selectStep(
  s: ChessState,
  sel: SelectState,
  e: SelectEvent,
  selfColor: Color,
): { sel: SelectState; move: Move | null } {
  if (e.kind === 'promo') {
    if (!sel.pendingPromotion) return { sel, move: null }
    const { from, to } = sel.pendingPromotion
    return { sel: { ...sel, pendingPromotion: null }, move: { from, to, promotion: e.piece } }
  }

  if (e.kind === 'cursor') {
    return { sel: { ...sel, cursor: moveCursor(sel.cursor, e.dir) }, move: null }
  }

  if (e.kind === 'enter') {
    return handleTarget(s, sel, sel.cursor, selfColor)
  }

  if (e.kind === 'click') {
    return handleTarget(s, sel, e.square, selfColor)
  }

  // 'typed': only ever emits on the player's own turn — parseMove already
  // scopes candidates to legalMoves(s), which is itself scoped to s.turn, so
  // this guard is a defensive/explicit statement of that same invariant.
  if (s.turn !== selfColor) return { sel, move: null }
  return { sel, move: parseMove(s, e.text) }
}
