import { describe, expect, it } from 'vitest'
import type { PlayerInput } from 'fragwait-core'
import { IntentTracker } from '../src/input/intent.js'
import { RENDER_HALF_FOV } from '../src/raycast.js'
import type { KeyEvent } from '../src/input/parser.js'

// Factory macOS timings (F1): first repeat 500ms after press, then every 83ms.
const FACTORY = { initialDelayMs: 500, repeatIntervalMs: 83 }

// Axis value emitted when one full tap quantum (0.06 rad) drains in a single
// 20Hz tick (tick turn capacity = 2.6/20 = 0.13 rad at axis 1).
const TAP_DRAIN = 0.06 / 0.13

function mkClock(start = 0): { now: () => number; set: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    set: (ms) => {
      if (ms < t) throw new Error(`clock moved backwards: ${t} -> ${ms}`)
      t = ms
    },
  }
}

function mkTracker(clock: { now: () => number }, timings = FACTORY): IntentTracker {
  return new IntentTracker(clock.now, { timings })
}

type Sched = { t: number; key: string; kind?: KeyEvent['kind'] }

// Tier-2 terminals (Apple Terminal) only ever deliver kind 'press' — the OS's
// auto-repeats arrive as indistinguishable presses. Schedules default to that.
function repeats(key: string, from: number, to: number, every: number): Sched[] {
  const out: Sched[] = []
  for (let t = from; t <= to; t += every) out.push({ t, key })
  return out
}

// Drives a 20Hz sampling loop (ticks at 50, 100, ... untilMs), delivering the
// scheduled key events at their exact timestamps (clock stays monotonic; an
// event on a tick boundary lands just before that tick's sample).
function run(
  tracker: IntentTracker,
  clock: { now: () => number; set: (ms: number) => void },
  events: Sched[],
  untilMs: number,
): Map<number, PlayerInput> {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const out = new Map<number, PlayerInput>()
  let seq = 0
  let ei = 0
  for (let t = 50; t <= untilMs; t += 50) {
    while (ei < sorted.length && sorted[ei]!.t <= t) {
      const e = sorted[ei++]!
      clock.set(Math.max(e.t, clock.now()))
      tracker.onKey({ key: e.key, kind: e.kind ?? 'press' })
    }
    clock.set(t)
    out.set(t, tracker.sample(++seq))
  }
  return out
}

function at(samples: Map<number, PlayerInput>, t: number): PlayerInput {
  const s = samples.get(t)
  if (!s) throw new Error(`no sample at t=${t}`)
  return s
}

describe('latched walking (tier 2) — the continuous-walking fix', () => {
  it('THE regression: one W tap with NO further events keeps forward latched at 1 indefinitely', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // A single press, then total silence — no OS repeats at all. The old
    // hold-inference envelopes decayed here; the latch does not.
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }], 5000)
    for (let t = 100; t <= 5000; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(1)
  })

  it('OS repeats of the active key are harmless no-ops (forward stays 1, never toggles)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }, ...repeats('w', 500, 3000, 83)], 3200)
    for (let t = 100; t <= 3200; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(1)
  })

  it('a latch flip ramps through easing — no instant 0→1 cliff in the smoothed output', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    expect(tracker.sample(1).forward).toBe(0.55) // one attack step, not a jump to 1
    expect(tracker.sample(2).forward).toBe(1)
  })

  it('release events are ignored in tier 2 (legacy terminals never send them — the latch must persist)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'd', kind: 'press' })
    tracker.onKey({ key: 'd', kind: 'release' }) // terminal quirk: must not clear the latch
    clock.set(50)
    expect(tracker.sample(1).strafe).toBeGreaterThan(0)
  })
})

describe('S2 regression — turn taps are exact quanta, holds are full-rate, never merged', () => {
  it('S2: five isolated right taps 400ms apart emit exactly 5 × 0.06 rad total, each at tap-drain rate, never hold-rate', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [0, 400, 800, 1200, 1600].map((t) => ({ t, key: 'right' }))
    const samples = run(tracker, clock, events, 2000)
    let total = 0
    for (const s of samples.values()) {
      total += s.turn * 0.13
      // no tick exceeds tap-drain: taps never merge into a sweep or enter hold mode
      expect(Math.abs(s.turn)).toBeLessThanOrEqual(TAP_DRAIN + 1e-12)
    }
    expect(total).toBeCloseTo(5 * 0.06, 12)
  })

  it('S2: press+hold reaches |turn| = 1 within one tick of the first repeat and stays 1 until hold death after the last repeat', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [{ t: 0, key: 'right' }, ...repeats('right', 500, 1247, 83)]
    const samples = run(tracker, clock, events, 1600)
    // the press quantum drains on the first tick
    expect(at(samples, 50).turn).toBeCloseTo(TAP_DRAIN, 12)
    // documented trade: one clean pause between the tap quantum and the OS's first repeat
    for (let t = 100; t <= 450; t += 50) expect(at(samples, t).turn, `turn at t=${t}`).toBe(0)
    // hold mode from the first repeat: instant full strength, no ramp, no easing
    for (let t = 500; t <= 1400; t += 50) expect(at(samples, t).turn, `turn at t=${t}`).toBe(1)
    // hold dies max(2×83, 180) = 180ms after the last repeat (1247): exact 0, no easing tail
    for (let t = 1450; t <= 1600; t += 50) expect(at(samples, t).turn, `turn at t=${t}`).toBe(0)
  })
})

