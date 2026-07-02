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
    // default decayMs: 'w' is a movement key, so the unlearned window is
    // 600ms (grown from 450ms — see the movement-continuity tests below for
    // why), no repeat ever arrives.
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'w', kind: 'press' })
    const samples: number[] = []
    for (let i = 1; i <= 14; i++) {
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
    // raw envelope hits 0 at age 600ms (the movement window; taper starts at
    // 0.75 * 600 = 450ms). The eased value trails one more tick behind
    // (RELEASE_PER_TICK caps the final ~0.1 step), reaching exactly 0 at
    // sample 13 (t=650ms) rather than sample 9 (the old 450ms window).
    expect(samples[12]).toBe(0)
    expect(samples[samples.length - 1]).toBe(0)
  })

  it('attack easing: 0 -> full within 2 samples of a fresh hold (ATTACK_PER_TICK=0.55)', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'w', kind: 'press' })
    const s1 = tracker.sample(1).forward
    const s2 = tracker.sample(2).forward
    const s3 = tracker.sample(3).forward
    expect(s1).toBeGreaterThan(0)
    expect(s1).toBeLessThan(1) // not an instant snap to full strength
    expect(s2).toBe(1) // full strength reached by the 2nd sample (0.55 + 0.55, clamped)
    expect(s3).toBe(1)
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

    // key released: no further events. decay = 120ms (floor). 'w' is a
    // movement key, so its taper start is 0.75 * decay = 90ms (not the
    // turn-class min(FULL_INTENT_MS, decay/2) = 60ms formula) — the taper
    // runs age 90ms -> 120ms after the last repeat.
    clock.advance(99) // age 99: mid-taper. envelope = 1 - (99-90)/(120-90) = 0.7.
    const s1 = tracker.sample(4).forward
    // |envelope - previous| = 0.3 == the release easing cap exactly, so the
    // sample still exposes the raw envelope value directly — a cliff
    // (envelope pinned at 1 until 120ms) would read 1.0 here.
    expect(s1).toBeCloseTo(0.7, 5)

    clock.advance(15) // age 114: envelope = 1 - 24/30 = 0.2; easing caps the drop
    const s2 = tracker.sample(5).forward
    expect(s2).toBeLessThan(s1)
    expect(s2).toBeGreaterThan(0)

    clock.advance(50) // age 164 >= decay: envelope 0; eased value keeps ramping down
    let prev = s2
    for (let i = 6; i <= 9; i++) {
      const s = tracker.sample(i).forward
      expect(s).toBeLessThanOrEqual(prev)
      prev = s
    }
    expect(prev).toBe(0)
  })

  it('macOS hold pattern (300ms initial repeat, 35ms steady cadence): stays above ~0.4 during the initial-repeat gap and recovers to 1.0 (general hold-smoothness check)', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default initial decay for 'w' (movement): 600ms
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
    // back down smoothly — never an instant cliff — and reaches 0. 'w' is a
    // movement key, so its taper start is 0.75 * decayFor(key) rather than
    // the turn-class min(FULL_INTENT_MS, decay/2); the exact tick range isn't
    // pinned here (see the fast-repeat-regime test above for that), only
    // that the ramp-down is monotonic and eventually settles at rest.
    for (let t = 700; t < 900; t += 50) {
      const cur = byTick(t)
      const next = byTick(t + 50)
      if (cur === 0) expect(next).toBe(0) // fully released: stays at rest
      else expect(next).toBeLessThan(cur)
    }
    expect(byTick(900)).toBe(0)
  })

  it('movement continuity: macOS-default hold pattern (press at t=0, first repeat at 375ms, then 90ms repeats) never sags below 0.9 once at full speed (THE movement-continuity regression test)', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default: 'w' is a movement key -> unlearned window 600ms
    tracker.onKey({ key: 'w', kind: 'press' }) // t=0

    let repeatAt = 375 // macOS initial repeat delay
    let released = false
    let seq = 0
    const samples: number[] = []
    for (let t = 50; t <= 900; t += 50) {
      clock.advance(50)
      while (!released && repeatAt <= t) {
        tracker.onKey({ key: 'w', kind: 'repeat' })
        repeatAt += 90 // macOS steady-state repeat cadence
        if (repeatAt > 700) released = true // key physically released ~t=650-700
      }
      samples.push(tracker.sample(++seq).forward)
    }
    const byTick = (t: number): number => samples[t / 50 - 1]!

    const firstFullSpeedIdx = samples.findIndex((s) => s === 1)
    expect(firstFullSpeedIdx).toBeGreaterThanOrEqual(0) // it does reach full speed
    // from the first full-speed sample through the last repeat (~t=650, after
    // which no more key events arrive), the sampled forward axis never sags —
    // this is the exact regression the movement-class taper start (0.75 *
    // decayFor(key), bridging macOS's initial 375ms repeat gap) fixes. Before
    // this change the taper started at 140ms, well inside the 375ms gap.
    for (let t = (firstFullSpeedIdx + 1) * 50; t <= 650; t += 50) {
      expect(byTick(t)).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('turn tap overshoot: a single right tap (new 350ms turn-class window) fully releases by 350ms, not the old 450ms', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now) // default: 'right' is a turn key -> unlearned window 350ms
    tracker.onKey({ key: 'right', kind: 'press' })
    const samples: number[] = []
    for (let t = 50; t <= 400; t += 50) {
      clock.advance(50)
      samples.push(tracker.sample(t / 50).turn)
    }
    // builds up first (attack easing + the growing turn ramp both push it up),
    // then the envelope's taper — which starts at min(FULL_INTENT_MS, decay/2)
    // = 140ms for turn keys — dominates and brings it back down to 0.
    const peakIdx = samples.indexOf(Math.max(...samples))
    expect(samples[peakIdx]).toBeGreaterThan(0)
    for (let i = peakIdx + 1; i < samples.length; i++) expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]!)
    expect(samples[6]).toBe(0) // t=350ms: the turn-class window, not the old 450ms
    expect(samples[7]).toBe(0)
  })

  it('class separation: turn and movement keys use their own initial decay windows (same event pattern, different fates at 350ms)', () => {
    const clock = mkClock()
    const turnTracker = new IntentTracker(clock.now)
    const moveTracker = new IntentTracker(clock.now)
    turnTracker.onKey({ key: 'right', kind: 'press' })
    moveTracker.onKey({ key: 'w', kind: 'press' })
    let turnAt350 = NaN
    let moveAt350 = NaN
    for (let t = 50; t <= 350; t += 50) {
      clock.advance(50)
      const turnSample = turnTracker.sample(t / 50).turn
      const moveSample = moveTracker.sample(t / 50).forward
      if (t === 350) {
        turnAt350 = turnSample
        moveAt350 = moveSample
      }
    }
    // turn key: unlearned window shrank 450 -> 350ms, so a tap has fully released by t=350ms.
    expect(turnAt350).toBe(0)
    // movement key: unlearned window grew 450 -> 600ms (taper start 0.75*600=450ms),
    // so the same tap is still at full strength at t=350ms.
    expect(moveAt350).toBe(1)
  })

  it('turn ramp: a fresh tap starts near TURN_RAMP_BASE, not full strength', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'right', kind: 'press' })
    const s1 = tracker.sample(1).turn
    expect(s1).toBeCloseTo(0.35, 5) // TURN_RAMP_BASE: envelope is 1 immediately, but the ramp starts at base
    expect(s1).toBeLessThan(1)
  })

  it('turn ramp: a continuous hold (with repeats) reaches full strength by TURN_RAMP_MS (+ one tick tolerance)', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'right', kind: 'press' }) // t=0
    let nextRepeat = 40 // well under any taper window, so the envelope never dims
    let seq = 0
    let last = 0
    for (let t = 50; t <= 550; t += 50) {
      // TURN_RAMP_MS=500 + one 50ms tick
      clock.advance(50)
      while (nextRepeat <= t) {
        tracker.onKey({ key: 'right', kind: 'repeat' })
        nextRepeat += 40
      }
      last = tracker.sample(++seq).turn
    }
    expect(last).toBe(1)
  })

  it('turn ramp: after the hold fully decays, a new tap restarts the ramp from base', () => {
    const clock = mkClock()
    const tracker = new IntentTracker(clock.now)
    tracker.onKey({ key: 'right', kind: 'press' }) // t=0
    clock.advance(400) // > 350ms turn-class window: envelope fully decays, hold (and its ramp start) clears
    expect(tracker.sample(1).turn).toBe(0)
    tracker.onKey({ key: 'right', kind: 'press' }) // fresh press: envelope was 0, so this starts a new continuous hold
    const s2 = tracker.sample(2).turn
    expect(s2).toBeCloseTo(0.35, 5) // TURN_RAMP_BASE again, not continuing from the old hold's progress
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
  it('turn ramp applies even though the hold itself stays exactly binary (real press/release, no envelope taper)', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now)
    t.enableTier1()
    t.onKey({ key: 'right', kind: 'press' }) // t=0
    const s1 = t.sample(1).turn
    expect(s1).toBeCloseTo(0.35, 5) // TURN_RAMP_BASE: held is exactly binary (true), but the axis still ramps
    clock.advance(500) // TURN_RAMP_MS
    expect(t.sample(2).turn).toBe(1) // ramp reached full strength; no easing in tier 1, so this is exact
    t.onKey({ key: 'right', kind: 'release' })
    expect(t.sample(3).turn).toBe(0) // binary: release drops it instantly, no decay tail
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
    // forward/strafe/fire reach full/binary strength once the attack easing
    // catches up; turn is additionally scaled by the turn-speed ramp — no
    // wall-clock time passes in this test, so the tap sits at TURN_RAMP_BASE
    // (0.35). The ramp's growth over time is covered by the dedicated "turn
    // ramp" tests above.
    expect(i).toEqual({ seq: 9, forward: 1, strafe: -1, turn: 0.35, fire: true })
  })
  it('opposing keys cancel', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 's', kind: 'press' })
    expect(t.sample(1).forward).toBe(0)
  })
})
