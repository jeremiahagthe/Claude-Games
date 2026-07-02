import { describe, expect, it } from 'vitest'
import { handleFromSeed, randomHandle } from '../src/names.js'
import { fnv1a, mulberry32 } from '../src/prng.js'

describe('prng', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('fnv1a is stable', () => {
    expect(fnv1a('fragwait')).toBe(fnv1a('fragwait'))
    expect(fnv1a('a')).not.toBe(fnv1a('b'))
  })
})

describe('handles', () => {
  it('stable per seed, kebab-case', () => {
    expect(handleFromSeed('machine-1')).toBe(handleFromSeed('machine-1'))
    expect(handleFromSeed('machine-1')).toMatch(/^[a-z]+-[a-z]+$/)
    expect(handleFromSeed('machine-1')).not.toBe(handleFromSeed('machine-2'))
  })
  it('bot handles look identical in style to human handles', () => {
    expect(randomHandle(mulberry32(7))).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