describe('latched diagonal (tier 2) — replaces the F2 keep-alive machinery', () => {
  it('W then D latches a diagonal: both axes reach 1 and hold indefinitely with no further events', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // Two taps, then silence. The old model needed cross-key keep-alive to keep
    // a chord alive under F2 repeat starvation; the latch needs no events at all.
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }, { t: 200, key: 'd' }], 4000)
    for (let t = 400; t <= 4000; t += 50) {
      expect(at(samples, t).forward, `forward at t=${t}`).toBe(1)
      expect(at(samples, t).strafe, `strafe at t=${t}`).toBe(1)
    }
  })

  it('one axis of a diagonal can be stopped independently while the other keeps walking', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }, { t: 200, key: 'd' }, { t: 2000, key: 'a' }], 3000)
    for (let t = 2400; t <= 3000; t += 50) {
      expect(at(samples, t).forward, `forward at t=${t}`).toBe(1) // still walking forward
      expect(at(samples, t).strafe, `strafe at t=${t}`).toBe(0) // strafe stopped by the opposing tap
    }
  })
})

describe('turn precision — tap quanta are exact, conserved, capped', () => {
  it('a single tap emits exactly 0.06 rad total, all in one tick', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'right' }], 500)
    expect(at(samples, 50).turn).toBeCloseTo(TAP_DRAIN, 12)
    for (let t = 100; t <= 500; t += 50) expect(at(samples, t).turn).toBe(0)
    const total = [...samples.values()].reduce((acc, s) => acc + s.turn * 0.13, 0)
    expect(total).toBeCloseTo(0.06, 12)
  })

  it('an opposite tap before any drain zeroes the other direction: net rightward rotation is 0 (< one quantum)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'right', kind: 'press' })
    clock.set(10)
    tracker.onKey({ key: 'left', kind: 'press' }) // zeroes right's pending, enqueues left's quantum
    clock.set(50)
    expect(tracker.sample(1).turn).toBeCloseTo(-TAP_DRAIN, 12)
    clock.set(100)
    expect(tracker.sample(2).turn).toBe(0) // no rightward residue ever drains
  })

  it('an opposite tap mid-drain zeroes the remaining pending (the undrained remainder is dropped, not emitted)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // three re-taps 130ms apart (past the steady-repeat gap, inside entry liveness): 0.18 rad pending
    for (const t of [0, 130, 260]) {
      clock.set(t)
      tracker.onKey({ key: 'right', kind: 'press' })
    }
    clock.set(300)
    expect(tracker.sample(1).turn).toBe(1) // full tick drains 0.13, leaving 0.05 pending
    clock.set(320)
    tracker.onKey({ key: 'left', kind: 'press' }) // zeroes the 0.05 remainder, enqueues -0.06
    clock.set(350)
    expect(tracker.sample(2).turn).toBeCloseTo(-TAP_DRAIN, 12)
    clock.set(400)
    expect(tracker.sample(3).turn).toBe(0) // rightward total stayed 0.13 of the enqueued 0.18
  })

  it('the pending budget caps at ±0.24 rad: excess taps are dropped, total emitted rotation is the cap', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // five re-taps 130ms apart with no sampling between: 5 × 0.06 = 0.30 wants in, cap keeps 0.24
    for (const t of [0, 130, 260, 390, 520]) {
      clock.set(t)
      tracker.onKey({ key: 'right', kind: 'press' })
    }
    let total = 0
    for (let t = 550; t <= 800; t += 50) {
      clock.set(t)
      total += tracker.sample(t / 50).turn * 0.13
    }
    expect(total).toBeCloseTo(0.24, 12)
  })
})

