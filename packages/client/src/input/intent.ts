import { makeInput, type PlayerInput } from '@fragwait/core'
import { FACTORY_TIMINGS, type OsKeyTimings } from './os-timings.js'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Three key classes with different tier-2 models (feel iteration 5):
// - TURN keys are event-driven two-mode (tap quanta / OS-repeat-confirmed
//   hold), unchanged. No envelope, no easing — budget conservation makes "one
//   tap = exactly TURN_TAP_RAD of rotation" literally true in the sim. Mouse
//   position adds a joystick turn-rate on top of this (see onMouseMove).
// - MOVEMENT keys are LATCHED (sticky): a tap starts continuous motion that
//   persists with no further events, an opposing tap stops it, a second
//   opposing tap reverses. Timing-free by design — Apple Terminal can't
//   distinguish a press from an OS auto-repeat, and only auto-repeats ONE key
//   at a time (F2), so any hold-inference model is unfixable. Latching needs
//   neither.
// - FIRE is a per-event space latch OR the real mouse-button state.
const TURN_KEYS = new Set(['left', 'right'])
const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'up', 'down'])

// Each movement key's latch axis and direction. A tap toggles that axis
// between 0 and its direction (opposing direction → 0, i.e. stop-first).
const MOVE_LATCH: Record<string, { axis: 'forward' | 'strafe'; dir: 1 | -1 }> = {
  w: { axis: 'forward', dir: 1 }, up: { axis: 'forward', dir: 1 },
  s: { axis: 'forward', dir: -1 }, down: { axis: 'forward', dir: -1 },
  d: { axis: 'strafe', dir: 1 }, a: { axis: 'strafe', dir: -1 },
}

// --- Turn constants ---------------------------------------------------------
// One tap = one quantum of rotation (≈3.44°); a bot at 8 cells subtends ~6.4°,
// so two taps bracket it — fine aim corrections converge instead of sweeping.
const TURN_TAP_RAD = 0.06
// Pending tap budget cap (±4 taps); excess taps are dropped, never banked.
const TURN_PENDING_CAP_RAD = 0.24
// Rotation the sim performs in one 20Hz tick at axis ±1 — must mirror core's
// TURN_SPEED (2.6 rad/s / 20). sample() drains the pending budget by exactly
// the emitted fraction × this, so emitted rotation === enqueued quanta.
const TURN_TICK_RAD = 2.6 / 20

// --- Movement easing --------------------------------------------------------
// Per-20Hz-tick easing on movement axes only (turn is never eased). The latch
// is the sampled target; easing smooths the start/stop so a latch flip is a
// short ramp, never an instant 0→±1 cliff.
const ATTACK_PER_TICK = 0.55
const RELEASE_PER_TICK = 0.3

// --- Mouse aim (position → turn rate; joystick, active in BOTH tiers) --------
// normX is the pointer's horizontal offset from view center, in [-1, 1].
// Inside the dead-zone the contribution is 0; outside, it rises as t^1.5 (fine
// control near center, full rate at the edge). There is no pointer lock in any
// terminal, so this is absolute-position joystick aim, not relative mouse-look.
const AIM_DEADZONE = 0.10
const AIM_EXPONENT = 1.5

// --- Fire -------------------------------------------------------------------
// Every space event latches fire for this long. Blaster cooldown is 500ms, so
// a 250ms latch per event costs nothing while killing both fire starvation
// under F2 and phantom rail shots from stale hold state.
const FIRE_LATCH_MS = 250

// --- Tier 1 -----------------------------------------------------------------
// Tier-1 turn: a key still held (no release) this long after its press enters
// hold mode (±1); a shorter press was a tap (one quantum).
const TIER1_TURN_HOLD_MS = 150

interface TurnState {
  lastEvent: number
  // True when the last event was a press / human re-tap (started or restarted
  // the entry). The first-repeat hold-confirmation band only applies to the
  // gap after a press — never to gaps between arbitrary later events, so a
  // re-tap ~initialDelay after a dead hold's last repeat stays a tap.
  prevWasPress: boolean
  hold: boolean
}

