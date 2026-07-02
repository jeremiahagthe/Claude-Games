import { describe, expect, it } from 'vitest'
import type { PlayerInput } from '@fragwait/core'
import { IntentTracker } from '../src/input/intent.js'
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

describe('S1 regression — fresh movement press after a taught hold must not sawtooth (F3)', () => {
  it('S1: w press at T0 after a previous 83ms-repeat hold: forward ≥ 0.9 for every tick in [T0+100, T0+1500]', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const T0 = 1500
    const events: Sched[] = [
      // previous hold: press, first repeat at 500, steady 83ms repeats, then released
      { t: 0, key: 'w' },
      ...repeats('w', 500, 666, 83),
      // fresh hold: press, the OS's 500ms initial-repeat gap, then steady repeats.
      // Under the old adaptive-decay design the learned ~173ms window persisted
      // across holds and the fresh press died inside the 500ms gap (F3 sawtooth).
      { t: T0, key: 'w' },
      ...repeats('w', T0 + 500, T0 + 1500, 83),
    ]
    const samples = run(tracker, clock, events, T0 + 1500)
    // the previous hold fully expired and eased back to rest before the fresh press
    expect(at(samples, 1450).forward).toBe(0)
    for (let t = T0 + 100; t <= T0 + 1500; t += 50) {
      expect(at(samples, t).forward, `forward at t=${t}`).toBeGreaterThanOrEqual(0.9)
    }
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

describe('S3 regression — chorded W+D diagonal must survive F2 repeat starvation', () => {
  it('S3: w held (repeating), d pressed at t=1000 (w events stop per F2): both axes ≥ 0.9 from 1600 through 3000, both 0 by 3600', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      // w owns the repeat slot until d is pressed
      { t: 0, key: 'w' },
      ...repeats('w', 500, 998, 83),
      // d steals the single repeat slot (F2): w gets no further events, ever
      { t: 1000, key: 'd' },
      ...repeats('d', 1500, 2994, 83),
      // d released at ~3000: all events stop
    ]
    const samples = run(tracker, clock, events, 3700)
    for (let t = 1600; t <= 3000; t += 50) {
      expect(at(samples, t).forward, `forward at t=${t}`).toBeGreaterThanOrEqual(0.9)
      expect(at(samples, t).strafe, `strafe at t=${t}`).toBeGreaterThanOrEqual(0.9)
    }
    expect(at(samples, 3600).forward).toBe(0)
    expect(at(samples, 3600).strafe).toBe(0)
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

describe('movement keep-alive — cross-key grants against F2 starvation', () => {
  it('event-type asymmetry: a press grants PHASE_A (w survives a 500ms self-gap), repeats grant only 350ms', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' }, // w's only own event
      { t: 600, key: 'd' }, // press-classified: grants w PHASE_A (655) → w lives to 1255
      { t: 1100, key: 'd' }, // d's first repeat: grants w 350 → 1450
      { t: 1183, key: 'd' }, // repeat: grants w 350 → 1533
    ]
    const samples = run(tracker, clock, events, 1700)
    expect(at(samples, 1100).forward).toBe(1) // survived 500ms without any own event: press grant was PHASE_A
    expect(at(samples, 1400).forward).toBe(1) // repeat grants carried it to 1533
    expect(at(samples, 1600).forward).toBe(0) // repeat grant was 350, NOT PHASE_A (655 would still read 1 here)
  })

  it('space-source grants are capped: with only space events, w dies by lastSelfEvent + 1500 + grant + taper', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' }, // lastSelfEvent = 0, forever
      ...repeats(' ', 100, 2100, 83), // stand-and-fire: space repeats for 2s
    ]
    const samples = run(tracker, clock, events, 2100)
    expect(at(samples, 1500).forward).toBe(1) // grants flow while within the cap
    // last granting space event ≤ 1500 is at 1428 → w expires 1778 → eased 0 well before the 1970 bound
    expect(at(samples, 1850).forward).toBe(0)
    expect(at(samples, 1950).forward).toBe(0) // = lastSelfEvent + 1500 + 350 + 120 bound (minus grid rounding)
  })

  it('movement-source grants are exempt from the cap: d repeating for 4s keeps w at full forward throughout', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' }, // w's only own event: silent (F2) for the whole 4s
      { t: 100, key: 'd' },
      ...repeats('d', 600, 3920, 83), // a real chord: d's repeats never stop
    ]
    const samples = run(tracker, clock, events, 4000)
    for (let t = 100; t <= 4000; t += 50) {
      // now − w.lastSelfEvent reaches 4000 — far past the 1500ms cap — but the
      // source is a currently-held movement key, so grants keep flowing (S3)
      expect(at(samples, t).forward, `forward at t=${t}`).toBeGreaterThanOrEqual(0.9)
      expect(at(samples, t).strafe, `strafe at t=${t}`).toBeGreaterThanOrEqual(t >= 200 ? 0.9 : 0)
    }
  })

  it('turn keys GIVE movement grants (their events prove the hand is on the keyboard)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' },
      { t: 300, key: 'right' }, // press-classified turn event: grants w PHASE_A → 955
    ]
    const samples = run(tracker, clock, events, 900)
    expect(at(samples, 800).forward).toBe(1) // without the grant w's envelope is 0 by 655
  })

  it('untracked keys arm nothing: repeating x/tab does not extend a decaying w', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' },
      ...repeats('x', 100, 900, 83),
      ...repeats('tab', 140, 900, 83),
    ]
    const samples = run(tracker, clock, events, 900)
    expect(at(samples, 750).forward).toBe(0) // w expired at 655 and eased out, untouched by x/tab
  })

  it('a provisional stop-tap is never kept alive by chord grants (no phantom sustained reverse)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' },
      { t: 50, key: 'd' },
      ...repeats('d', 550, 1500, 83), // d owns the repeat slot throughout
      { t: 701, key: 's' }, // stop-tap: clears w, registers provisionally (150ms)
    ]
    const samples = run(tracker, clock, events, 1300)
    expect(at(samples, 750).forward).toBeLessThanOrEqual(0) // stop-first took effect
    for (const [t, s] of samples) {
      expect(s.forward, `forward at t=${t}`).toBeGreaterThanOrEqual(-0.55 - 1e-9) // never a full reverse
    }
    expect(at(samples, 950).forward).toBe(0) // s expired on its own terms despite d's repeats granting
    expect(at(samples, 1200).forward).toBe(0)
    expect(at(samples, 1200).strafe).toBe(1) // the chord partner itself is unaffected
  })
})