describe('turn hold classification — the first-repeat band separates OS repeats from human re-taps', () => {
  it('an event 500ms after a press (inside [0.9, 1.25]×initialDelay) confirms hold mode', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'right' }, { t: 500, key: 'right' }], 600)
    expect(at(samples, 500).turn).toBe(1)
  })

  it('a human re-tap 400ms after a press (below the band) stays a tap: two quanta, never hold mode', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'right' }, { t: 400, key: 'right' }], 900)
    expect(at(samples, 50).turn).toBeCloseTo(TAP_DRAIN, 12)
    expect(at(samples, 400).turn).toBeCloseTo(TAP_DRAIN, 12)
    for (const s of samples.values()) expect(Math.abs(s.turn)).toBeLessThan(1) // no hold mode ever
  })

  it('a re-tap ~initialDelay after a DEAD hold\'s last repeat stays a tap (the band only applies to the gap after a press)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'right' },
      ...repeats('right', 500, 666, 83), // hold mode; dies 180ms after 666
      { t: 1166, key: 'right' }, // 500ms after the last repeat — a human re-tap, NOT a first repeat
    ]
    const samples = run(tracker, clock, events, 1400)
    expect(at(samples, 850).turn).toBe(0) // hold died
    expect(at(samples, 1200).turn).toBeCloseTo(TAP_DRAIN, 12) // one quantum, not a phantom ±1 spin
    expect(at(samples, 1250).turn).toBe(0)
  })

  it('slow-cadence sanity ({500, 180}): hold mode survives 180ms repeats via the 2×interval grace', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock, { initialDelayMs: 500, repeatIntervalMs: 180 })
    const events: Sched[] = [{ t: 0, key: 'right' }, { t: 500, key: 'right' }, { t: 680, key: 'right' }, { t: 860, key: 'right' }, { t: 1040, key: 'right' }]
    const samples = run(tracker, clock, events, 1500)
    for (let t = 500; t <= 1350; t += 50) expect(at(samples, t).turn, `turn at t=${t}`).toBe(1)
    expect(at(samples, 1400).turn).toBe(0) // death exactly 2×180ms after the last repeat
  })

  it('turn holds are never kept alive by other keys\' events (w owning the repeat slot kills a right-hold)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'right' },
      ...repeats('right', 500, 666, 83), // hold mode
      { t: 720, key: 'w' }, // w steals the repeat slot: right gets nothing more
      ...repeats('w', 1220, 1400, 83),
    ]
    const samples = run(tracker, clock, events, 1400)
    expect(at(samples, 800).turn).toBe(1) // 134ms after right's last event: still alive
    expect(at(samples, 850).turn).toBe(0) // ≥180ms: dead, despite w's events flowing
    expect(at(samples, 850).forward).toBeGreaterThan(0) // w itself is alive
  })

  it('an opposite-direction event kills a live hold instantly', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'right' },
      ...repeats('right', 500, 666, 83), // right hold
      { t: 700, key: 'left' },
    ]
    const samples = run(tracker, clock, events, 800)
    expect(at(samples, 650).turn).toBe(1)
    expect(at(samples, 700).turn).toBeCloseTo(-TAP_DRAIN, 12) // hold dead, left's quantum drains
    expect(at(samples, 750).turn).toBe(0)
  })
})

describe('movement latch — stop-first and reverse (tier 2)', () => {
  it('an opposing tap STOPS (axis → 0), it does not reverse; forward never goes negative', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }, { t: 1000, key: 's' }], 2000)
    expect(at(samples, 950).forward).toBe(1) // still walking just before the tap
    for (let t = 1200; t <= 2000; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(0) // stopped
    for (const [t, s] of samples) expect(s.forward, `forward at t=${t}`).toBeGreaterThanOrEqual(0) // never a reverse
  })

  it('a SECOND opposing event reverses (0 → −1): tap = stop, the next opposing tap = reverse', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }, { t: 1000, key: 's' }, { t: 1500, key: 's' }], 2500)
    for (let t = 1200; t <= 1450; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(0) // stopped by first s
    for (let t = 1700; t <= 2500; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(-1) // reversed by second s
  })

  it('a held opposing key reverses on its OS repeat (tap = stop, hold = reverse — the same rule, timing-free)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // s pressed at 1000 (stop), then the OS's first repeat at 1500 and steady
    // repeats — indistinguishable presses that flip 0 → −1 and then no-op.
    const events: Sched[] = [{ t: 0, key: 'w' }, { t: 1000, key: 's' }, ...repeats('s', 1500, 2500, 83)]
    const samples = run(tracker, clock, events, 2700)
    expect(at(samples, 1400).forward).toBe(0) // stop holds until the first repeat
    for (let t = 1700; t <= 2700; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(-1) // then full reverse
  })

  it('resetTransient clears both latches (a respawn must not keep walking into the new facing)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    tracker.onKey({ key: 'd', kind: 'press' })
    tracker.sample(1)
    tracker.sample(2) // eased to full on both axes
    tracker.resetTransient()
    const s = tracker.sample(3)
    expect(s.forward).toBe(0) // snapped, not eased
    expect(s.strafe).toBe(0)
    clock.set(5000)
    expect(tracker.sample(4).forward).toBe(0) // stays 0 with no new events (latch cleared, not just smoothed)
  })

  it('tier 1: the latch is inert — a press+release returns to 0 (no sticky walk)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'w', kind: 'press' })
    expect(tracker.sample(1).forward).toBe(1)
    tracker.onKey({ key: 'w', kind: 'release' })
    expect(tracker.sample(2).forward).toBe(0) // real release stops instantly; the latch never engaged
  })
})

