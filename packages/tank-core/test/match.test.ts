import { describe, expect, it } from 'vitest'
import { DEFAULT_ANGLE, DEFAULT_POWER, HP_MAX, SPAWN_FLAT_HALF, SPAWN_L, SPAWN_R, WIND_MAX } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { stateHash, tankY } from '../src/state.js'

const NAMES: [string, string] = ['a', 'b'], BOTS: [boolean, boolean] = [false, true]

describe('createMatch', () => {
  const m = createMatch(42, NAMES, BOTS)
  it('two tanks, full hp, seeded cols in the spawn bands, flattened footing', () => {
    expect(m.tanks[0]!.col).toBeGreaterThanOrEqual(SPAWN_L[0]); expect(m.tanks[0]!.col).toBeLessThanOrEqual(SPAWN_L[1])
    expect(m.tanks[1]!.col).toBeGreaterThanOrEqual(SPAWN_R[0]); expect(m.tanks[1]!.col).toBeLessThanOrEqual(SPAWN_R[1])
    m.tanks.forEach((t, i) => {
      expect(t).toMatchObject({ id: i, name: NAMES[i], bot: BOTS[i], alive: true, hp: HP_MAX, shotsFired: 0, damageDealt: 0, lastPower: DEFAULT_POWER })
      for (let d = -SPAWN_FLAT_HALF; d <= SPAWN_FLAT_HALF; d++)
        expect(m.heights[t.col + d]).toBe(m.heights[t.col])
    })
    expect(m.tanks[0]!.lastAngle).toBe(DEFAULT_ANGLE)
    expect(m.tanks[1]!.lastAngle).toBe(180 - DEFAULT_ANGLE)
  })
  it('round 1, turn = firstTurn, wind in range, no result', () => {
    expect(m.round).toBe(1)
    expect(m.turn).toBe(m.firstTurn)
    expect(Math.abs(m.wind)).toBeLessThanOrEqual(WIND_MAX)
    expect(Number.isInteger(m.wind)).toBe(true)
    expect(m.result).toBeNull()
  })
  it('deterministic per seed; different seeds differ; stateHash stable', () => {
    expect(createMatch(42, NAMES, BOTS)).toEqual(m)
    expect(stateHash(createMatch(42, NAMES, BOTS))).toBe(stateHash(m))
    expect(stateHash(createMatch(43, NAMES, BOTS))).not.toBe(stateHash(m))
  })
  it('tankY reads the surface under the tank', () => {
    expect(tankY(m, 0)).toBe(m.heights[m.tanks[0]!.col])
  })
})
