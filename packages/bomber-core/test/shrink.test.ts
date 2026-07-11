import { describe, expect, it } from 'vitest'
import { SHRINK_START_TICK } from '../src/constants.js'
import { createMatch, SPIRAL } from '../src/grid.js'
import { idx, type BomberState, type Drop, type Input } from '../src/state.js'
import { step } from '../src/step.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]
const N: (Input | null)[] = [null, null, null, null]
function clearArena(s: BomberState): BomberState {
  return { ...s, grid: s.grid.map((c) => (c === 'soft' ? 'empty' : c)), hidden: s.hidden.map(() => null) }
}

describe('power-up pickup', () => {
  it('alive player entering a drop tile bumps the right stat and the drop is removed', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // p0 sits at (1,1) (its spawn); drop a 'range' power-up right on that tile —
    // no movement needed, pickup fires on p0's CURRENT tile the tick the drop exists.
    s = { ...s, drops: [{ x: 1, y: 1, kind: 'range' }] }
    s = step(s, N)
    expect(s.players[0].range).toBe(3) // base range 2 + 1
    expect(s.drops).toHaveLength(0)
  })
  it('bomb-kind bumps bombCap, speed-kind bumps speed; both unbounded by pickup itself', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, drops: [{ x: 1, y: 1, kind: 'bomb' }, { x: 11, y: 1, kind: 'speed' }] }
    s = step(s, N)
    expect(s.players[0].bombCap).toBe(2) // base 1 + 1
    expect(s.players[1].speed).toBe(1) // base 0 + 1
  })
  it('a dead player does not collect (drop survives untouched)', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, alive: false } : p)),
                drops: [{ x: 1, y: 1, kind: 'range' }] }
    s = step(s, N)
    expect(s.players[0].range).toBe(2) // unchanged — dead players can't pick up
    expect(s.drops).toEqual([{ x: 1, y: 1, kind: 'range' }])
  })
  it('two players co-located on the same drop tile: lowest id wins (chosen determinism rule)', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // Movement never checks player-vs-player collision (isBlocked only looks at grid/bombs),
    // so two players CAN share a tile. Hand-place p0 and p1 both at (5,5) with a single drop
    // there — the earlier-id player (p0) claims it, p1 finds nothing left.
    s = { ...s, players: s.players.map((p, i) => (i <= 1 ? { ...p, x: 5, y: 5 } : p)),
                drops: [{ x: 5, y: 5, kind: 'range' }] }
    s = step(s, N)
    expect(s.players[0].range).toBe(3) // p0 (lower id) claimed it
    expect(s.players[1].range).toBe(2) // p1 got nothing — drop already gone
    expect(s.drops).toHaveLength(0)
  })
})

describe('sudden-death shrink', () => {
  it('SPIRAL[0] closes to hard at exactly tick 1800 and kills a player parked there', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    const tile = SPIRAL[0]!
    // Jump straight to the tick before the first close (fixture, not a full sim) —
    // shrinkIndex -1 means "nothing closed yet"; p0 parked on SPIRAL[0] (its own spawn).
    s = { ...s, tick: SHRINK_START_TICK - 1, shrinkIndex: -1,
                players: s.players.map((p, i) => (i === 0 ? { ...p, x: tile.x, y: tile.y } : p)) }
    s = step(s, N)
    expect(s.tick).toBe(SHRINK_START_TICK)
    expect(s.grid[idx(tile.x, tile.y)]).toBe('hard')
    expect(s.shrinkIndex).toBe(0)
    expect(s.players[0].alive).toBe(false)
  })
  it('a bomb crushed by the closing tile vanishes without detonating (no flames, owner decremented)', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    const tile = SPIRAL[5]!
    s = { ...s, tick: SHRINK_START_TICK - 1 + 5 * 20, shrinkIndex: 4,
                bombs: [{ owner: 1, x: tile.x, y: tile.y, fuse: 999, range: 3 }],
                players: s.players.map((p, i) => (i === 1 ? { ...p, activeBombs: 1 } : p)) }
    s = step(s, N)
    expect(s.shrinkIndex).toBe(5)
    expect(s.bombs).toHaveLength(0) // crushed, not detonated
    expect(s.flames).toHaveLength(0) // no flames from a crush
    expect(s.players[1].activeBombs).toBe(0) // owner's count freed
  })
  it('a drop and a hidden power-up under the closing tile are destroyed too', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    const tile = SPIRAL[7]!
    s.grid[idx(tile.x, tile.y)] = 'soft'
    s.hidden[idx(tile.x, tile.y)] = 'speed'
    const otherDrop: Drop = { x: 2, y: 2, kind: 'bomb' }
    s = { ...s, tick: SHRINK_START_TICK - 1 + 7 * 20, shrinkIndex: 6,
                drops: [{ x: tile.x, y: tile.y, kind: 'range' }, otherDrop] }
    s = step(s, N)
    expect(s.grid[idx(tile.x, tile.y)]).toBe('hard')
    expect(s.hidden[idx(tile.x, tile.y)]).toBeNull()
    expect(s.drops).toEqual([otherDrop])
  })
  it('spiral exhaustion (past the last close) kills everyone left → forced draw', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // Fixture bypasses the 1798 prior closes: shrinkIndex 98 = SPIRAL's last real index
    // already closed; the NEXT shrink tick (closeIndex 99, out of range) is the
    // guaranteed end-of-round mercy kill. Two survivors, off any particular tile —
    // exhaustion kills on tile membership, not position.
    s = { ...s, tick: SHRINK_START_TICK - 1 + 99 * 20, shrinkIndex: 98,
                players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)) }
    s = step(s, N)
    expect(s.tick).toBe(SHRINK_START_TICK + 99 * 20)
    expect(s.tick).toBe(3780)
    expect(s.players[0].alive).toBe(false)
    expect(s.players[1].alive).toBe(false)
    expect(s.result).toEqual({ kind: 'draw' })
  })
  it('full no-input run from tick 0 is guaranteed to end in a draw by tick 3780', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // Co-locate the two survivors on one interior tile far from any corner spawn; the
    // other two are pre-killed so no earlier win/draw can be stamped from ordinary play.
    // Whichever SPIRAL index reaches that shared tile kills both AT ONCE (no dodging —
    // no input is ever given), producing a draw strictly before the 3780 exhaustion floor.
    const tile = SPIRAL[50]!
    s = { ...s, players: s.players.map((p, i) =>
      i >= 2 ? { ...p, alive: false } : { ...p, x: tile.x, y: tile.y }) }
    let steps = 0
    while (s.result === null && steps < 3780) {
      s = step(s, N)
      steps++
    }
    expect(s.result).toEqual({ kind: 'draw' })
    expect(s.tick).toBeLessThanOrEqual(3780)
  })
})
