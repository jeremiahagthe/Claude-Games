import { makeInput, type PlayerInput } from '@fragwait/core'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Adaptive decay bounds (ms). A key's decay window tracks its own observed
// press/repeat cadence instead of a single fixed timeout: fast OS key-repeat
// (e.g. macOS steady-state ~16-40ms) shrinks the window toward MIN_DECAY_MS
// for snappy release detection, while a slow/absent repeat cadence widens it
// toward MAX_DECAY_MS so the key doesn't go phantom-unheld between repeats.
const MIN_DECAY_MS = 120
const MAX_DECAY_MS = 600
const DECAY_SLOPE = 1.6
const DECAY_INTERCEPT_MS = 40

// Tier-2 tap envelope: a key's intent stays at full strength while its age is
// within the taper start — min(FULL_INTENT_MS, decayFor(key)/2), so the taper
// stays reachable even when the adaptive decay floor (120ms, after fast OS
// repeats) dips below FULL_INTENT_MS — then tapers linearly to 0 by the decay
// window. This turns a tap (registered for the full initial decay window with
// no repeat) into a short, tapering impulse instead of 450ms of full-strength
// input, and keeps a slow first OS repeat from reading as a hard stop.
const FULL_INTENT_MS = 140

// Per-tick (20Hz sim tick) easing applied on top of the envelope: the sampled
// axis moves toward the raw envelope-derived value by at most this much per
// sample() call — faster while building up (attack) than releasing.
const ATTACK_PER_TICK = 0.4
const RELEASE_PER_TICK = 0.3

type Axis = 'forward' | 'strafe' | 'turn'

export class IntentTracker {
  private held = new Map<string, number>() // key -> last seen at (ms)
  private lastInterval = new Map<string, number>() // key -> last observed press/repeat interval (ms)
  private tier1 = false
  private smoothed: Record<Axis, number> = { forward: 0, strafe: 0, turn: 0 }

  // decayMs is the INITIAL decay window used before any interval has been
  // observed for a key (bridges macOS's initial repeat delay, ~250-500ms).
  constructor(private now: () => number, private decayMs = 450) {}

  enableTier1(): void {
    this.tier1 = true
    this.held.clear() // tier-2 entries have no reliable release; start clean
    this.lastInterval.clear()
    this.smoothed = { forward: 0, strafe: 0, turn: 0 }
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return
    if (e.kind === 'release') {
      if (this.tier1) this.held.delete(e.key)
      return // tier 2: releases don't exist reliably; decay handles it
    }
    const t = this.now()
    const prev = this.held.get(e.key)
    if (prev !== undefined) this.lastInterval.set(e.key, t - prev)
    this.held.set(e.key, t)
  }

  private decayFor(key: string): number {
    const interval = this.lastInterval.get(key)
    if (interval === undefined) return this.decayMs
    return Math.min(MAX_DECAY_MS, Math.max(MIN_DECAY_MS, interval * DECAY_SLOPE + DECAY_INTERCEPT_MS))
  }

  private isHeld(key: string): boolean {
    const t = this.held.get(key)
    if (t === undefined) return false
    if (!this.tier1 && this.now() - t >= this.decayFor(key)) {
      this.held.delete(key)
      return false
    }
    return true
  }

  // Tier-2 only: 0 if not held; 1.0 while age <= min(FULL_INTENT_MS, decay/2);
  // then tapers linearly to 0 by the key's (adaptive) decay window. Capping the
  // taper start at half the decay window keeps the taper reachable when fast OS
  // repeats have shrunk decayFor() to its 120ms floor (< FULL_INTENT_MS): full
  // until 60ms, taper 60→120ms — instead of snapping 1→0 at the boundary.
  // Tier 1 has real release events, so it stays exactly binary and doesn't call this.
  private envelope(key: string): number {
    const t = this.held.get(key)
    if (t === undefined) return 0
    const age = this.now() - t
    const decay = this.decayFor(key)
    if (age >= decay) {
      this.held.delete(key)
      return 0
    }
    const taperStart = Math.min(FULL_INTENT_MS, decay / 2)
    if (age <= taperStart) return 1
    return 1 - (age - taperStart) / (decay - taperStart)
  }

  private maxEnvelope(keys: string[]): number {
    let m = 0
    for (const k of keys) m = Math.max(m, this.envelope(k))
    return m
  }

  // Tier 1: today's exact binary axis (real press/release, no decay/easing).
  private binaryAxis(pos: string[], neg: string[]): -1 | 0 | 1 {
    const p = pos.some((k) => this.isHeld(k))
    const n = neg.some((k) => this.isHeld(k))
    return p === n ? 0 : p ? 1 : -1
  }

  // Tier 2: continuous axis in [-1, 1] from the tap envelope, before easing.
  private rawAxis(pos: string[], neg: string[]): number {
    const v = this.maxEnvelope(pos) - this.maxEnvelope(neg)
    return Math.max(-1, Math.min(1, v))
  }

  // Moves this axis's smoothed value toward `raw` by at most ATTACK_PER_TICK
  // (magnitude increasing) or RELEASE_PER_TICK (magnitude decreasing) per call.
  // Called once per 20Hz sim tick — steps are per-tick, not wall-clock scaled.
  private ease(axis: Axis, raw: number): number {
    const prev = this.smoothed[axis]
    const step = Math.abs(raw) > Math.abs(prev) ? ATTACK_PER_TICK : RELEASE_PER_TICK
    const next = prev + Math.max(-step, Math.min(step, raw - prev))
    this.smoothed[axis] = next
    return next
  }

  sample(seq: number): PlayerInput {
    if (this.tier1) {
      return makeInput(seq, {
        forward: this.binaryAxis(['w', 'up'], ['s', 'down']),
        strafe: this.binaryAxis(['d'], ['a']),
        turn: this.binaryAxis(['right'], ['left']),
        fire: this.isHeld(' '),
      })
    }
    return makeInput(seq, {
      forward: this.ease('forward', this.rawAxis(['w', 'up'], ['s', 'down'])),
      strafe: this.ease('strafe', this.rawAxis(['d'], ['a'])),
      turn: this.ease('turn', this.rawAxis(['right'], ['left'])),
      fire: this.isHeld(' '),
    })
  }
}
