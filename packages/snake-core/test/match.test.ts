import { describe, expect, it } from 'vitest'
import { FOOD_COUNT, GRID_H, GRID_W, SPEED_SCHEDULE, START_LENGTH } from '../src/constants.js'
import { idx, isWall, stepTicksAt } from '../src/state.js'
import { createMatch, SPAWNS } from '../src/match.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]

describe('spawns', () => {
  it('are the pinned rotationally-symmetric corner layouts, head first', () => {
    expect(SPAWNS[0]).toEqual({ dir: 'right', cells: [{x:7,y:4},{x:6,y:4},{x:5,y:4},{x:4,y:4}] })
    expect(SPAWNS[1]).toEqual({ dir: 'down',  cells: [{x:51,y:7},{x:51,y:6},{x:51,y:5},{x:51,y:4}] })
    expect(SPAWNS[2]).toEqual({ dir: 'left',  cells: [{x:48,y:35},{x:49,y:35},{x:50,y:35},{x:51,y:35}] })
    expect(SPAWNS[3]).toEqual({ dir: 'up',    cells: [{x:4,y:32},{x:4,y:33},{x:4,y:34},{x:4,y:35}] })
    for (const s of SPAWNS) expect(s.cells).toHaveLength(START_LENGTH)
  })
})

describe('createMatch', () => {
  const s = createMatch(42, NAMES, BOTS)
  it('4 snakes at spawns, alive, growth 0, pendingDir null', () => {
    expect(s.snakes).toHaveLength(4)
    s.snakes.forEach((sn, i) => {
      expect(sn.cells).toEqual(SPAWNS[i]!.cells)
      expect(sn.dir).toBe(SPAWNS[i]!.dir)
      expect(sn).toMatchObject({ id: i, name: NAMES[i], bot: BOTS[i], alive: true, growth: 0, pendingDir: null })
    })
  })
  it('FOOD_COUNT food on empty non-snake cells, deterministic per seed', () => {
    expect(s.food).toHaveLength(FOOD_COUNT)
    const occupied = new Set(s.snakes.flatMap((sn) => sn.cells.map((c) => idx(c.x, c.y))))
    for (const f of s.food) {
      expect(f.x).toBeGreaterThanOrEqual(0); expect(f.x).toBeLessThan(GRID_W)
      expect(f.y).toBeGreaterThanOrEqual(0); expect(f.y).toBeLessThan(GRID_H)
      expect(occupied.has(idx(f.x, f.y))).toBe(false)
    }
    expect(new Set(s.food.map((f) => idx(f.x, f.y))).size).toBe(FOOD_COUNT) // no stacking
    expect(createMatch(42, NAMES, BOTS)).toEqual(s)                          // deterministic
    expect(createMatch(43, NAMES, BOTS).food).not.toEqual(s.food)            // seed matters
  })
  it('tick 0, rings 0, no result, cooldown = stepTicksAt(0)', () => {
    expect(s).toMatchObject({ tick: 0, rings: 0, result: null, stepCooldown: stepTicksAt(0) })
  })
})

describe('helpers', () => {
  it('stepTicksAt follows SPEED_SCHEDULE', () => {
    expect(stepTicksAt(0)).toBe(4); expect(stepTicksAt(599)).toBe(4)
    expect(stepTicksAt(600)).toBe(3); expect(stepTicksAt(1200)).toBe(2); expect(stepTicksAt(9999)).toBe(2)
    expect(SPEED_SCHEDULE[0]![0]).toBe(0)
  })
  it('isWall: OOB always; interior cells close as rings advance', () => {
    expect(isWall(-1, 5, 0)).toBe(true); expect(isWall(0, 0, 0)).toBe(false)
    expect(isWall(0, 0, 1)).toBe(true); expect(isWall(1, 1, 1)).toBe(false)
    expect(isWall(55, 39, 1)).toBe(true); expect(isWall(54, 38, 1)).toBe(false)
  })
})
