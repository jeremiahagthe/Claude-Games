import { describe, expect, it } from 'vitest'
import { BOARD_W, LOCK_DELAY_TICKS, LOCK_RESETS_MAX, TOTAL_ROWS } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { stepPlayer } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { GameEvent, PlayerState } from '../src/state.js'

const P = (): PlayerState => createMatch(42, ['a', 'b'], [false, true]).players[0]!
// fillRow: set row y to solid (value 1) except the listed hole columns
const fillRow = (board: number[], y: number, holes: number[] = []) => {
  for (let x = 0; x < BOARD_W; x++) if (!holes.includes(x)) board[bIdx(x, y)] = 1
}
const withPiece = (p: PlayerState, kind: 'I' | 'O' | 'T' | 'S' | 'Z' | 'L' | 'J', rot: 0 | 1 | 2 | 3, x: number, y: number): PlayerState =>
  ({ ...p, piece: { kind, rot, x, y }, board: [...p.board] })
const tick = (p: PlayerState, ev: GameEvent[] = []) => stepPlayer(p, ev)

describe('movement & rotation', () => {
  it('left/right shift; blocked shift is a silent no-op', () => {
    let p = withPiece(P(), 'T', 0, 3, 10)
    expect(tick(p, ['left']).player.piece!.x).toBe(2)
    expect(tick(p, ['right']).player.piece!.x).toBe(4)
    p = withPiece(P(), 'T', 0, 0, 10)              // leftmost cell already at col 0
    expect(tick(p, ['left']).player.piece!.x).toBe(0)
  })
  it('plain CW rotation uses kick (0,0)', () => {
    const out = tick(withPiece(P(), 'T', 0, 3, 10), ['rotCW']).player.piece!
    expect(out.rot).toBe(1); expect(out.x).toBe(3); expect(out.y).toBe(10)
  })
  it('SRS wall kick: vertical T hugging the left wall rotates 1→2 via kick (+1,0)', () => {
    // T rot 1 at x=-1 is legal (occupied cells are cols x+1..x+2); plain 1→2 collides at col x+0
    const out = tick(withPiece(P(), 'T', 1, -1, 10), ['rotCW']).player.piece!
    expect(out.rot).toBe(2); expect(out.x).toBe(0); expect(out.y).toBe(10)
  })
  it('all five kicks failing leaves the piece unchanged', () => {
    const p = withPiece(P(), 'I', 1, 7, 20)        // vertical I in a col-9 shaft
    for (let y = 18; y < TOTAL_ROWS; y++) fillRow(p.board, y, [9])
    const out = tick(p, ['rotCW']).player.piece!
    expect(out).toEqual({ kind: 'I', rot: 1, x: 7, y: 20 })
  })
})

describe('gravity, soft drop, lock delay', () => {
  it('piece falls one cell every gravityTicksAt ticks (20 at tick 0)', () => {
    let p = withPiece(P(), 'T', 0, 3, 10)
    for (let i = 0; i < 19; i++) p = tick(p).player
    expect(p.piece!.y).toBe(10)
    p = tick(p).player
    expect(p.piece!.y).toBe(11)
  })
  it('each softDrop event is one immediate fall', () => {
    const p = withPiece(P(), 'T', 0, 3, 10)
    expect(tick(p, ['softDrop']).player.piece!.y).toBe(11)
    expect(tick(p, ['softDrop', 'softDrop']).player.piece!.y).toBe(12)
  })
  it('grounded piece locks after LOCK_DELAY_TICKS; a shift resets the timer', () => {
    let p = withPiece(P(), 'O', 0, 4, 20)          // O cells rows 20-21… move to floor: y=22 → rows 22-23
    p = withPiece(p, 'O', 0, 4, 22)
    for (let i = 0; i < LOCK_DELAY_TICKS - 1; i++) { const o = tick(p); expect(o.locked).toBe(false); p = o.player }
    const beforeReset = tick(p, ['left'])           // successful shift on the last tick → reset
    expect(beforeReset.locked).toBe(false)
    let q = beforeReset.player
    // FIXTURE FIX (semantics pin): the reset tick above is set-then-decrement in the SAME
    // tick (brief: effective delay = 10 ticks, reset tick counts as tick 1 → lockTicks=9).
    // So only LOCK_DELAY_TICKS-2 further non-locking ticks remain before the lock, not
    // LOCK_DELAY_TICKS-1. The brief literal (…-1) locks one tick too early (inside this
    // loop) and leaves a freshly-spawned piece for the assertion below.
    for (let i = 0; i < LOCK_DELAY_TICKS - 2; i++) q = tick(q).player
    expect(tick(q).locked).toBe(true)
  })
  it('lock-delay resets cap at LOCK_RESETS_MAX', () => {
    let p = withPiece(P(), 'O', 0, 4, 22)
    let locked = false
    // alternate left/right forever; without the cap this never locks
    for (let i = 0; i < (LOCK_RESETS_MAX + 2) * LOCK_DELAY_TICKS && !locked; i++) {
      const o = tick(p, [i % 2 ? 'left' : 'right']); locked = o.locked; p = o.player
    }
    expect(locked).toBe(true)
  })
})

