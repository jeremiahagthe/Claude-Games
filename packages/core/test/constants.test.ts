import { describe, expect, it } from 'vitest'
import {
  BLASTER_COOLDOWN_TICKS,
  BLASTER_DMG,
  KEY_TURN_AXIS,
  MATCH_TICKS,
  MAX_HP,
  MAX_PLAYERS,
  MIN_COMBATANTS,
  RAIL_DMG,
  RAIL_RESPAWN_TICKS,
  SPAWN_PROTECTION_TICKS,
  TICK_MS,
  TICK_RATE,
  TURN_SPEED,
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

  // Feel-11: full turn axis is the 5.2 rad/s mouse-look ceiling; keyboard holds
  // and bots emit KEY_TURN_AXIS so their physical rate stays the pre-feel-11
  // 2.6 rad/s. If either constant moves, this product must be retuned, not
  // silently shifted.
  it('feel-11 turn-rate split', () => {
    expect(TURN_SPEED * TICK_RATE).toBeCloseTo(5.2, 12)
    expect(KEY_TURN_AXIS).toBe(0.5)
    expect(KEY_TURN_AXIS * TURN_SPEED * TICK_RATE).toBeCloseTo(2.6, 12)
  })
})
