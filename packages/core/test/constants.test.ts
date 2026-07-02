import { describe, expect, it } from 'vitest'
import {
  BLASTER_COOLDOWN_TICKS,
  BLASTER_DMG,
  MATCH_TICKS,
  MAX_HP,
  MAX_PLAYERS,
  MIN_COMBATANTS,
  RAIL_DMG,
  RAIL_RESPAWN_TICKS,
  SPAWN_PROTECTION_TICKS,
  TICK_MS,
  TICK_RATE,
} from '../src/constants.js'

describe('constants', () => {
  it('tick math is consistent', () => {
    expect(TICK_MS * TICK_RATE).toBe(1000)
    expect(MATCH_TICKS).toBe(3 * 60 * TICK_RATE)
  })

  it('locked game-rule values', () => {
    expect(TICK_RATE).toBe(20)
    expect(MATCH_TICKS).toBe(3600)
    expect(MAX_HP).toBe(100)
    expect(BLASTER_DMG).toBe(25)
    expect(BLASTER_COOLDOWN_TICKS).toBe(10)
    expect(RAIL_DMG).toBe(100)
    expect(RAIL_RESPAWN_TICKS).toBe(600)
    expect(SPAWN_PROTECTION_TICKS).toBe(40)
    expect(MIN_COMBATANTS).toBe(4)
    expect(MAX_PLAYERS).toBe(8)
  })
})
