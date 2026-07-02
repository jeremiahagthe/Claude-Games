import { makeInput, type PlayerInput } from '@fragwait/core'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Key classes: turn keys favor tap precision (fine aim corrections shouldn't
// overshoot), movement keys favor continuity (a held key must not sag mid-hold
// through the OS's initial-repeat gap). Everything else tracked (fire) keeps
// the pre-classification default behavior — see INITIAL_DECAY_MS_DEFAULT.
const TURN_KEYS = new Set(['left', 'right'])
const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'up', 'down'])

// Adaptive decay bounds (ms). A key's decay window tracks its own observed
// press/repeat cadence instead of a single fixed timeout: fast OS key-repeat
// (e.g. macOS steady-state ~16-40ms) shrinks the window toward MIN_DECAY_MS
// for snappy release detection, while a slow/absent repeat cadence widens it
// toward MAX_DECAY_MS so the key doesn't go phantom-unheld between repeats.
const MIN_DECAY_MS = 120
const MAX_DECAY_MS = 600
const DECAY_SLOPE = 1.6
const DECAY_INTERCEPT_MS = 40

// Initial (unlearned) decay windows, used before any press/repeat interval
// has been observed for a key — i.e. they bridge the OS's initial repeat
// delay (~250-500ms on macOS). Turn keys get a shorter window so an
// unlearned tap stops turning sooner (less overshoot while correcting aim);
// movement keys get a longer one so a fresh hold's envelope doesn't taper
// away before the OS's first repeat lands (see FULL_INTENT_MS below).
const INITIAL_DECAY_MS_TURN = 350
const INITIAL_DECAY_MS_MOVEMENT = 600
const INITIAL_DECAY_MS_DEFAULT = 450 // fire, and any untracked-class fallback

// Tier-2 tap envelope: a key's intent stays at full strength while its age is
// within its taper start, then tapers linearly to 0 by the key's (adaptive)
// decay window. Turn keys taper start at min(FULL_INTENT_MS, decayFor/2) —
// capping the taper start keeps it reachable even when the adaptive decay
// floor (120ms, after fast OS repeats) dips below FULL_INTENT_MS: full until
// 60ms, taper 60->120ms — instead of snapping 1->0 at the boundary. Movement
// keys instead taper start at 0.75 * decayFor(key), uncapped: with macOS
// defaults (initial repeat ~375ms < 0.75 * 600ms initial window = 450ms), a
// fresh hold's envelope stays at 1.0 straight through the initial repeat gap
// — continuity matters more than tap precision for movement. Either way this
// turns a tap (registered for the full initial decay window with no repeat)
// into a short, tapering impulse instead of full-strength input for the
// whole window, and keeps a slow first OS repeat from reading as a hard stop.
// Tier 1 has real release events, so it stays exactly binary and never tapers.
const FULL_INTENT_MS = 140

// Per-tick (20Hz sim tick) easing applied on top of the envelope: the sampled
// axis moves toward the raw envelope-derived value by at most this much per
// sample() call — faster while building up (attack) than releasing.
const ATTACK_PER_TICK = 0.55
const RELEASE_PER_TICK = 0.3

// Turn-speed ramp (tap precision vs sustained-turn speed): a turn key's
// contribution to the turn axis is scaled by how long it's been continuously
// held, from TURN_RAMP_BASE up to 1.0 over TURN_RAMP_MS. A tap fires at
// ~35% of TURN_SPEED (small, precise corrections that converge on a target
// instead of ping-ponging past it); a sustained hold ramps up to full speed
// within half a second, so a fast 180-degree turn is still fast. Movement
// axes are not ramped — only turn overshoots, movement doesn't.
const TURN_RAMP_BASE = 0.35
const TURN_RAMP_MS = 500

type Axis = 'forward' | 'strafe' | 'turn'

export class IntentTracker {
  private held = new Map<string, number>() // key -> last seen at (ms)
  private turnHoldStart = new Map<string, number>() // turn key -> wall-clock start of its current continuous hold
  private lastInterval = new Map<string, number>() // key -> last observed press/repeat interval (ms)
  private tier1 = false
  private smoothed: Record<Axis, number> = { forward: 0, strafe: 0, turn: 0 }

  // decayMs, when given, overrides the initial (unlearned) decay window for
  // ALL keys regardless of class — used by tests that want one uniform
  // window. Production leaves it unset so each key uses its class default
  // (see INITIAL_DECAY_MS_TURN / _MOVEMENT / _DEFAULT).
  constructor(private now: () => number, private decayMs?: number) {}

  enableTier1(): void {
    this.tier1 = true
    this.held.clear() // tier-2 entries have no reliable release; start clean
    this.turnHoldStart.clear()
    this.lastInterval.clear()
    this.smoothed = { forward: 0, strafe: 0, turn: 0 }
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return
    if (e.kind === 'release') {
      if (this.tier1) this.clearHold(e.key)
      return // tier 2: releases don't exist reliably; decay handles it
    }
    const t = this.now()
    const prev = this.held.get(e.key)
    if (prev !== undefined) {
      this.lastInterval.set(e.key, t - prev)
    } else if (TURN_KEYS.has(e.key)) {
      // envelope was 0 (never held, or a prior hold fully decayed/released):
      // this press starts a new continuous hold for the turn-speed ramp.
      this.turnHoldStart.set(e.key, t)
    }
    this.held.set(e.key, t)
  }

