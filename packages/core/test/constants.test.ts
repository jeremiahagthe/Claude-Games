import { describe, expect, it } from 'vitest'
import { MATCH_TICKS, TICK_MS, TICK_RATE } from '../src/constants.js'

describe('constants', () => {
  it('tick math is consistent', () => {
    expect(TICK_MS * TICK_RATE).toBe(1000)
    expect(MATCH_TICKS).toBe(3 * 60 * TICK_RATE)
  })
})