describe('stop-first opposing press (B3)', () => {
  // w held in phase B (repeats flowing), envelope alive through ~959
  const wHold: Sched[] = [{ t: 0, key: 'w' }, ...repeats('w', 500, 666, 83)]

  it('tap-S while running: forward ≤ 0 next tick, bounded by one attack step within 150ms, back to 0 — no backward lurch', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [...wHold, { t: 701, key: 's' }], 1000)
    expect(at(samples, 700).forward).toBe(1) // running forward until the tap
    expect(at(samples, 750).forward).toBeLessThanOrEqual(0) // snap + one attack step
    for (const t of [750, 800, 850]) {
      expect(Math.abs(at(samples, t).forward), `|forward| at t=${t}`).toBeLessThanOrEqual(0.55 + 1e-9)
    }
    expect(at(samples, 900).forward).toBe(0) // provisional expired at 851: instant stop achieved
  })

  it('hold-S: the provisional entry expires, then the OS first repeat re-registers a full phase-A hold — full reverse', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [...wHold, { t: 701, key: 's' }, ...repeats('s', 1201, 1450, 83)]
    const samples = run(tracker, clock, events, 1500)
    // documented trade: between the provisional expiry (851) and the OS's
    // first repeat (1201) the held S produces nothing — one clean pause
    expect(at(samples, 1150).forward).toBe(0)
    for (let t = 1300; t <= 1450; t += 50) expect(at(samples, t).forward, `forward at t=${t}`).toBe(-1)
  })

  it('a human re-tap inside the provisional window upgrades to a full phase-A hold (the OS cannot repeat that fast)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [...wHold, { t: 701, key: 's' }, { t: 801, key: 's' }]
    const samples = run(tracker, clock, events, 1600)
    expect(at(samples, 900).forward).toBe(-1) // upgraded: full reverse immediately
    expect(at(samples, 1300).forward).toBe(-1) // phase-A window (655), not a 173ms steady window
    expect(at(samples, 1550).forward).toBe(0) // and it still expires without repeats
  })

  it('a re-press after F2 starvation resets the phase to A (no steady-window sawtooth on the new hold)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const events: Sched[] = [
      { t: 0, key: 'w' },
      ...repeats('w', 500, 998, 83), // phase B taught
      { t: 1000, key: 'd' }, // F2: w starves; d's press grants w to 1655
      { t: 1300, key: 'w' }, // player re-presses w: implausible 302ms gap = new physical hold
      ...repeats('w', 1800, 2049, 83), // the new hold's own first repeat comes a full initialDelay later
    ]
    const samples = run(tracker, clock, events, 2300)
    for (let t = 1350; t <= 2200; t += 50) {
      // a persisted phase B would give the re-press a 173ms window and kill it
      // inside the 500ms initial-repeat gap — the F3 sawtooth all over again
      expect(at(samples, t).forward, `forward at t=${t}`).toBeGreaterThanOrEqual(0.9)
    }
  })
})

describe('movement envelope — phase A window and taper', () => {
  it('PHASE_A margin pin: with the ×1.15+80 variant, a factory first repeat (500ms) lands while the envelope is still 1.0', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }], 800)
    expect(at(samples, 500).forward).toBe(1) // taper starts at 655−120 = 535 > 500
    expect(at(samples, 550).forward).toBeLessThan(1) // tap without repeats begins tapering
    expect(at(samples, 700).forward).toBe(0) // fully released by expiry + easing tail
  })

  it('a tap releases through the taper + easing: never a cliff (per-tick drop ≤ RELEASE_PER_TICK)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    const samples = run(tracker, clock, [{ t: 0, key: 'w' }], 800)
    const values = [...samples.values()].map((s) => s.forward)
    const peak = Math.max(...values)
    expect(peak).toBe(1)
    for (let i = values.indexOf(peak) + 1; i < values.length; i++) {
      const drop = values[i - 1]! - values[i]!
      expect(drop).toBeGreaterThanOrEqual(0)
      expect(drop).toBeLessThanOrEqual(0.3 + 1e-9)
    }
  })

  it('attack easing: 0 → full within 2 samples of a fresh hold', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'w', kind: 'press' })
    expect(tracker.sample(1).forward).toBe(0.55)
    expect(tracker.sample(2).forward).toBe(1)
  })

  it('release events are ignored in tier 2 (legacy terminals never send them)', () => {
    const clock = mkClock()
    const tracker = mkTracker(clock)
    tracker.onKey({ key: 'd', kind: 'press' })
    tracker.onKey({ key: 'd', kind: 'release' }) // terminal quirk: must not clear the hold
    clock.set(50)
    expect(tracker.sample(1).strafe).toBeGreaterThan(0)
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
    expect(s3).toEqual({ seq: 3, forward: 1, strafe: -1, turn: 0, fire: true })
  })
})