  // Clears a key's held state and (for turn keys) its ramp hold-start
  // together, so the two never drift out of sync.
  private clearHold(key: string): void {
    this.held.delete(key)
    this.turnHoldStart.delete(key)
  }

  private initialDecayMs(key: string): number {
    if (this.decayMs !== undefined) return this.decayMs
    if (TURN_KEYS.has(key)) return INITIAL_DECAY_MS_TURN
    if (MOVEMENT_KEYS.has(key)) return INITIAL_DECAY_MS_MOVEMENT
    return INITIAL_DECAY_MS_DEFAULT
  }

  private decayFor(key: string): number {
    const interval = this.lastInterval.get(key)
    if (interval === undefined) return this.initialDecayMs(key)
    return Math.min(MAX_DECAY_MS, Math.max(MIN_DECAY_MS, interval * DECAY_SLOPE + DECAY_INTERCEPT_MS))
  }

  // Where the tap envelope starts tapering off full strength, per key class
  // (see the FULL_INTENT_MS comment above for the rationale).
  private taperStartFor(key: string, decay: number): number {
    if (MOVEMENT_KEYS.has(key)) return 0.75 * decay
    return Math.min(FULL_INTENT_MS, decay / 2) // turn keys, and fallback (unreached: envelope() is only ever called with turn/movement keys)
  }

  private isHeld(key: string): boolean {
    const t = this.held.get(key)
    if (t === undefined) return false
    if (!this.tier1 && this.now() - t >= this.decayFor(key)) {
      this.clearHold(key)
      return false
    }
    return true
  }

  // Tier-2 only: 0 if not held; 1.0 while age <= taperStartFor(key); then
  // tapers linearly to 0 by the key's (adaptive) decay window.
  // Tier 1 has real release events, so it stays exactly binary and doesn't call this.
  private envelope(key: string): number {
    const t = this.held.get(key)
    if (t === undefined) return 0
    const age = this.now() - t
    const decay = this.decayFor(key)
    if (age >= decay) {
      this.clearHold(key)
      return 0
    }
    const taperStart = this.taperStartFor(key, decay)
    if (age <= taperStart) return 1
    return 1 - (age - taperStart) / (decay - taperStart)
  }

  private maxEnvelope(keys: string[]): number {
    let m = 0
    for (const k of keys) m = Math.max(m, this.envelope(k))
    return m
  }

  // How long `key` (a turn key) has been continuously held, scaled into the
  // [TURN_RAMP_BASE, 1] range over TURN_RAMP_MS. Used to multiply a turn
  // key's contribution so a fresh tap starts slow and a sustained hold
  // accelerates to full TURN_SPEED (see the module-level comment above).
  private turnRamp(key: string): number {
    const start = this.turnHoldStart.get(key)
    const heldMs = start === undefined ? 0 : this.now() - start
    return TURN_RAMP_BASE + (1 - TURN_RAMP_BASE) * Math.min(1, heldMs / TURN_RAMP_MS)
  }

  // Tier 1: today's exact binary axis (real press/release, no decay/easing).
  private binaryAxis(pos: string[], neg: string[]): -1 | 0 | 1 {
    const p = pos.some((k) => this.isHeld(k))
    const n = neg.some((k) => this.isHeld(k))
    return p === n ? 0 : p ? 1 : -1
  }

  // Tier 1 turn axis: binary hold detection (exact, like binaryAxis), but the
  // ramp still applies — a tier-1 hold's start/duration is known exactly, so
  // there's no reason to skip the same overshoot fix tier 2 gets.
  private turnAxisTier1(): number {
    const p = this.isHeld('right')
    const n = this.isHeld('left')
    if (p === n) return 0
    return p ? this.turnRamp('right') : -this.turnRamp('left')
  }

  // Tier 2: continuous axis in [-1, 1] from the tap envelope, before easing.
  private rawAxis(pos: string[], neg: string[]): number {
    const v = this.maxEnvelope(pos) - this.maxEnvelope(neg)
    return Math.max(-1, Math.min(1, v))
  }

  // Tier 2 turn axis: like rawAxis, but each side's envelope is scaled by
  // that key's turn ramp before combining (movement axes get no such scale).
  private rawTurnAxis(): number {
    const p = this.envelope('right') * this.turnRamp('right')
    const n = this.envelope('left') * this.turnRamp('left')
    return Math.max(-1, Math.min(1, p - n))
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
        turn: this.turnAxisTier1(),
        fire: this.isHeld(' '),
      })
    }
    return makeInput(seq, {
      forward: this.ease('forward', this.rawAxis(['w', 'up'], ['s', 'down'])),
      strafe: this.ease('strafe', this.rawAxis(['d'], ['a'])),
      turn: this.ease('turn', this.rawTurnAxis()),
      fire: this.isHeld(' '),
    })
  }
}