export class IntentTracker {
  // Windows derived from the injected OS timings T (read once at startup by
  // os-timings.ts; injected so tests stay hermetic):
  private readonly holdBandMinMs: number // first-repeat confirmation band (lower)
  private readonly holdBandMaxMs: number // first-repeat confirmation band (upper)
  private readonly turnSteadyGapMs: number // turn: gap ≤ this = the OS repeating
  private readonly turnHoldDeathMs: number // turn hold dies with no own event for this long

  // Tier-2 state
  private latch: Record<'forward' | 'strafe', -1 | 0 | 1> = { forward: 0, strafe: 0 }
  private turns = new Map<string, TurnState>()
  private turnPending = 0 // signed rad budget: right +, left −; at most one sign live
  private fireUntil = -Infinity
  private smoothed: Record<'forward' | 'strafe', number> = { forward: 0, strafe: 0 }

  // Mouse aim/fire (shared by both tiers; geometry is owned by offline.ts,
  // which passes an already-normalized, already-clamped normX in [-1, 1]).
  private mouseNormX: number | null = null // null until the first move → 0 turn
  private mouseFireHeld = false

  // Tier-1 state (kitty protocol: real press/repeat/release)
  private tier1 = false
  private t1Held = new Map<string, number>() // key -> pressed-at (ms)

  constructor(private now: () => number, opts: { timings?: OsKeyTimings } = {}) {
    const t = opts.timings ?? FACTORY_TIMINGS
    // First-repeat confirmation band [0.9, 1.25]×initialDelay: asymmetric on
    // purpose. The OS's first repeat is never early, so 0.9 (not the naive
    // 0.75) keeps a 400ms human re-tap press-classified at factory settings
    // ([450, 625]) while the ~500ms first repeat still confirms a turn hold.
    this.holdBandMinMs = t.initialDelayMs * 0.9
    this.holdBandMaxMs = t.initialDelayMs * 1.25
    this.turnSteadyGapMs = Math.max(120, 1.3 * t.repeatIntervalMs)
    this.turnHoldDeathMs = Math.max(2 * t.repeatIntervalMs, 180)
  }

  enableTier1(): void {
    this.tier1 = true
    this.t1Held.clear() // tier-2 entries have no reliable release; start clean
    this.resetTransient()
  }

  // Clears everything inferred/latched (turn budgets + hold modes, movement
  // latches, mouse-fire state, fire latch, smoothed axes). Called from
  // enableTier1() and on self-death: a respawn must not drain stale turn budget
  // or keep walking into the new facing. Deliberately does NOT clear the tier-1
  // physical held map (those keys are ground truth — their releases will
  // arrive) nor the stored mouse position (the pointer is still physically
  // where it was, so aim resumes from the current cursor).
  resetTransient(): void {
    this.latch = { forward: 0, strafe: 0 }
    this.mouseFireHeld = false
    this.turns.clear()
    this.turnPending = 0
    this.fireUntil = -Infinity
    this.smoothed = { forward: 0, strafe: 0 }
  }

  // ---- Mouse aim + fire (shared by both tiers) ------------------------------

  // Stores the pointer's normalized horizontal offset from view center, already
  // clamped to [-1, 1] by the caller (offline.ts owns the geometry).
  onMouseMove(normX: number): void {
    this.mouseNormX = normX
  }

  // Left button reports REAL press AND release (the only tier-2 input that
  // does). Middle/right ignored for now; motion never toggles fire.
  onMouseButton(button: 'left' | 'middle' | 'right' | 'none', action: 'press' | 'release' | 'motion'): void {
    if (button !== 'left') return
    if (action === 'press') this.mouseFireHeld = true
    else if (action === 'release') this.mouseFireHeld = false
  }

