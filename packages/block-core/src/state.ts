import { BOARD_W, GRAVITY_SCHEDULE, TOTAL_ROWS } from './constants.js'
import { cellsAt, type PieceKind, type Rot } from './pieces.js'

export type GameEvent = 'left' | 'right' | 'rotCW' | 'rotCCW' | 'softDrop' | 'hardDrop' | 'hold'
export const EVENT_CODES: readonly GameEvent[] = ['left', 'right', 'rotCW', 'rotCCW', 'softDrop', 'hardDrop', 'hold'] // wire code = index

export interface ActivePiece { kind: PieceKind; rot: Rot; x: number; y: number }
export interface GarbageEntry { rows: number; holeCol: number }

export interface PlayerState {
  id: number; name: string; bot: boolean; alive: boolean
  tick: number // OWN sim clock (the per-player-clock model)
  board: number[] // TOTAL_ROWS*BOARD_W cells, idx=y*BOARD_W+x; 0 empty, 1-7 KINDS index+1, 8 garbage
  piece: ActivePiece | null // null only after death
  queue: PieceKind[] // upcoming pieces; refilled to >= PREVIEW+1 by bag shuffles
  bagRng: number // randStep state — IDENTICAL for both players at creation (same sequence)
  hold: PieceKind | null
  holdUsed: boolean // one hold per piece
  fallCooldown: number // ticks until next gravity fall
  lockTicks: number | null // countdown while grounded, null when airborne
  lockResets: number // per-piece, cleared on spawn
  pendingGarbage: GarbageEntry[]
  linesCleared: number; linesSent: number
}

export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }
export interface MatchState { players: [PlayerState, PlayerState]; garbageRng: number; result: Result | null }

export function bIdx(x: number, y: number): number {
  return y * BOARD_W + x
}

export function gravityTicksAt(tick: number): number {
  let ticksPerCell = GRAVITY_SCHEDULE[0]![1]
  for (const [fromTick, tpc] of GRAVITY_SCHEDULE) {
    if (tick >= fromTick) ticksPerCell = tpc
    else break
  }
  return ticksPerCell
}

export function collides(board: number[], p: ActivePiece): boolean {
  for (const [x, y] of cellsAt(p.kind, p.rot, p.x, p.y)) {
    if (x < 0 || x >= BOARD_W || y < 0 || y >= TOTAL_ROWS) return true
    if (board[bIdx(x, y)] !== 0) return true
  }
  return false
}
