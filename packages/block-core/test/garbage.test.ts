import { describe, expect, it } from 'vitest'
import { BOARD_W, GARBAGE, SUDDEN_DEATH_INTERVAL, SUDDEN_DEATH_TICK } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { killPlayer, queueGarbage, step, stepPlayer, suddenDeathHole } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { PlayerState } from '../src/state.js'

const M = () => createMatch(42, ['a','b'], [false,true])
const fillRow = (board: number[], y: number, holes: number[] = []) => {
  for (let x = 0; x < BOARD_W; x++) if (!holes.includes(x)) board[bIdx(x, y)] = 1
}

describe('pending garbage', () => {
  it('materializes at the victim own next lock: rows rise, hole column open, stack shifted up', () => {
    let p: PlayerState = { ...M().players[0]!, piece: { kind: 'O', rot: 0, x: 4, y: 22 } , board: [...M().players[0]!.board] }
    p.board[bIdx(0, 23)] = 3                              // a marker cell to watch shift up
    p = queueGarbage(p, 2, 3)
    const out = stepPlayer(p, ['hardDrop'])
    expect(out.player.pendingGarbage).toEqual([])
    for (const y of [22, 23]) for (let x = 0; x < BOARD_W; x++)
      expect(out.player.board[bIdx(x, y)]).toBe(x === 3 ? 0 : GARBAGE)
    expect(out.player.board[bIdx(0, 21)]).toBe(3)         // marker moved up 2
  })
  it('attack cancels pending 1:1 before sending; remainder materializes', () => {
    let p: PlayerState = { ...M().players[0]!, piece: { kind: 'I', rot: 1, x: 7, y: 4 }, board: [...M().players[0]!.board] }
    fillRow(p.board, 22, [9]); fillRow(p.board, 23, [9])  // double coming → raw attack 1
    p = queueGarbage(p, 2, 3)
    const out = stepPlayer(p, ['hardDrop'])
    expect(out.attack).toBe(0)                            // 1 attack swallowed by 2 pending
    expect(out.player.linesSent).toBe(0)
    // 1 pending row remains and materializes at this same lock:
    for (let x = 0; x < BOARD_W; x++) expect(out.player.board[bIdx(x, 23)]).toBe(x === 3 ? 0 : GARBAGE)
  })
})

describe('sudden death', () => {
  it('from SUDDEN_DEATH_TICK a neutral row lands every interval at the pinned hole', () => {
    let p: PlayerState = { ...M().players[0]!, tick: SUDDEN_DEATH_TICK - 1 }
    const out = stepPlayer(p, [])
    expect(out.player.tick).toBe(SUDDEN_DEATH_TICK)
    for (let x = 0; x < BOARD_W; x++) expect(out.player.board[bIdx(x, 23)]).toBe(x === suddenDeathHole(0) ? 0 : GARBAGE)
    expect(suddenDeathHole(0)).toBe(5); expect(suddenDeathHole(1)).toBe(8); expect(suddenDeathHole(2)).toBe(1)
  })
  it('interval spacing: no second row until +SUDDEN_DEATH_INTERVAL', () => {
    let p: PlayerState = { ...M().players[0]!, tick: SUDDEN_DEATH_TICK - 1 }
    p = stepPlayer(p, []).player
    for (let i = 0; i < SUDDEN_DEATH_INTERVAL - 1; i++) p = stepPlayer(p, []).player
    const rows23to22 = [22, 23].map((y) => p.board.slice(y * BOARD_W, (y + 1) * BOARD_W).filter((c) => c === GARBAGE).length)
    expect(rows23to22[1]).toBeGreaterThan(0)              // first row present
    // second arrives exactly on the next boundary:
    const before22 = rows23to22[0]
    p = stepPlayer(p, []).player
    expect(p.board.slice(22 * BOARD_W, 23 * BOARD_W).filter((c) => c === GARBAGE).length).toBeGreaterThan(before22!)
  })
})

describe('offline step() routing + result', () => {
  it('p0 double → p1 pendingGarbage 1 row with a seeded hole', () => {
    const m = M()
    m.players[0] = { ...m.players[0]!, piece: { kind: 'I', rot: 1, x: 7, y: 4 }, board: [...m.players[0]!.board] }
    fillRow(m.players[0]!.board, 22, [9]); fillRow(m.players[0]!.board, 23, [9])
    const out = step(m, [['hardDrop'], []])
    expect(out.players[1]!.pendingGarbage).toHaveLength(1)
    expect(out.players[1]!.pendingGarbage[0]!.rows).toBe(1)
    expect(out.players[0]!.linesSent).toBe(1)
    expect(out.garbageRng).not.toBe(m.garbageRng)
  })
  it('result stamps once: kill p1 → p0 wins; both dead same step → draw', () => {
    const m = M()
    const won = step({ ...m, players: [m.players[0]!, killPlayer(m.players[1]!)] }, [[], []])
    expect(won.result).toEqual({ kind: 'win', winner: 0 })
    const draw = step({ ...m, players: [killPlayer(m.players[0]!), killPlayer(m.players[1]!)] }, [[], []])
    expect(draw.result).toEqual({ kind: 'draw' })
    // never overwritten:
    expect(step(won, [[], []]).result).toEqual({ kind: 'win', winner: 0 })
  })
})