  // Mouse joystick turn contribution in [-1, 1]: 0 inside the dead-zone, then
  // sign · t^1.5 out to full rate at the edge. null (no move yet) → 0.
  private mouseTurn(): number {
    const n = this.mouseNormX
    if (n === null) return 0
    const a = Math.abs(n)
    if (a <= AIM_DEADZONE) return 0
    const t = (a - AIM_DEADZONE) / (1 - AIM_DEADZONE)
    return Math.sign(n) * Math.pow(t, AIM_EXPONENT)
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return // untracked keys never touch state
    if (this.tier1) {
      this.onKeyTier1(e)
      return
    }
    if (e.kind === 'release') return // tier 2: legacy terminals never send releases
    // Tier 2: 'press' covers both physical presses and OS auto-repeats — Apple
    // Terminal can't tell them apart. Turn still classifies by timing; movement
    // is latched (timing-free); space is a per-event fire latch.
    const now = this.now()
    if (TURN_KEYS.has(e.key)) { this.onTurnEvent(e.key, now); return }
    if (MOVEMENT_KEYS.has(e.key)) { this.onMovementLatch(e.key); return }
    this.fireUntil = now + FIRE_LATCH_MS // space
  }

  // ---- Tier 2: movement latch ----------------------------------------------

  // A movement-key event (press OR indistinguishable OS repeat — treated
  // identically): active-direction repeat = no-op; axis at rest = start; axis
  // opposite = stop (stop-first). A held opposing key thus reverses on its next
  // OS repeat: tap = stop, hold = reverse. Intentional and timing-free.
  private onMovementLatch(key: string): void {
    const m = MOVE_LATCH[key]!
    const cur = this.latch[m.axis]
    if (cur === m.dir) return
    this.latch[m.axis] = cur === 0 ? m.dir : 0
  }

  // ---- Tier 2: per-class own-key handling ----------------------------------

  private onTurnEvent(key: string, now: number): void {
    const sign = key === 'right' ? 1 : -1
    // Opposite-direction event: instantly zero the other direction's pending
    // and kill its hold mode — a correction must never fight stale intent.
    if (Math.sign(this.turnPending) === -sign) this.turnPending = 0
    const other = this.turns.get(key === 'right' ? 'left' : 'right')
    if (other) other.hold = false

    const st = this.turns.get(key)
    const gap = st ? now - st.lastEvent : Infinity
    // Entry liveness: a follow-up event can only be the OS repeating within
    // the first-repeat band's upper edge; anything later is a fresh press.
    if (st === undefined || gap > this.holdBandMaxMs) {
      this.turns.set(key, { lastEvent: now, prevWasPress: true, hold: false })
      this.enqueueTurnQuantum(sign)
      return
    }
    if (st.hold && gap >= this.turnHoldDeathMs) st.hold = false // stale hold: died between samples
    const firstRepeat = st.prevWasPress && gap >= this.holdBandMinMs // ≤ holdBandMaxMs guaranteed above
    const steadyRepeat = gap <= this.turnSteadyGapMs
    if (st.hold) {
      // any own event inside the death window sustains an already-live hold
      st.prevWasPress = false
    } else if (firstRepeat || steadyRepeat) {
      // hold confirmation: this is the OS repeating, not a human re-tap —
      // clear this key's pending contribution and switch to continuous ±1.
      st.hold = true
      st.prevWasPress = false
      if (Math.sign(this.turnPending) === sign) this.turnPending = 0
    } else {
      // human re-tap (gap too long for a steady repeat, outside the
      // first-repeat band): a fresh tap that also restarts the press gap.
      st.prevWasPress = true
      this.enqueueTurnQuantum(sign)
    }
    st.lastEvent = now
  }

  private enqueueTurnQuantum(sign: number): void {
    const next = this.turnPending + sign * TURN_TAP_RAD
    this.turnPending = Math.max(-TURN_PENDING_CAP_RAD, Math.min(TURN_PENDING_CAP_RAD, next))
  }

  // ---- Tier 2: sampling helpers ---------------------------------------------

  // Turn axis: hold mode is continuous ±1; otherwise drain the pending tap
  // budget by exactly what this tick's rotation capacity allows. No easing on
  // either path — emitted rotation × TURN_TICK_RAD always equals the quanta
  // that were enqueued (minus explicit zeroing by opposite-direction events).
  private turnAxisTier2(now: number): number {
    let hold = 0
    for (const key of ['right', 'left'] as const) {
      const st = this.turns.get(key)
      if (!st?.hold) continue
      // Hold death: no event from THIS key within the window — turn holds are
      // never kept alive by other keys' events.
      if (now - st.lastEvent >= this.turnHoldDeathMs) st.hold = false
      else hold += key === 'right' ? 1 : -1
    }
    if (hold !== 0) return hold
    return this.drainTurnPending()
  }

