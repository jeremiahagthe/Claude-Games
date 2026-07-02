import { describe, expect, it } from 'vitest'
import { IntentTracker } from '../src/input/intent.js'

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('IntentTracker tier 2 (decay)', () => {
  it('key held while repeats arrive, decays after adaptive decay window', () => {
    const clock = mkClock()
    // explicit initial decayMs=200: only governs the window before any
    // interval has been learned for this key (see macOS-pattern test below
    // for the adaptive behavior once repeats start flowing).
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'w', kind: 'press' })
    expect(it2.sample(1).forward).toBe(1)
    clock.advance(150)
    it2.onKey({ key: 'w', kind: 'repeat' }) // OS key-repeat refresh: interval learned = 150ms
    clock.advance(150)
    // decayFor now adapts: clamp(150 * 1.6 + 40, 120, 600) = 280ms; 150 < 280
    expect(it2.sample(2).forward).toBe(1)
    clock.advance(250)
    // 150 + 250 = 400ms since the refresh, >= 280ms adaptive window: decayed
    expect(it2.sample(3).forward).toBe(0)
  })
  it('release is ignored in tier 2 (legacy terminals never send it)', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'd', kind: 'press' })
    it2.onKey({ key: 'd', kind: 'release' }) // some terminal quirk: ignore
    expect(it2.sample(1).strafe).toBe(1)
  })
  it('macOS key-repeat pattern: long initial delay then fast repeats keep the key held, and it decays soon after the last repeat', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default initial decay: 450ms
    let cur = 0
    const advanceTo = (target: number) => {
      clock.advance(target - cur)
      cur = target
    }

    tracker.onKey({ key: 'w', kind: 'press' }) // t=0

    advanceTo(100)
    expect(tracker.sample(1).forward).toBe(1)

    advanceTo(250)
    expect(tracker.sample(2).forward).toBe(1)

    advanceTo(399)
    expect(tracker.sample(3).forward).toBe(1)

    advanceTo(400)
    tracker.onKey({ key: 'w', kind: 'repeat' }) // macOS initial repeat delay ~400ms
    expect(tracker.sample(4).forward).toBe(1)

    advanceTo(450)
    expect(tracker.sample(5).forward).toBe(1)

    // fast repeat cadence kicks in: every 35ms
    const repeats = [435, 470, 505, 540, 575]
    for (const rt of repeats) {
      advanceTo(rt)
      tracker.onKey({ key: 'w', kind: 'repeat' })
    }
    const lastRepeat = repeats[repeats.length - 1]!

    advanceTo(600)
    expect(tracker.sample(6).forward).toBe(1)

    // key physically released; no further repeat events arrive.
    // adaptive window shrank once fast repeats started (~35ms interval -> ~120ms floor),
    // so forward must drop to 0 well within 150ms of the last repeat.
    advanceTo(lastRepeat + 150)
    expect(tracker.sample(7).forward).toBe(0)
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
  it('enableTier1 clears tier-2 residue so no key is phantom-held', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 'w', kind: 'release' }) // ignored in tier 2 — entry lingers
    t.enableTier1()
    clock.advance(10_000)
    expect(t.sample(1).forward).toBe(0) // not phantom-held
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
