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
  it('lingering flame kills a player who walks in ticks after the blast', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // p2/p3 pre-killed; bomb at (3,1) range 1: rays flame (2,1),(4,1),(3,2); up ray hits the y=0 border
    // p0 at (1,1) is OUTSIDE the blast — range-1 left ray from (3,1) stops at (2,1)
    s = { ...s, players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)),
                bombs: [{ owner: 1, x: 3, y: 1, fuse: 1, range: 1 }] }
    s = step(s, N)                             // detonation tick: flames born
    expect(s.players[0].alive).toBe(true)      // p0 untouched by the blast itself
    s = step(s, N)                             // flames linger (FLAME_TICKS=10, plenty left)
    // Boundary choice: a flame is lethal on every tick it exists at the START of the tick
    // (pre-expiry-decrement), i.e. creation tick + FLAME_TICKS-1 carried ticks — consistent
    // with fixture 4 (kills on its creation tick; 0 flames remain after FLAME_TICKS steps).
    s = step(s, [{ dir: 'right', bomb: false }, null, null, null]) // p0 steps onto (2,1)
    expect(s.players[0].alive).toBe(false)     // lingering flame kills late walkers
    expect(s.result).toEqual({ kind: 'win', winner: 1 }) // result stamped on the late-death path
  })
  it('an exposed drop under a lingering flame is destroyed', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, bombs: [{ owner: 1, x: 3, y: 1, fuse: 1, range: 1 }] }
    s = step(s, N)                             // flames born on (2,1),(4,1),(3,2) and center (3,1)
    // hand-expose a drop onto (2,1) while the previous tick's flame still burns there
    // (mirrors a chain revealing a drop into an already-burning tile)
    s = { ...s, drops: [{ x: 2, y: 1, kind: 'range' }] }
    s = step(s, N)
    expect(s.drops).toHaveLength(0)            // lingering flame destroys the exposed drop
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
