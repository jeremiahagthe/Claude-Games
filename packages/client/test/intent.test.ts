import { describe, expect, it } from 'vitest'
import { IntentTracker } from '../src/input/intent.js'

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('IntentTracker tier 2 (decay + tap envelope + easing)', () => {
  it('key held while repeats arrive keeps building, decays after the adaptive decay window', () => {
    const clock = mkClock()
    // explicit initial decayMs=200: only governs the window before any
    // interval has been learned for this key (see macOS-pattern test below
    // for the adaptive behavior once repeats start flowing).
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'w', kind: 'press' })
    const s0 = it2.sample(1).forward
    expect(s0).toBeGreaterThan(0) // building up (attack), not an instant full-strength snap
    clock.advance(150)
    it2.onKey({ key: 'w', kind: 'repeat' }) // OS key-repeat refresh: interval learned = 150ms
    clock.advance(150)
    // decayFor now adapts: clamp(150 * 1.6 + 40, 120, 600) = 280ms; 150 < 280,
    // so the key is still "held" and intent keeps climbing.
    const s1 = it2.sample(2).forward
    expect(s1).toBeGreaterThan(s0)
    clock.advance(250)
    // 150 + 250 = 400ms since the refresh, >= 280ms adaptive window: decayed —
    // the envelope drops to 0 and the eased value follows it back down.
    const s2 = it2.sample(3).forward
    expect(s2).toBeLessThan(s1)
    // keeps releasing toward 0 on subsequent samples (no key events arrive)
    let last = s2
    for (let i = 4; i <= 8; i++) {
      const s = it2.sample(i).forward
      expect(s).toBeLessThanOrEqual(last)
      last = s
    }
    expect(last).toBe(0)
  })

  it('release is ignored in tier 2 (legacy terminals never send it)', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'd', kind: 'press' })
    it2.onKey({ key: 'd', kind: 'release' }) // some terminal quirk: ignore
    expect(it2.sample(1).strafe).toBeGreaterThan(0) // envelope still active — release didn't zero it
  })

  it('tap (press, no repeat): sampled axis ramps down and reaches 0 by the decay window — never an instant 1→0 cliff', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default decayMs=450, no repeat ever arrives
    tracker.onKey({ key: 'w', kind: 'press' })
    const samples: number[] = []
    for (let i = 1; i <= 12; i++) {
      clock.advance(50) // 20Hz sim tick
      samples.push(tracker.sample(i).forward)
    }
    const peakIdx = samples.indexOf(Math.max(...samples))
    expect(samples[peakIdx]).toBeGreaterThan(0.9) // does reach (close to) full strength
    // after the peak it only ever falls, and never straight to 0 in one step
    // (a hard 1 -> 0 cliff would show up as a drop of ~1.0 in a single sample)
    for (let i = peakIdx + 1; i < samples.length; i++) {
      const drop = samples[i - 1]! - samples[i]!
      expect(drop).toBeGreaterThanOrEqual(0)
      expect(drop).toBeLessThan(0.5) // release is capped per-tick, not instant
    }
    expect(samples[8]).toBe(0) // fully decayed by t = 9 * 50ms = 450ms (the decay window)
    expect(samples[samples.length - 1]).toBe(0)
  })

  it('attack easing: 0 -> full within 3 samples of a fresh hold', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'w', kind: 'press' })
    const s1 = tracker.sample(1).forward
    const s2 = tracker.sample(2).forward
    const s3 = tracker.sample(3).forward
    expect(s1).toBeGreaterThan(0)
    expect(s1).toBeLessThan(1) // not an instant snap to full strength
    expect(s2).toBeGreaterThan(s1)
    expect(s3).toBe(1) // full strength reached by the 3rd sample
  })

  it('fast-repeat regime: after a learned ~35ms cadence stops, the envelope itself tapers through intermediate values — no 1→0 cliff before easing', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'w', kind: 'press' }) // t=0
    // learn a fast cadence: decayFor clamps to its 120ms floor (35*1.6+40 = 96 -> 120),
    // which is BELOW FULL_INTENT_MS — the regime where the taper must still be reachable.
    for (let i = 0; i < 6; i++) {
      clock.advance(35)
      tracker.onKey({ key: 'w', kind: 'repeat' })
    }
    // while repeats keep arriving, the envelope never dims (age < taper start at every sample)
    tracker.sample(1)
    tracker.sample(2)
    expect(tracker.sample(3).forward).toBe(1)

    // key released: no further events. decay = 120ms, so the taper runs 60ms -> 120ms.
    clock.advance(70) // age 70: mid-taper. envelope = 1 - (70-60)/(120-60) = 5/6.
    const s1 = tracker.sample(4).forward
    // |envelope - previous| = 1/6 < the release easing cap, so the sample exposes the
    // raw envelope value directly — a cliff (envelope pinned at 1 until 120ms) would read 1.0.
    expect(s1).toBeCloseTo(5 / 6, 5)

    clock.advance(30) // age 100: envelope = 1 - 40/60 = 1/3; easing caps the drop
    const s2 = tracker.sample(5).forward
    expect(s2).toBeLessThan(s1)
    expect(s2).toBeGreaterThan(0)

    clock.advance(50) // age 150 >= decay: envelope 0; eased value keeps ramping down
    let prev = s2
    for (let i = 6; i <= 9; i++) {
      const s = tracker.sample(i).forward
      expect(s).toBeLessThanOrEqual(prev)
      prev = s
    }
    expect(prev).toBe(0)
  })

  it('macOS hold pattern: sampled once per 20Hz tick, stays above ~0.4 during the initial-repeat gap and recovers to 1.0 (THE smoothness regression test)', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default initial decay: 450ms
    tracker.onKey({ key: 'w', kind: 'press' }) // t=0

    let repeatAt = 300 // macOS initial repeat delay
    let released = false
    let seq = 0
    const samples: number[] = []
    for (let t = 50; t <= 900; t += 50) {
      clock.advance(50)
      while (!released && repeatAt <= t) {
        tracker.onKey({ key: 'w', kind: 'repeat' })
        repeatAt += 35 // steady-state fast repeat cadence
        if (repeatAt > 600) released = true // key physically released ~t=600
      }
      samples.push(tracker.sample(++seq).forward)
    }
    const byTick = (t: number): number => samples[t / 50 - 1]!

    // during the initial-repeat gap (before the first repeat lands at t=300),
    // intent never craters — this is the exact regression the tap envelope fixes.
    for (let t = 50; t < 300; t += 50) expect(byTick(t)).toBeGreaterThanOrEqual(0.4)

    // once steady repeats arrive, it reaches and holds full strength
    expect(byTick(450)).toBe(1)
    expect(byTick(600)).toBe(1)

    // after the last repeat (key released ~t=600, no more events), it ramps
    // back down smoothly — never an instant cliff — and reaches 0. The taper
    // starts at min(FULL_INTENT_MS, decay/2) = 60ms past the last repeat here
    // (learned decay = 120ms floor), so the ramp-down runs t=700..850 and the
    // trailing samples hold at 0.
    for (let t = 700; t < 900; t += 50) {
      const cur = byTick(t)
      const next = byTick(t + 50)
      if (cur === 0) expect(next).toBe(0) // fully released: stays at rest
      else expect(next).toBeLessThan(cur)
    }
    expect(byTick(900)).toBe(0)
  })
})

describe('IntentTracker tier 1 (kitty) — unaffected by the tier-2 envelope/easing', () => {
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
  it('stays exactly binary under a rapid repeat pattern (no tapering, unlike tier 2)', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.enableTier1()
    t.onKey({ key: 'w', kind: 'press' })
    expect(t.sample(0).forward).toBe(1)
    for (let i = 1; i <= 5; i++) {
      clock.advance(35)
      t.onKey({ key: 'w', kind: 'repeat' })
      expect(t.sample(i).forward).toBe(1) // always exactly 1, never a fractional value
    }
    t.onKey({ key: 'w', kind: 'release' })
    expect(t.sample(99).forward).toBe(0) // instant release, no decay tail
  })
})

describe('mapping', () => {
  it('combines axes and fire (after the attack ramp reaches full strength)', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 'a', kind: 'press' })
    t.onKey({ key: 'right', kind: 'press' })
    t.onKey({ key: ' ', kind: 'press' })
    t.sample(7) // easing is per-tick, not wall-clock: warm up two ticks first
    t.sample(8)
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