  private drainTurnPending(): number {
    const p = this.turnPending
    if (p === 0) return 0
    if (Math.abs(p) <= TURN_TICK_RAD) {
      this.turnPending = 0 // emit the exact remainder; no FP residue left behind
      return p / TURN_TICK_RAD
    }
    this.turnPending = p - Math.sign(p) * TURN_TICK_RAD
    return Math.sign(p)
  }

  // Moves this axis's smoothed value toward `raw` by at most ATTACK_PER_TICK
  // (magnitude increasing) or RELEASE_PER_TICK (decreasing) per call. Called
  // once per 20Hz sim tick — steps are per-tick, not wall-clock scaled.
  private ease(axis: 'forward' | 'strafe', raw: number): number {
    const prev = this.smoothed[axis]
    const step = Math.abs(raw) > Math.abs(prev) ? ATTACK_PER_TICK : RELEASE_PER_TICK
    const next = prev + Math.max(-step, Math.min(step, raw - prev))
    this.smoothed[axis] = next
    return next
  }

  // ---- Tier 1 (kitty): real press/repeat/release ----------------------------

  private onKeyTier1(e: KeyEvent): void {
    if (e.kind === 'release') {
      if (TURN_KEYS.has(e.key)) {
        // release clears that direction's pending tap budget and (via the
        // held map) its hold mode
        const sign = e.key === 'right' ? 1 : -1
        if (Math.sign(this.turnPending) === sign) this.turnPending = 0
      }
      this.t1Held.delete(e.key)
      return
    }
    // 'repeat' is deliberately ignored: tier-1 state is driven by real
    // press/release truth — F2 makes repeats vanish under chords even here.
    if (e.kind !== 'press' || this.t1Held.has(e.key)) return
    if (TURN_KEYS.has(e.key)) this.enqueueTurnQuantum(e.key === 'right' ? 1 : -1)
    this.t1Held.set(e.key, this.now())
  }

  private t1BinaryAxis(pos: string[], neg: string[]): -1 | 0 | 1 {
    const p = pos.some((k) => this.t1Held.has(k))
    const n = neg.some((k) => this.t1Held.has(k))
    return p === n ? 0 : p ? 1 : -1
  }

  // Tier-1 turn: same two modes as tier 2, driven by truth instead of
  // repeats — press enqueues one quantum; still held after TIER1_TURN_HOLD_MS
  // means hold mode (±1) until release.
  private turnAxisTier1(now: number): number {
    const holdFor = (key: string): number => {
      const at = this.t1Held.get(key)
      return at === undefined ? -1 : now - at
    }
    const hold =
      (holdFor('right') >= TIER1_TURN_HOLD_MS ? 1 : 0) - (holdFor('left') >= TIER1_TURN_HOLD_MS ? 1 : 0)
    if (hold !== 0) return hold
    return this.drainTurnPending()
  }

  // ---- Sampling --------------------------------------------------------------

  sample(seq: number): PlayerInput {
    const now = this.now()
    // Mouse aim and fire are identical in both tiers (they never touch tier
    // state). makeInput clamps the keyboard+mouse turn sum to [-1, 1].
    const mouseTurn = this.mouseTurn()
    if (this.tier1) {
      return makeInput(seq, {
        forward: this.t1BinaryAxis(['w', 'up'], ['s', 'down']),
        strafe: this.t1BinaryAxis(['d'], ['a']),
        turn: this.turnAxisTier1(now) + mouseTurn,
        fire: this.t1Held.has(' ') || this.mouseFireHeld,
      })
    }
    return makeInput(seq, {
      forward: this.ease('forward', this.latch.forward),
      strafe: this.ease('strafe', this.latch.strafe),
      turn: this.turnAxisTier2(now) + mouseTurn,
      fire: now < this.fireUntil || this.mouseFireHeld,
    })
  }
}