describe('fire — per-event latch (no hold inference)', () => {
  it('a single space press fires for 250ms, then stops', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: ' ' }], 400)
    for (const t of [50, 100, 150, 200]) expect(at(samples, t).fire, `fire at t=${t}`).toBe(true)
    for (const t of [250, 300, 350, 400]) expect(at(samples, t).fire, `fire at t=${t}`).toBe(false)
  })

  it('space repeats sustain the latch; when another key steals the repeat slot, fire stops ≤ 250ms later', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: ' ' },
      ...repeats(' ', 83, 498, 83),
      { t: 510, key: 'w' }, // F2: space starves from here
      ...repeats('w', 1010, 1200, 83),
    ]
    const samples = run(tracker, clock, events, 1200)
    expect(at(samples, 500).fire).toBe(true)
    expect(at(samples, 700).fire).toBe(true) // latch from the last space event (498) runs to 748
    for (let t = 750; t <= 1200; t += 50) expect(at(samples, t).fire, `fire at t=${t}`).toBe(false)
  })
})

describe('resetTransient — respawn/tier-switch hygiene', () => {
  it('clears pending turn budget, hold modes, movement holds, fire latch, and smoothed axes', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'right' },
      ...repeats('right', 500, 583, 83), // right in hold mode
      { t: 20, key: 'w' },
      ...repeats('w', 520, 603, 83),
      { t: 30, key: ' ' },
      { t: 600, key: ' ' },
      { t: 550, key: 'left' }, // opposite tap: right's next repeat (583) zeroes it and re-sustains the hold
    ]
    const samples = run(tracker, clock, events, 650)
    expect(at(samples, 650).forward).toBe(1)
    expect(at(samples, 650).fire).toBe(true)
    clock.set(700)
    tracker.onKey({ key: 'right', kind: 'press' }) // sustains hold; also ensures pending path is exercised below
    tracker.resetTransient()
    const s = tracker.sample(99)
    expect(s.forward).toBe(0) // smoothed snapped, not eased down
    expect(s.strafe).toBe(0)
    expect(s.turn).toBe(0) // hold mode + pending budget gone
    expect(s.fire).toBe(false) // latch gone
    clock.set(2000)
    expect(tracker.sample(100).turn).toBe(0) // nothing drains later either
  })

  it('a tap enqueued just before death never drains after the reset', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'right', kind: 'press' })
    tracker.resetTransient() // die before the sim tick sampled the quantum
    clock.set(50)
    expect(tracker.sample(1).turn).toBe(0)
  })
})

describe('releaseMouseButtons — focus-loss safety valve (button releases can never arrive)', () => {
  it('drops a held right-button walk to the latch/binary forward source', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('right', 'press')
    tracker.sample(1)
    expect(tracker.sample(2).forward).toBe(1) // walkHeld forces forward on (eased to full)
    tracker.releaseMouseButtons()
    // walkHeld cleared, so the ease target drops to the latch (0, untouched by
    // keyboard) — the smoothed value heads toward 0 rather than staying pinned at 1.
    expect(tracker.sample(3).forward).toBeLessThan(1)
    for (let i = 4; i < 20 && tracker.sample(i).forward > 0; i++) { /* drain the ease tail */ }
    expect(tracker.sample(20).forward).toBe(0)
  })

  it('drops a held left-button fire to false', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('left', 'press')
    expect(tracker.sample(1).fire).toBe(true) // mouseFireHeld forces fire on
    tracker.releaseMouseButtons()
    expect(tracker.sample(2).fire).toBe(false)
  })

  it('does not touch the movement latch or keyboard state', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    tracker.sample(1)
    tracker.sample(2) // eased to full
    tracker.onMouseButton('right', 'press')
    tracker.releaseMouseButtons()
    // 'w' is still physically held, so forward should remain driven by it.
    expect(tracker.sample(3).forward).toBeGreaterThan(0)
  })
})

