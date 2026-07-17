import { describe, expect, it } from 'vitest'
import { TERRAIN_MAX, TERRAIN_MIN } from '../src/constants.js'
import { mulberry32 } from '../src/prng.js'
import { genTerrain } from '../src/terrain.js'

describe('genTerrain', () => {
  const rng0 = (mulberry32(42)() * 2 ** 32) >>> 0
  it('80 columns, all within [TERRAIN_MIN, TERRAIN_MAX]', () => {
    const { heights } = genTerrain(rng0)
    expect(heights).toHaveLength(80)
    for (const h of heights) { expect(h).toBeGreaterThanOrEqual(TERRAIN_MIN); expect(h).toBeLessThanOrEqual(TERRAIN_MAX) }
  })
  it('deterministic per rng state; different states differ; rng is threaded', () => {
    const a = genTerrain(rng0), b = genTerrain(rng0)
    expect(a.heights).toEqual(b.heights)
    expect(a.rng).toBe(b.rng)
    expect(a.rng).not.toBe(rng0)
    const c = genTerrain(a.rng)
    expect(c.heights).not.toEqual(a.heights)
  })
  it('smoothed: no single-column spikes (|h[i] - neighbor mean| bounded)', () => {
    const { heights } = genTerrain(rng0)
    for (let i = 1; i < 79; i++)
      expect(Math.abs(heights[i]! - (heights[i - 1]! + heights[i + 1]!) / 2)).toBeLessThan(6)
  })
})
