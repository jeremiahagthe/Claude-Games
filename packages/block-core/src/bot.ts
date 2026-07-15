import { BOARD_W, TOTAL_ROWS } from './constants.js'
import { cellsAt, spawnPiece, type PieceKind, type Rot } from './pieces.js'
import { randStep } from './prng.js'
import { bIdx, collides, type GameEvent, type PlayerState } from './state.js'

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface BotMind {
  rng: number // randStep state, threaded through returned mind
  plan: GameEvent[] // queued events for the current piece
  planForPiece: number // monotonic build counter (a fresh plan each locked piece)
  nextEventTick: number // earliest OWN-clock tick at which the next queued event may emit
}

// El-Tetris / Pierre Dellacherie published weights (pinned — do not retune).
export const W_HEIGHT = -0.510066
export const W_LINES = 0.760666
export const W_HOLES = -0.35663
export const W_BUMP = -0.184483

// Ticks per emitted event, by difficulty.
const CADENCE: Record<Difficulty, number> = { easy: 8, normal: 4, hard: 2 }
export const EASY_TOP3_RATE = 0.25

export function createBotMind(seed: number): BotMind {
  return { rng: seed >>> 0, plan: [], planForPiece: 0, nextEventTick: 0 }
}

interface Placement {
  rot: Rot
  x: number // box-origin x of the landed piece
  score: number
}

// Score a board (rows 0..23) with the 4-term heuristic, given how many rows were cleared.
function scoreBoard(board: number[], cleared: number): number {
  let sumHeight = 0
  let holes = 0
  const heights = new Array<number>(BOARD_W).fill(0)
  for (let x = 0; x < BOARD_W; x++) {
    let topY = TOTAL_ROWS // none filled
    for (let y = 0; y < TOTAL_ROWS; y++) {
      if (board[bIdx(x, y)] !== 0) { topY = y; break }
    }
    const h = TOTAL_ROWS - topY
    heights[x] = h
    sumHeight += h
    for (let y = topY + 1; y < TOTAL_ROWS; y++) {
      if (board[bIdx(x, y)] === 0) holes++
    }
  }
  let bump = 0
  for (let x = 0; x < BOARD_W - 1; x++) bump += Math.abs(heights[x]! - heights[x + 1]!)
  return W_HEIGHT * sumHeight + W_LINES * cleared + W_HOLES * holes + W_BUMP * bump
}

// Stamp piece at (rot,x,restY), clear full rows, return {board, cleared}.
function stampAndClear(board: number[], kind: PieceKind, rot: Rot, x: number, restY: number): { board: number[]; cleared: number } {
  const next = [...board]
  for (const [cx, cy] of cellsAt(kind, rot, x, restY)) next[bIdx(cx, cy)] = 1
  const kept: number[][] = []
  let cleared = 0
  for (let y = 0; y < TOTAL_ROWS; y++) {
    let full = true
    const row = new Array<number>(BOARD_W)
    for (let cx = 0; cx < BOARD_W; cx++) {
      const cell = next[bIdx(cx, y)]!
      row[cx] = cell
      if (cell === 0) full = false
    }
    if (full) cleared++
    else kept.push(row)
  }
  if (cleared === 0) return { board: next, cleared: 0 }
  const out = new Array<number>(TOTAL_ROWS * BOARD_W).fill(0)
  for (let i = 0; i < kept.length; i++) {
    const destY = TOTAL_ROWS - kept.length + i
    const row = kept[i]!
    for (let cx = 0; cx < BOARD_W; cx++) out[bIdx(cx, destY)] = row[cx]!
  }
  return { board: out, cleared }
}

// Enumerate every rot 0..3 × x where the piece fits collision-free at spawn height,
// drop to rest, and score the post-clear board. Sorted best-first.
function enumeratePlacements(board: number[], kind: PieceKind): Placement[] {
  const spawnY = spawnPiece(kind).y
  const out: Placement[] = []
  const seen = new Set<string>() // dedupe rotation-equivalent shapes (O, and I/S/Z 180s)
  for (let rot = 0 as Rot; rot < 4; rot = (rot + 1) as Rot) {
    for (let x = -3; x <= BOARD_W; x++) {
      if (collides(board, { kind, rot, x, y: spawnY })) continue
      // signature of the cell footprint at spawn: skip duplicate shapes at the same columns
      const cells = cellsAt(kind, rot, x, spawnY)
      const sig = cells.map(([cx, cy]) => `${cx},${cy}`).sort().join('|')
      if (seen.has(sig)) continue
      seen.add(sig)
      let restY = spawnY
      while (!collides(board, { kind, rot, x, y: restY + 1 })) restY++
      const { board: after, cleared } = stampAndClear(board, kind, rot, x, restY)
      out.push({ rot, x, score: scoreBoard(after, cleared) })
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// Build the event sequence to reach a placement from a fresh spawn (rot 0, x=startX).
function planEvents(startX: number, startRot: Rot, target: Placement, useHold: boolean): GameEvent[] {
  const events: GameEvent[] = []
  if (useHold) events.push('hold')
  const rotDiff = (target.rot - startRot + 4) & 3
  if (rotDiff === 1) events.push('rotCW')
  else if (rotDiff === 2) events.push('rotCW', 'rotCW')
  else if (rotDiff === 3) events.push('rotCCW')
  const dx = target.x - startX
  for (let i = 0; i < Math.abs(dx); i++) events.push(dx < 0 ? 'left' : 'right')
  events.push('hardDrop')
  return events
}

// Pure-ish per-tick decision: builds a plan when idle, then paces emission by cadence.
export function botDecide(p: PlayerState, mind: BotMind, d: Difficulty): { events: GameEvent[]; mind: BotMind } {
  if (!p.alive || !p.piece) return { events: [], mind }

  const m: BotMind = { ...mind, plan: [...mind.plan] }

  if (m.plan.length === 0) {
    const piece = p.piece
    const candidates = enumeratePlacements(p.board, piece.kind)
    if (candidates.length === 0) return { events: [], mind: m } // no legal placement (near-dead)

    let chosen = candidates[0]!
    let useHold = false
    let startX = piece.x
    let startRot = piece.rot

    if (d === 'easy') {
      const roll = randStep(m.rng)
      m.rng = roll.next
      if (roll.value < EASY_TOP3_RATE) {
        const pick = randStep(m.rng)
        m.rng = pick.next
        const top = Math.min(3, candidates.length)
        chosen = candidates[Math.floor(pick.value * top)]!
      }
    } else if (d === 'hard') {
      const swapKind: PieceKind = p.hold ?? p.queue[0]!
      const swapCandidates = enumeratePlacements(p.board, swapKind)
      if (swapCandidates.length > 0 && swapCandidates[0]!.score > chosen.score) {
        chosen = swapCandidates[0]!
        useHold = true
        startX = spawnPiece(swapKind).x
        startRot = 0
      }
    }

    m.plan = planEvents(startX, startRot, chosen, useHold)
    m.planForPiece = mind.planForPiece + 1
  }

  if (m.plan.length > 0 && p.tick >= m.nextEventTick) {
    const ev = m.plan.shift()!
    m.nextEventTick = p.tick + CADENCE[d]
    return { events: [ev], mind: m }
  }
  return { events: [], mind: m }
}