describe('tier 1 (kitty) — real press/repeat/release', () => {
  it('movement is exactly binary: held = 1 regardless of repeats, release = instant 0', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'w', kind: 'press' })
    expect(tracker.sample(1).forward).toBe(1)
    for (let i = 0; i < 5; i++) {
      clock.set(clock.now() + 35)
      tracker.onKey({ key: 'w', kind: 'repeat' })
      expect(tracker.sample(2 + i).forward).toBe(1)
    }
    clock.set(clock.now() + 1000)
    expect(tracker.sample(10).forward).toBe(1) // no decay while held
    tracker.onKey({ key: 'w', kind: 'release' })
    expect(tracker.sample(11).forward).toBe(0) // instant, no easing tail
  })

  it('opposing held movement keys cancel', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'w', kind: 'press' })
    tracker.onKey({ key: 's', kind: 'press' })
    expect(tracker.sample(1).forward).toBe(0)
  })

  it('turn: tap = one quantum; held ≥ 150ms = hold mode ±1; release = instant 0', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'right', kind: 'press' })
    expect(tracker.sample(1).turn).toBeCloseTo(TAP_DRAIN, 12) // the press quantum
    expect(tracker.sample(2).turn).toBe(0) // drained; not yet held long enough for hold mode
    clock.set(150)
    expect(tracker.sample(3).turn).toBe(1) // hold mode: full rate, no ramp
    clock.set(1000)
    expect(tracker.sample(4).turn).toBe(1)
    tracker.onKey({ key: 'right', kind: 'release' })
    expect(tracker.sample(5).turn).toBe(0)
  })

  it('turn: release clears that direction\'s pending budget (an undrained tap does not fire after release)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'right', kind: 'press' })
    tracker.onKey({ key: 'right', kind: 'release' }) // sub-tick tap: released before any sample
    clock.set(50)
    expect(tracker.sample(1).turn).toBe(0)
  })

  it('turn: repeat events never enqueue quanta (tier 1 is driven by press/release truth)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 'right', kind: 'press' })
    expect(tracker.sample(1).turn).toBeCloseTo(TAP_DRAIN, 12)
    clock.set(100)
    tracker.onKey({ key: 'right', kind: 'repeat' })
    tracker.onKey({ key: 'right', kind: 'repeat' })
    expect(tracker.sample(2).turn).toBe(0) // no extra quanta, hold mode not yet reached
    clock.set(200)
    expect(tracker.sample(3).turn).toBe(1) // hold mode purely from held-time
  })

  it('fire: real held state; release clears it', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: ' ', kind: 'press' })
    expect(tracker.sample(1).fire).toBe(true)
    clock.set(1000)
    expect(tracker.sample(2).fire).toBe(true) // held: no 250ms latch decay in tier 1
    tracker.onKey({ key: ' ', kind: 'release' })
    expect(tracker.sample(3).fire).toBe(false)
  })

  it('enableTier1 clears tier-2 residue so no key is phantom-held', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    tracker.onKey({ key: 'right', kind: 'press' }) // pending quantum
    tracker.onKey({ key: ' ', kind: 'press' }) // latch
    tracker.enableTier1()
    clock.set(10_000)
    const s = tracker.sample(1)
    expect(s.forward).toBe(0)
    expect(s.turn).toBe(0)
    expect(s.fire).toBe(false)
  })
})

describe('mapping — axes and fire combine', () => {
  it('w + a + right-tap + space: movement builds to full via attack easing, the turn quantum drains once, fire latches', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    tracker.onKey({ key: 'a', kind: 'press' })
    tracker.onKey({ key: 'right', kind: 'press' })
    tracker.onKey({ key: ' ', kind: 'press' })
    const s1 = tracker.sample(1)
    expect(s1.forward).toBe(0.55)
    expect(s1.strafe).toBe(-0.55)
    expect(s1.turn).toBeCloseTo(TAP_DRAIN, 12)
    expect(s1.fire).toBe(true)
    tracker.sample(2)
    const s3 = tracker.sample(3)
    expect(s3).toEqual({ seq: 3, forward: 1, strafe: -1, turn: 0, fire: true, aimOffset: 0 })
  })
})

// Cursor aim (feel-8): the pointer's normalized x offset from center,
// aimNorm = clamp((x − center)/halfWidth, −1, 1) with center = (viewCols+1)/2
// and halfWidth = viewCols/2, maps to aimOffset = aimNorm·RENDER_HALF_FOV. The
// view only turns when |aimNorm| pushes past BAND_START = 0.85, linearly
// 0→EDGE_TURN_MAX (0.5) across the outer 15%, and that target is approached by
// an eased smoothed value: at most 0.12 per sample() when rising, snapped
// straight to the target when falling (instant release). onMouseMotion(x, y,
// viewCols, viewRows) — y/viewRows are stored for the crosshair but never
// touch the sim.
const VCOLS = 80
const VROWS = 24
const AIM_CENTER = (VCOLS + 1) / 2 // 40.5
const AIM_HALF = VCOLS / 2 // 40
// The pointer x (may be fractional in a unit test) that yields a given aimNorm.
const xForAimNorm = (n: number): number => AIM_CENTER + n * AIM_HALF
const bandTurnTarget = (n: number): number => Math.sign(n) * 0.5 * ((Math.abs(n) - 0.85) / 0.15)