describe('hard drop, clears, attack', () => {
  it('vertical I into a col-9 well clears a double and returns ATTACK[2]=1', () => {
    const p = withPiece(P(), 'I', 1, 7, 4)
    fillRow(p.board, 22, [9]); fillRow(p.board, 23, [9])
    const out = tick(p, ['hardDrop'])
    expect(out.locked).toBe(true)
    expect(out.player.linesCleared).toBe(2)
    expect(out.attack).toBe(1)
    // the two uncleared I cells slid down to the bottom of col 9
    expect(out.player.board[bIdx(9, 23)]).not.toBe(0)
    expect(out.player.board[bIdx(0, 23)]).toBe(0)   // cleared rows really gone
    expect(out.player.piece).not.toBeNull()          // next piece spawned
  })
  it('single clears send nothing; tetris sends 4', () => {
    const single = withPiece(P(), 'I', 0, 0, 22)     // horizontal I lands on row 23, completing it (cols 0-3 were the holes)
    fillRow(single.board, 23, [0, 1, 2, 3])
    expect(tick(single, ['hardDrop']).attack).toBe(0)
    const tetris = withPiece(P(), 'I', 1, 7, 4)
    for (let y = 20; y < 24; y++) fillRow(tetris.board, y, [9])
    const out = tick(tetris, ['hardDrop'])
    expect(out.player.linesCleared).toBe(4); expect(out.attack).toBe(4)
  })
})

describe('hold & top-out', () => {
  it('hold swaps, locks out until next spawn', () => {
    const p = P()
    const firstKind = p.piece!.kind, nextKind = p.queue[0]!
    const held = tick(p, ['hold']).player
    expect(held.hold).toBe(firstKind); expect(held.piece!.kind).toBe(nextKind); expect(held.holdUsed).toBe(true)
    expect(tick(held, ['hold']).player.piece!.kind).toBe(nextKind)  // second hold ignored
  })
  it('spawn into an occupied buffer = top-out', () => {
    // TWO holes per row (cols 0,1) so nothing clears; vertical I locks in the col-0 shaft, next spawn is blocked
    const p = withPiece(P(), 'I', 1, -2, 20)               // rot-1 I occupies col x+2 = 0, rows 20-23
    for (let y = 2; y < 24; y++) fillRow(p.board, y, [0, 1])
    const out = tick(p, ['hardDrop'])                       // already at the floor → locks, no full rows, spawn cells occupied
    expect(out.player.linesCleared).toBe(0)
    expect(out.player.alive).toBe(false)
  })
  it('a piece locking entirely inside the hidden buffer = top-out', () => {
    const p = withPiece(P(), 'O', 0, 4, 2)                  // O at spawn height, rows 2-3
    for (let y = 4; y < 24; y++) fillRow(p.board, y, [0, 1]) // stack reaches the buffer; two holes → no clears
    const out = tick(p, ['hardDrop'])                       // grounded immediately on row 4 → locks at rows 2-3 (all y < 4)
    expect(out.player.alive).toBe(false)
  })
  it('stepPlayer never mutates its input', () => {
    const p = withPiece(P(), 'T', 0, 3, 10)
    const snap = JSON.stringify(p)
    stepPlayer(p, ['left', 'rotCW', 'softDrop'])
    expect(JSON.stringify(p)).toBe(snap)
  })
})
