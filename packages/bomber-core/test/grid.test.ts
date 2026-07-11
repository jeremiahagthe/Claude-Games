import { describe, expect, it } from 'vitest'
import { GRID_H, GRID_W } from '../src/constants.js'
import { idx } from '../src/state.js'
import { createMatch, SPAWNS, SPIRAL } from '../src/grid.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]

describe('arena layout', () => {
  const s = createMatch(42, NAMES, BOTS)
  it('border is hard wall, pillars at even-even interior coords', () => {
    for (let x = 0; x < GRID_W; x++) { expect(s.grid[idx(x, 0)]).toBe('hard'); expect(s.grid[idx(x, GRID_H - 1)]).toBe('hard') }
    expect(s.grid[idx(2, 2)]).toBe('hard'); expect(s.grid[idx(4, 6)]).toBe('hard')
    expect(s.grid[idx(1, 1)]).not.toBe('hard')
  })
  it('spawn pockets are clear: corner + its two neighbors', () => {
    for (const { x, y } of SPAWNS) {
      expect(s.grid[idx(x, y)]).toBe('empty')
      const dx = x === 1 ? 1 : -1, dy = y === 1 ? 1 : -1
      expect(s.grid[idx(x + dx, y)]).toBe('empty')
      expect(s.grid[idx(x, y + dy)]).toBe('empty')
    }
  })
  it('same seed → identical layout; different seed → different', () => {
    expect(createMatch(42, NAMES, BOTS).grid).toEqual(s.grid)
    expect(createMatch(43, NAMES, BOTS).grid).not.toEqual(s.grid)
  })
  it('power-ups hidden only under soft blocks, counts per POWERUP_COUNTS', () => {
    let n = 0
    s.hidden.forEach((p, i) => { if (p) { n++; expect(s.grid[i]).toBe('soft') } })
    expect(n).toBe(16)
  })
  it('SPIRAL covers every interior tile exactly once, border-inward', () => {
    expect(SPIRAL.length).toBe((GRID_W - 2) * (GRID_H - 2))
    expect(SPIRAL[0]).toEqual({ x: 1, y: 1 })
    const seen = new Set(SPIRAL.map(p => idx(p.x, p.y)))
    expect(seen.size).toBe(SPIRAL.length)
  })
  it('players start at SPAWNS, alive, base stats', () => {
    s.players.forEach((p, i) => {
      expect({ x: p.x, y: p.y }).toEqual(SPAWNS[i])
      expect(p.alive).toBe(true); expect(p.bombCap).toBe(1); expect(p.range).toBe(2); expect(p.speed).toBe(0)
    })
  })
})