describe('cursor aim — the pointer position IS the aim (both tiers)', () => {
  it('no pointer seen yet → aimOffset 0 and no mouse turn', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBe(0)
    expect(s.turn).toBe(0)
  })

  it('a centered pointer → 0 aim, 0 turn', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(AIM_CENTER, 12, VCOLS, VROWS)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(0, 12)
    expect(s.turn).toBe(0)
  })

  it('aimNorm 0.5 → aimOffset = 0.5·RENDER_HALF_FOV, and zero turn (inside the band)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(0.5), 12, VCOLS, VROWS)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(0.5 * RENDER_HALF_FOV, 12)
    expect(s.turn).toBe(0)
  })

  it('aimNorm 0.85 → exactly the boundary: 0 turn (band no longer starts at 0.7)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(0.85), 12, VCOLS, VROWS)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(0.85 * RENDER_HALF_FOV, 12)
    expect(s.turn).toBe(0)
  })

  it('a left-of-center pointer mirrors: negative aim and negative eased turn', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(-1), 12, VCOLS, VROWS)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(-1 * RENDER_HALF_FOV, 12)
    expect(s.turn).toBeCloseTo(-0.12, 12) // first sample: eased, capped at BAND_ATTACK_PER_TICK
  })

  it('aimNorm clamps at the far edge: aimOffset = RENDER_HALF_FOV, target 0.5 approached by easing', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(1.5), 12, VCOLS, VROWS) // past the edge → aimNorm clamps to 1
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(RENDER_HALF_FOV, 12)
    expect(s.turn).toBeCloseTo(0.12, 12) // first sample after entry: capped at 0.12, not the 0.5 target
  })

  it('geometry follows viewCols: the same x is a different aimNorm at a wider view', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    // x = 74.5 is aimNorm 0.85 at viewCols 80, but well inside the band at 160
    tracker.onMouseMotion(74.5, 12, 160, VROWS) // center 80.5, half 80 → aimNorm ≈ −0.075
    const s = tracker.sample(1)
    expect(s.turn).toBe(0) // inside the band at the wider view
    expect(s.aimOffset).toBeCloseTo(((74.5 - 80.5) / 80) * RENDER_HALF_FOV, 12)
  })

  it('cursor aim is identical under tier 1 (never touches tier state)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS)
    const s = tracker.sample(1)
    expect(s.aimOffset).toBeCloseTo(1 * RENDER_HALF_FOV, 12)
    expect(s.turn).toBeCloseTo(0.12, 12) // same easing as tier 2
  })
})

describe('cursor aim — edge-band view turn is eased, not instant (feel-8)', () => {
  it('a parked cursor at the edge ramps toward the 0.5 target, ≤0.12 on the first sample, reaching 0.5 within 5 samples', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS) // aimNorm 1 → target 0.5
    const first = tracker.sample(1).turn
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThanOrEqual(0.12 + 1e-9)
    let last = first
    for (let i = 2; i <= 5; i++) {
      const t = tracker.sample(i).turn
      expect(t).toBeGreaterThanOrEqual(last) // monotonically rising toward the target
      last = t
    }
    expect(last).toBeCloseTo(0.5, 12) // full EDGE_TURN_MAX reached by sample 5
    for (let i = 6; i <= 10; i++) expect(tracker.sample(i).turn, `sample ${i}`).toBeCloseTo(0.5, 12) // holds
  })

  it('pulling the cursor back inside the band stops the turn immediately, even mid-ramp', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS)
    tracker.sample(1) // first ramp step (0.12), well short of the 0.5 target
    tracker.sample(2) // second ramp step (0.24)
    tracker.onMouseMotion(AIM_CENTER, 12, VCOLS, VROWS) // pulled back to center mid-ramp
    expect(tracker.sample(3).turn).toBe(0) // instant release: no lingering ramp momentum
  })

  it('just inside the band boundary is exactly 0; just outside ramps from 0 toward the (small) target', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(0.85), 12, VCOLS, VROWS) // exactly BAND_START
    expect(tracker.sample(1).turn).toBe(0)
    tracker.onMouseMotion(xForAimNorm(0.925), 12, VCOLS, VROWS) // halfway across the band: target 0.25
    const t = tracker.sample(2).turn
    expect(t).toBeCloseTo(Math.min(0.12, bandTurnTarget(0.925)), 12)
  })

  it('the edge-band mouse turn ADDS to a keyboard tap (feel-4 keyboard budget unchanged)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS) // mouse turn target 0.5, eased
    tracker.onKey({ key: 'right', kind: 'press' }) // one keyboard quantum on top
    // first tick: 0.12 (eased mouse) + TAP_DRAIN (keyboard), clamped to [-1, 1]
    expect(tracker.sample(1).turn).toBeCloseTo(0.12 + TAP_DRAIN, 12)
    // the keyboard quantum drains in one tick; the mouse turn keeps ramping from state
    expect(tracker.sample(2).turn).toBeCloseTo(0.24, 12)
  })

  it('sign symmetry: the negative-side ramp mirrors the positive-side ramp exactly', () => {
    const clock = mkClock()
    const pos = mkTracker(clock)
    pos.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS)
    const neg = mkTracker(mkClock())
    neg.onMouseMotion(xForAimNorm(-1), 12, VCOLS, VROWS)
    for (let i = 1; i <= 5; i++) expect(neg.sample(i).turn).toBeCloseTo(-pos.sample(i).turn, 12)
  })
})

