import { describe, expect, it } from 'vitest'
import { IntentTracker } from '../src/input/intent.js'

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('IntentTracker tier 2 (decay)', () => {
  it('key held while repeats arrive, decays after decayMs', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'w', kind: 'press' })
    expect(it2.sample(1).forward).toBe(1)
    clock.advance(150)
    it2.onKey({ key: 'w', kind: 'repeat' }) // OS key-repeat refresh
    clock.advance(150)
    expect(it2.sample(2).forward).toBe(1) // 150 < 200 since refresh
    clock.advance(250)
    expect(it2.sample(3).forward).toBe(0) // decayed
  })
  it('release is ignored in tier 2 (legacy terminals never send it)', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'd', kind: 'press' })
    it2.onKey({ key: 'd', kind: 'release' }) // some terminal quirk: ignore
    expect(it2.sample(1).strafe).toBe(1)
  })
})

describe('IntentTracker tier 1 (kitty)', () => {
  it('release ends the hold immediately, no decay', () => {
    const clock = mkClock()
    const it1 = new IntentTracker(clock.now, 200)
    it1.enableTier1()
    it1.onKey({ key: 'w', kind: 'press' })
    clock.advance(1000)
    expect(it1.sample(1).forward).toBe(1) // still held: no release yet
    it1.onKey({ key: 'w', kind: 'release' })
    expect(it1.sample(2).forward).toBe(0)
  })
})

describe('mapping', () => {
  it('combines axes and fire', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 'a', kind: 'press' })
    t.onKey({ key: 'right', kind: 'press' })
    t.onKey({ key: ' ', kind: 'press' })
    const i = t.sample(9)
    expect(i).toEqual({ seq: 9, forward: 1, strafe: -1, turn: 1, fire: true })
  })
  it('opposing keys cancel', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 's', kind: 'press' })
    expect(t.sample(1).forward).toBe(0)
  })
})
