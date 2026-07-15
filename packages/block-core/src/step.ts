import {
  ATTACK,
  BOARD_W,
  HIDDEN_ROWS,
  LOCK_DELAY_TICKS,
  LOCK_RESETS_MAX,
  MAX_EVENTS_PER_TICK,
  PREVIEW,
  TOTAL_ROWS,
} from './constants.js'
import { cellsAt, KICKS_I, KICKS_JLSTZ, KINDS, spawnPiece, type PieceKind } from './pieces.js'
import { randStep } from './prng.js'
import { bIdx, collides, gravityTicksAt, type ActivePiece, type GameEvent, type PlayerState } from './state.js'

export interface StepOut { player: PlayerState; attack: number; locked: boolean }

// Fisher-Yates shuffle of a fresh 7-bag, threading rng state explicitly (mirrors match.ts).
function shuffledBag(rng: number): { bag: PieceKind[]; next: number } {
  const bag = [...KINDS]
  let state = rng
  for (let i = bag.length - 1; i > 0; i--) {
    const { value, next } = randStep(state)
    state = next
    const j = Math.floor(value * (i + 1))
    const tmp = bag[i]!
    bag[i] = bag[j]!
    bag[j] = tmp
  }
  return { bag, next: state }
}

// Refill queue in place to >= PREVIEW+1 by appending shuffled bags (mirrors match.ts).
function refillQueue(queue: PieceKind[], rng: number): number {
  let state = rng
  while (queue.length < PREVIEW + 1) {
    const { bag, next } = shuffledBag(state)
    state = next
    queue.push(...bag)
  }
  return state
}

// Draw the next piece from the queue (refilling first), returning the mutated draft's new piece.
// Mutates the draft (queue/bagRng); caller owns a fresh clone.
function drawNext(draft: PlayerState): PieceKind {
  draft.bagRng = refillQueue(draft.queue, draft.bagRng)
  return draft.queue.shift()!
}

// LOCK a grounded piece into the board: stamp cells, top-out check, clear rows, respawn.
// Mutates the draft in place; sets draft.alive=false + draft.piece=null on top-out. Returns attack.
function lockPiece(draft: PlayerState): number {
  const piece = draft.piece!
  const cells = cellsAt(piece.kind, piece.rot, piece.x, piece.y)
  const value = KINDS.indexOf(piece.kind) + 1
  let allHidden = true
  for (const [x, y] of cells) {
    draft.board[bIdx(x, y)] = value
    if (y >= HIDDEN_ROWS) allHidden = false
  }
  // Piece locked entirely inside the hidden buffer → top-out.
  if (allHidden) {
    draft.alive = false
    draft.piece = null
    return 0
  }

  // Clear full rows: build a new board keeping only non-full rows, shifting the rest down.
  const kept: number[][] = []
  let cleared = 0
  for (let y = 0; y < TOTAL_ROWS; y++) {
    let full = true
    const row: number[] = new Array<number>(BOARD_W)
    for (let x = 0; x < BOARD_W; x++) {
      const cell = draft.board[bIdx(x, y)]!
      row[x] = cell
      if (cell === 0) full = false
    }
    if (full) cleared++
    else kept.push(row)
  }
  if (cleared > 0) {
    const next = new Array<number>(TOTAL_ROWS * BOARD_W).fill(0)
    // kept rows land at the bottom; the top `cleared` rows become empty.
    for (let i = 0; i < kept.length; i++) {
      const destY = TOTAL_ROWS - kept.length + i
      const row = kept[i]!
      for (let x = 0; x < BOARD_W; x++) next[bIdx(x, destY)] = row[x]!
    }
    draft.board = next
    draft.linesCleared += cleared
  }
  const attack = ATTACK[cleared]!

  // Spawn the next piece.
  const kind = drawNext(draft)
  draft.holdUsed = false
  draft.lockResets = 0
  draft.lockTicks = null
  draft.fallCooldown = gravityTicksAt(draft.tick)
  const spawned = spawnPiece(kind)
  if (collides(draft.board, spawned)) {
    draft.alive = false
    draft.piece = null
  } else {
    draft.piece = spawned
  }
  return attack
}