describe('cursor aim — the pointer survives resetTransient (physical position)', () => {
  it('a respawn does NOT forget the cursor: aim resumes, but the smoothed band-turn ramp restarts from 0', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS) // parked at the edge
    tracker.sample(1)
    tracker.sample(2) // ramp underway (0.24)
    tracker.resetTransient() // self-death: clears the smoothed band-turn state
    const s = tracker.sample(3)
    expect(s.turn).toBeCloseTo(0.12, 12) // ramp restarts from 0, not from where it left off
    expect(s.aimOffset).toBeCloseTo(RENDER_HALF_FOV, 12) // still aiming at the edge (pointer not cleared)
  })
})

describe('hold-to-walk — right/middle mouse button, active in BOTH tiers', () => {
  it('right press eases forward to 1 and HOLDS across arbitrary samples; release eases back to 0', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('right', 'press')
    expect(tracker.sample(1).forward).toBe(0.55) // one attack step, not an instant jump
    expect(tracker.sample(2).forward).toBe(1)
    for (let i = 3; i <= 100; i++) expect(tracker.sample(i).forward, `sample ${i}`).toBe(1) // holds
    tracker.onMouseButton('right', 'release')
    expect(tracker.sample(101).forward).toBeCloseTo(0.7, 12) // release easing (1 − 0.3)
  })

  it('middle button is identical to right', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('middle', 'press')
    expect(tracker.sample(1).forward).toBe(0.55)
    expect(tracker.sample(2).forward).toBe(1)
    tracker.onMouseButton('middle', 'release')
    expect(tracker.sample(3).forward).toBeCloseTo(0.7, 12)
  })

  it('the left button does not walk (it is fire only)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('left', 'press')
    expect(tracker.sample(1).forward).toBe(0) // no walk
    expect(tracker.sample(1).fire).toBe(true) // but it does fire
  })

  it('walkHeld overrides an active backward latch while held; the latch resumes on release', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 's', kind: 'press' }) // backward latch = −1
    tracker.sample(1)
    tracker.sample(2)
    expect(tracker.sample(3).forward).toBe(-1) // eased to full reverse
    tracker.onMouseButton('right', 'press') // override target → +1
    let f = -1
    for (let i = 4; i < 30; i++) f = tracker.sample(i).forward
    expect(f).toBe(1) // walks forward despite the backward latch
    tracker.onMouseButton('right', 'release') // latch (still −1) resumes
    for (let i = 30; i < 60; i++) f = tracker.sample(i).forward
    expect(f).toBe(-1) // eases back to the unchanged latch
  })

  it('tier 1: the override is binary and instant (walk 1 while held, latch/axis resumes on release)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onKey({ key: 's', kind: 'press' }) // held backward
    expect(tracker.sample(1).forward).toBe(-1)
    tracker.onMouseButton('right', 'press')
    expect(tracker.sample(2).forward).toBe(1) // override, no easing in tier 1
    tracker.onMouseButton('right', 'release')
    expect(tracker.sample(3).forward).toBe(-1) // s still held → resumes
  })

  it('resetTransient clears walkHeld', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('right', 'press')
    tracker.sample(1)
    tracker.resetTransient()
    expect(tracker.sample(2).forward).toBe(0) // walkHeld gone, smoothed snapped
    clock.set(5000)
    expect(tracker.sample(3).forward).toBe(0) // stays 0 with no events
  })
})

describe('mouse fire — real left-button press/release, active in BOTH tiers', () => {
  it('left press → fire true next sample; release → false', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('left', 'press')
    expect(tracker.sample(1).fire).toBe(true)
    tracker.onMouseButton('left', 'release')
    expect(tracker.sample(2).fire).toBe(false)
  })

  it('middle/right buttons never fire', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('right', 'press')
    tracker.onMouseButton('middle', 'press')
    expect(tracker.sample(1).fire).toBe(false)
  })

  it('resetTransient clears mouse-fire', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onMouseButton('left', 'press')
    tracker.resetTransient()
    expect(tracker.sample(1).fire).toBe(false)
  })

  it('space fire still works in tier 2 alongside mouse fire', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: ' ', kind: 'press' })
    expect(tracker.sample(1).fire).toBe(true) // space latch unaffected by the mouse path
  })

  it('mouse fire works in tier 1 (alongside real space held)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.enableTier1()
    tracker.onMouseButton('left', 'press')
    expect(tracker.sample(1).fire).toBe(true)
    tracker.onMouseButton('left', 'release')
    expect(tracker.sample(2).fire).toBe(false)
  })
})

// Mouselock (feel-9): setAimMode('mouselock') resurrects the feel-6 CS-style
// delta look. Motion deltas (dx in cells, clamped ±8) feed the SAME shared turn
// budget the keyboard uses at an accelerated dx·(0.035 + 0.004·(|dx|−1)) rad,
// saturating the mouse contribution at ±0.6 rad; aimOffset is forced 0 and the cursor-aim edge band
// contributes nothing. TURN_TICK_RAD = 0.13.
const MTICK = 0.13
// Fully drains the turn budget over up to 50 ticks, returning total rotation
// (Σ turn·TURN_TICK_RAD). In mouselock mode mouseTurn/aimOffset are 0, so the
// sum equals exactly the enqueued pending budget.
function drainRotation(tracker: IntentTracker, startSeq: number): number {
  let total = 0
  for (let i = 0; i < 50; i++) total += tracker.sample(startSeq + i).turn * MTICK
  return total
}

