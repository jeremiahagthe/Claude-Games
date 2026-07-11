import { describe, expect, it } from 'vitest'
import { FUSE_TICKS, FLAME_TICKS } from '../src/constants.js'
import { createMatch } from '../src/grid.js'
import { idx, type BomberState, type Input } from '../src/state.js'
import { step } from '../src/step.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]
const N: (Input | null)[] = [null, null, null, null]
function clearArena(s: BomberState): BomberState {
  return { ...s, grid: s.grid.map(c => (c === 'soft' ? 'empty' : c)), hidden: s.hidden.map(() => null) }
}
function ticks(s: BomberState, n: number) { for (let i = 0; i < n; i++) s = step(s, N); return s }

describe('bombs and explosions', () => {
  it('bomb placed at player tile, capacity enforced, detonates after FUSE_TICKS', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = step(s, [{ dir: null, bomb: true }, null, null, null])
    expect(s.bombs).toHaveLength(1)
    s = step(s, [{ dir: null, bomb: true }, null, null, null])   // cap 1: rejected
    expect(s.bombs).toHaveLength(1)
    s = ticks(s, FUSE_TICKS)
    expect(s.bombs).toHaveLength(0)
    expect(s.flames.length).toBeGreaterThan(0)
    expect(s.players[0].activeBombs).toBe(0)
  })
  it('rays stop at hard walls and destroy exactly one soft block per ray', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s.grid[idx(3, 1)] = 'soft'; s.grid[idx(4, 1)] = 'soft'   // two soft right of a range-2 bomb at (1,1)? range 2 reaches x=3 only
    s = step(s, [{ dir: null, bomb: true }, null, null, null])
    s = ticks(s, FUSE_TICKS)
    expect(s.grid[idx(3, 1)]).toBe('empty')   // first soft destroyed, ray stopped there
    expect(s.grid[idx(4, 1)]).toBe('soft')
  })
  it('chains detonate transitively in the SAME tick', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // hand-place: bomb A about to blow at (1,1), fresh bombs B (3,1) and C (5,1), all range 2
    s = { ...s, bombs: [
      { owner: 1, x: 1, y: 1, fuse: 1, range: 2 },
      { owner: 1, x: 3, y: 1, fuse: 999, range: 2 },
      { owner: 1, x: 5, y: 1, fuse: 999, range: 2 },
    ] }
    s = step(s, N)
    expect(s.bombs).toHaveLength(0)           // A → B → C all gone this tick
  })
  it('flame kills; last-two dying same tick → draw; flames expire', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)) }
    // p0 at (1,1), move p1 onto (3,1); bomb between them kills both at once
    s = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, x: 3, y: 1 } : p)),
                bombs: [{ owner: 0, x: 2, y: 1, fuse: 1, range: 2 }] }
    // (2,1) is a pillar? even-even only → (2,1) is not a pillar (y=1 odd). Valid tile.
    s = step(s, N)
    expect(s.players[0].alive).toBe(false); expect(s.players[1].alive).toBe(false)
    expect(s.result).toEqual({ kind: 'draw' })
    s = ticks(s, FLAME_TICKS)
    expect(s.flames).toHaveLength(0)
  })
  it('sole survivor wins', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)),
                bombs: [{ owner: 0, x: 1, y: 2, fuse: 1, range: 1 }] }
    // p1 far away at (11,1); flame at (1,1) kills only p0? No — p0 must die, p1 survive → p1 wins
    s = step(s, N)
    expect(s.result).toEqual({ kind: 'win', winner: 1 })
  })
})