// A pure, single-board, single-tick reducer. Never mutates its inputs.
export function stepPlayer(p: PlayerState, events: GameEvent[]): StepOut {
  if (!p.alive) return { player: p, attack: 0, locked: false }

  // Deep-enough clone: board/queue/pendingGarbage arrays + piece object are all replaced below.
  const draft: PlayerState = {
    ...p,
    board: [...p.board],
    queue: [...p.queue],
    pendingGarbage: p.pendingGarbage.map((g) => ({ ...g })),
    piece: p.piece ? { ...p.piece } : null,
  }

  // Phase 1: advance this board's clock so all later phases see the new tick.
  draft.tick += 1

  let attack = 0
  let locked = false

  const tryMove = (dx: number, dy: number): boolean => {
    const cand: ActivePiece = { ...draft.piece!, x: draft.piece!.x + dx, y: draft.piece!.y + dy }
    if (collides(draft.board, cand)) return false
    draft.piece = cand
    return true
  }

  const tryRotate = (dir: 1 | -1): boolean => {
    const from = draft.piece!.rot
    const target = ((from + dir + 4) & 3) as 0 | 1 | 2 | 3
    const table = draft.piece!.kind === 'I' ? KICKS_I : KICKS_JLSTZ
    const key = `${from}${target}` as keyof typeof table
    for (const [dx, dy] of table[key]) {
      const cand: ActivePiece = { kind: draft.piece!.kind, rot: target, x: draft.piece!.x + dx, y: draft.piece!.y + dy }
      if (!collides(draft.board, cand)) {
        draft.piece = cand
        return true
      }
    }
    return false
  }

  // On a successful grounded move/rotate, re-arm the lock timer (bounded by LOCK_RESETS_MAX).
  const onSuccessfulShift = () => {
    if (draft.lockTicks !== null && draft.lockResets < LOCK_RESETS_MAX) {
      draft.lockTicks = LOCK_DELAY_TICKS
      draft.lockResets += 1
    }
  }

  // Phase 2: apply events in order, capped at MAX_EVENTS_PER_TICK; at most ONE lock per tick.
  const capped = events.slice(0, MAX_EVENTS_PER_TICK)
  for (const ev of capped) {
    if (locked) break // a lock happened this tick → drop remaining events
    switch (ev) {
      case 'left':
        if (tryMove(-1, 0)) onSuccessfulShift()
        break
      case 'right':
        if (tryMove(1, 0)) onSuccessfulShift()
        break
      case 'rotCW':
        if (tryRotate(1)) onSuccessfulShift()
        break
      case 'rotCCW':
        if (tryRotate(-1)) onSuccessfulShift()
        break
      case 'softDrop':
        tryMove(0, 1) // no-op on collision; grounding is phase 3/4's job
        break
      case 'hardDrop':
        while (tryMove(0, 1)) { /* fall to rest */ }
        attack = lockPiece(draft)
        locked = true
        break
      case 'hold': {
        if (draft.holdUsed) break
        const swapOut = draft.piece!.kind
        const newKind = draft.hold ?? drawNext(draft)
        draft.hold = swapOut
        draft.holdUsed = true
        draft.fallCooldown = gravityTicksAt(draft.tick)
        draft.lockTicks = null
        draft.lockResets = 0
        const spawned = spawnPiece(newKind)
        if (collides(draft.board, spawned)) {
          draft.alive = false
          draft.piece = null
        } else {
          draft.piece = spawned
        }
        break
      }
    }
    if (!draft.alive) break // top-out mid-events → stop
  }

  if (!draft.alive || locked) return { player: draft, attack, locked }

  // Phase 3: gravity.
  draft.fallCooldown -= 1
  if (draft.fallCooldown <= 0) {
    tryMove(0, 1)
    draft.fallCooldown = gravityTicksAt(draft.tick)
  }

  // Phase 4: grounded bookkeeping + lock-delay countdown.
  const grounded = collides(draft.board, { ...draft.piece!, y: draft.piece!.y + 1 })
  if (grounded) {
    if (draft.lockTicks === null) draft.lockTicks = LOCK_DELAY_TICKS
    draft.lockTicks -= 1
    if (draft.lockTicks <= 0) {
      attack = lockPiece(draft)
      locked = true
    }
  } else {
    draft.lockTicks = null // lockResets KEEPS counting for this piece (reset only on spawn)
  }

  return { player: draft, attack, locked }
}