describe('mouselock mode — CS-style relative delta look (feel-9)', () => {
  it('forces aimOffset to 0 even for an off-center pointer (reticle is fixed center)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(xForAimNorm(1), 12, VCOLS, VROWS) // far off-center
    expect(tracker.sample(1).aimOffset).toBe(0)
  })

  it('cursor mode still maps aimNorm → aimOffset (mode is the only difference)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('cursor')
    tracker.onMouseMotion(xForAimNorm(0.5), 12, VCOLS, VROWS)
    expect(tracker.sample(1).aimOffset).toBeCloseTo(0.5 * RENDER_HALF_FOV, 12)
  })

  it('first event stores a baseline (no phantom delta); the next event drives the accelerated dx rate', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS) // baseline only
    expect(drainRotation(tracker, 1)).toBeCloseTo(0, 12)
    tracker.onMouseMotion(43, 12, VCOLS, VROWS) // dx = 3 → 3·(0.035 + 0.004·2) = 0.129 rad
    expect(drainRotation(tracker, 100)).toBeCloseTo(0.129, 12)
  })

  it('clamps a per-event delta to ±8 cells (a teleport can never snap the view)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS)
    tracker.onMouseMotion(400, 12, VCOLS, VROWS) // dx = 360, clamped to 8 → 8·(0.035 + 0.004·7) = 0.504 rad
    expect(drainRotation(tracker, 1)).toBeCloseTo(0.504, 12)
  })

  it('saturates the mouse contribution at ±0.6 rad (a stale look backlog is dropped)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(0, 12, VCOLS, VROWS) // baseline
    // three +8 deltas = 1.512 rad enqueued, saturated to 0.6 before any drain
    for (let i = 1; i <= 3; i++) tracker.onMouseMotion(8 * i, 12, VCOLS, VROWS)
    expect(drainRotation(tracker, 1)).toBeCloseTo(0.6, 12)
  })

  it('negative deltas mirror exactly', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS)
    tracker.onMouseMotion(36, 12, VCOLS, VROWS) // dx = -4 → -4·(0.035 + 0.004·3) = -0.188 rad
    expect(drainRotation(tracker, 1)).toBeCloseTo(-0.188, 12)
  })

  it('a keyboard tap ADDS on top of a mouse-inflated budget past the ±0.24 cap (feel-6 property)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(0, 12, VCOLS, VROWS)
    tracker.onMouseMotion(8, 12, VCOLS, VROWS) // +0.504 (past the 0.24 keyboard cap)
    tracker.onKey({ key: 'right', kind: 'press' }) // +0.06 tap on top, not clamped down
    expect(drainRotation(tracker, 1)).toBeCloseTo(0.504 + 0.06, 12)
  })

  it('keyboard-only turn stays bit-identical: a lone tap still drains exactly one quantum', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock') // mode switch must not change the keyboard path
    tracker.onKey({ key: 'right', kind: 'press' }) // one tap, no mouse
    expect(drainRotation(tracker, 1)).toBeCloseTo(0.06, 12) // exactly TURN_TAP_RAD, uncapped
  })

  it('ignoreDeltasUntil swallows enqueues but still advances lastX (no warp-jump misread)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS) // baseline
    tracker.ignoreDeltasUntil(100)
    clock.set(50)
    tracker.onMouseMotion(60, 12, VCOLS, VROWS) // in window: lastX→60, but nothing enqueued
    expect(drainRotation(tracker, 1)).toBeCloseTo(0, 12)
    clock.set(100)
    tracker.onMouseMotion(63, 12, VCOLS, VROWS) // window over: dx from 60 (not 40) = 3 → 0.129
    expect(drainRotation(tracker, 100)).toBeCloseTo(0.129, 12)
  })

  it('a mode switch clears the delta baseline so no stale jump is replayed', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS)
    tracker.onMouseMotion(48, 12, VCOLS, VROWS) // +0.504 pending
    tracker.setAimMode('cursor')
    tracker.setAimMode('mouselock') // clears lastX
    tracker.onMouseMotion(1000, 12, VCOLS, VROWS) // baseline again — must NOT add a huge delta
    expect(drainRotation(tracker, 1)).toBeCloseTo(0.504, 12) // only the pre-switch delta remains
  })

  it('resetTransient clears the delta budget and baseline', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.setAimMode('mouselock')
    tracker.onMouseMotion(40, 12, VCOLS, VROWS)
    tracker.onMouseMotion(48, 12, VCOLS, VROWS) // +0.504 pending
    tracker.resetTransient()
    tracker.onMouseMotion(1000, 12, VCOLS, VROWS) // baseline (no delta)
    expect(drainRotation(tracker, 1)).toBeCloseTo(0, 12) // budget wiped, no stale jump
  })
})
