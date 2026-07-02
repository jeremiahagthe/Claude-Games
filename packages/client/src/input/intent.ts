import { makeInput, type PlayerInput } from '@fragwait/core'
import { FACTORY_TIMINGS, type OsKeyTimings } from './os-timings.js'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Three key classes with different tier-2 models (feel iteration 4):
// - TURN keys are event-driven two-mode (tap quanta / OS-repeat-confirmed
//   hold). No envelope, no easing — budget conservation makes "one tap =
//   exactly TURN_TAP_RAD of rotation" literally true in the sim.
// - MOVEMENT keys are hold-inferred with phase windows (press → first repeat
//   is a much longer gap than repeat → repeat) plus cross-key keep-alive,
//   because macOS auto-repeats only the most recently pressed key (F2): an
//   older, still-physically-held key produces no further events, ever.
// - FIRE (space) is a per-event latch: no hold inference at all.
const TURN_KEYS = new Set(['left', 'right'])
const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'up', 'down'])

// Movement opposition pairs for the stop-first rule, and the smoothed axis
// each pair rides on (a press-classified press instantly clears an opposing
// live hold and snaps that axis to 0: tap-S = instant stop, hold-S = reverse).
const OPPOSING: Record<string, string> = { w: 's', s: 'w', a: 'd', d: 'a', up: 'down', down: 'up' }
const MOVE_AXIS: Record<string, 'forward' | 'strafe'> = {
  w: 'forward', s: 'forward', up: 'forward', down: 'forward', a: 'strafe', d: 'strafe',
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

// --- Movement envelope constants --------------------------------------------
// A movement hold's envelope is 1.0 until TAPER_MS before its expiry, then
// tapers linearly to 0 at expiry (replaces the old taperStartFor/decayFor).
const TAPER_MS = 120
// Per-20Hz-tick easing on movement axes only (turn is never eased).
const ATTACK_PER_TICK = 0.55
const RELEASE_PER_TICK = 0.3
// Stop-first: an opposing press registers provisionally — long enough to read
// as an intentional reverse only if the OS confirms the key is held.
const PROVISIONAL_MS = 150
// A movement key stops receiving cross-grants from NON-movement sources
// (space/turn) once its own last event is older than this: bounds phantom
// slide while standing and firing. Grants sourced from a currently-held
// movement key are exempt — the tracker cannot distinguish "W+D both held"
// from "W released while D held" (F2 keeps W silent either way), and uncapped
// movement-source grants favor the far more common real-diagonal intent (S3);
// the rare phantom diagonal after releasing one chord key is instantly
// escapable via the stop-first opposing press.
const CROSS_GRANT_SELF_CAP_MS = 1500

// --- Fire -------------------------------------------------------------------
// Every space event latches fire for this long. Blaster cooldown is 500ms, so
// a 250ms latch per event costs nothing while killing both fire starvation
// under F2 and phantom rail shots from stale hold state.
const FIRE_LATCH_MS = 250

// --- Tier 1 -----------------------------------------------------------------
// Tier-1 turn: a key still held (no release) this long after its press enters
// hold mode (±1); a shorter press was a tap (one quantum).
const TIER1_TURN_HOLD_MS = 150

interface MoveHold {
  expiresAt: number // envelope end (own-event window, possibly cross-granted)
  lastSelfEvent: number // last event from THIS key (grants don't touch this)
  sawRepeatThisHold: boolean // phase A (bridging press→first-repeat) vs B (repeat→repeat)
  provisional: boolean // stop-first opposing press awaiting hold confirmation
}

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
  private readonly phaseAMs: number // bridges press → first repeat
  private readonly steadyMs: number // bridges repeat → repeat
  private readonly holdBandMinMs: number // first-repeat confirmation band (lower)
  private readonly holdBandMaxMs: number // first-repeat confirmation band (upper)
  private readonly turnSteadyGapMs: number // turn: gap ≤ this = the OS repeating
  private readonly turnHoldDeathMs: number // turn hold dies with no own event for this long
  private readonly repeatGrantMs: number // cross-grant from a repeat-classified event

  // Tier-2 state
  private moveHolds = new Map<string, MoveHold>()
  private turns = new Map<string, TurnState>()
  private turnPending = 0 // signed rad budget: right +, left −; at most one sign live
  private fireUntil = -Infinity
  private smoothed: Record<'forward' | 'strafe', number> = { forward: 0, strafe: 0 }

  // Tier-1 state (kitty protocol: real press/repeat/release)
  private tier1 = false
  private t1Held = new Map<string, number>() // key -> pressed-at (ms)

  constructor(private now: () => number, opts: { timings?: OsKeyTimings } = {}) {
    const t = opts.timings ?? FACTORY_TIMINGS
    // PHASE_A margin choice: initialDelay×1.15 + 80 (≈655ms at factory), the
    // brief's smaller variant. Taper then starts at initialDelay×1.15 − 40,
    // which is AFTER the first repeat (≈initialDelay) whenever initialDelay >
    // 267ms — at factory: 535 > 500, so an on-time first repeat lands while
    // the envelope is still 1.0 (pinned in a test). A late first repeat
    // (jitter) lands on the taper's early portion (envelope ≈0.79 at +60ms)
    // and re-arms fully — a sub-tick dip at worst. Preferred over the +140
    // variant because releases die 60ms sooner (less phantom slide per tap).
    this.phaseAMs = t.initialDelayMs * 1.15 + 80
    this.steadyMs = Math.min(900, Math.max(120, t.repeatIntervalMs * 1.6 + 40))
    // First-repeat confirmation band [0.9, 1.25]×initialDelay: asymmetric on
    // purpose. The OS's first repeat is never early, so 0.9 (not the naive
    // 0.75) keeps a 400ms human re-tap press-classified at factory settings
    // ([450, 625]) while the ~500ms first repeat still confirms a hold.
    this.holdBandMinMs = t.initialDelayMs * 0.9
    this.holdBandMaxMs = t.initialDelayMs * 1.25
    this.turnSteadyGapMs = Math.max(120, 1.3 * t.repeatIntervalMs)
    this.turnHoldDeathMs = Math.max(2 * t.repeatIntervalMs, 180)
    this.repeatGrantMs = Math.max(350, 2 * t.repeatIntervalMs)
  }

  enableTier1(): void {
    this.tier1 = true
    this.t1Held.clear() // tier-2 entries have no reliable release; start clean
    this.resetTransient()
  }

  // Clears everything inferred/latched (turn budgets + hold modes, movement
  // holds incl. provisional entries and phase flags, fire latch, smoothed
  // axes). Called from enableTier1() and on self-death: a respawn must not
  // drain stale turn budget into the new facing. Deliberately does NOT clear
  // the tier-1 physical held map — those keys are ground truth (their
  // releases will arrive), and a key still held across a respawn is live
  // intent, not residue.
  resetTransient(): void {
    this.moveHolds.clear()
    this.turns.clear()
    this.turnPending = 0
    this.fireUntil = -Infinity
    this.smoothed = { forward: 0, strafe: 0 }
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return // untracked keys never touch state — including keep-alive
    if (this.tier1) {
      this.onKeyTier1(e)
      return
    }
    if (e.kind === 'release') return // tier 2: legacy terminals never send releases
    // Tier 2: every non-release event ('press' covers both physical presses
    // and OS auto-repeats — Apple Terminal can't tell them apart, so we
    // classify by tracker state: press-classified = no live entry).
    const now = this.now()
    const pressClassified = this.handleOwnKeyTier2(e.key, now)
    this.grantKeepAlive(e.key, pressClassified, now)
  }

  // ---- Tier 2: per-class own-key handling ----------------------------------

  private handleOwnKeyTier2(key: string, now: number): boolean {
    if (TURN_KEYS.has(key)) return this.onTurnEvent(key, now)
    if (MOVEMENT_KEYS.has(key)) return this.onMovementEvent(key, now)
    // space: the fire latch itself is the entry — live while the latch holds.
    const pressClassified = now >= this.fireUntil
    this.fireUntil = now + FIRE_LATCH_MS
    return pressClassified
  }

  private onTurnEvent(key: string, now: number): boolean {
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
      return true
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
    return false
  }

  private enqueueTurnQuantum(sign: number): void {
    const next = this.turnPending + sign * TURN_TAP_RAD
    this.turnPending = Math.max(-TURN_PENDING_CAP_RAD, Math.min(TURN_PENDING_CAP_RAD, next))
  }

  private onMovementEvent(key: string, now: number): boolean {
    let h = this.moveHolds.get(key)
    if (h && now >= h.expiresAt) {
      this.moveHolds.delete(key)
      h = undefined
    }
    if (h === undefined) {
      // Press-classified (fresh press after full expiry).
      // Stop-first: clear an opposing live hold and snap the shared axis to 0;
      // this press then only registers provisionally — a tap-to-stop must not
      // read as a sustained reverse until the OS proves the key is held.
      const opp = this.moveHolds.get(OPPOSING[key]!)
      const opposingLive = opp !== undefined && now < opp.expiresAt
      if (opposingLive) {
        this.moveHolds.delete(OPPOSING[key]!)
        this.smoothed[MOVE_AXIS[key]!] = 0
      }
      this.moveHolds.set(key, {
        expiresAt: now + (opposingLive ? PROVISIONAL_MS : this.phaseAMs),
        lastSelfEvent: now,
        sawRepeatThisHold: false,
        provisional: opposingLive,
      })
      return true
    }
    // Repeat-classified own event on a live entry.
    const gap = now - h.lastSelfEvent
    if (h.provisional) {
      // The OS cannot repeat faster than initialDelay (≥ the 150ms clamp
      // floor), so any own event within the provisional window is human — a
      // real reverse intent: upgrade to a normal phase-A hold.
      h.provisional = false
      h.sawRepeatThisHold = false
      h.expiresAt = now + this.phaseAMs
    } else {
      // Plausible OS-repeat gap: steady cadence, or (only while still in
      // phase A) the first repeat landing in the initialDelay band. An
      // implausible gap means the repeat chain broke — the key was released
      // and re-pressed (or starved by F2 and re-pressed) — so this is a NEW
      // physical hold: back to phase A, or the fresh press would die inside
      // the next 500ms initial-repeat gap (the F3 sawtooth, again).
      const plausible =
        gap <= 1.6 * this.steadyMs ||
        (!h.sawRepeatThisHold && gap >= this.holdBandMinMs && gap <= this.holdBandMaxMs)
      h.sawRepeatThisHold = plausible
      // A window must bridge its gap at FULL strength (the S1/S3 ground-truth
      // traces assert ≥0.9 at every mid-chain tick). PHASE_A already contains
      // its taper: taper start = initialDelay×1.15 − 40 lands after the first
      // repeat (535 > 500 at factory). STEADY (≈173ms) minus the 120ms taper
      // would leave only ~53ms of full strength — less than the 83ms repeat
      // gap — so phase B appends the taper AFTER the bridge instead of inside
      // it: full strength spans repeat → repeat (surviving even one dropped
      // repeat), then the taper is the release tail.
      h.expiresAt = now + (plausible ? this.steadyMs + TAPER_MS : this.phaseAMs)
    }
    h.lastSelfEvent = now
    return false
  }

  // Cross-key keep-alive (F2): any tracked-key event proves the user's hands
  // are on the keyboard, so every OTHER currently-held movement key gets its
  // expiry extended — the OS has silenced those keys, not the user. Turn keys
  // and space are never granted (turn: a stalled turn is re-pressable, a
  // phantom spin while aiming is fatal; space: the fire latch is per-event).
  private grantKeepAlive(sourceKey: string, pressClassified: boolean, now: number): void {
    // A movement source's own entry was registered/refreshed this same event,
    // so it is always live here — movement sources are exempt from the
    // self-event cap (see CROSS_GRANT_SELF_CAP_MS).
    const capped = !MOVEMENT_KEYS.has(sourceKey)
    const grant = pressClassified ? this.phaseAMs : this.repeatGrantMs
    for (const [key, h] of this.moveHolds) {
      if (key === sourceKey) continue
      if (now >= h.expiresAt) {
        this.moveHolds.delete(key)
        continue
      }
      // A provisional stop-tap must expire on its own terms: keeping it alive
      // via a chord partner's repeats would turn every stop-tap into a
      // sustained phantom reverse. Its own next event upgrades it instead.
      if (h.provisional) continue
      if (capped && now - h.lastSelfEvent > CROSS_GRANT_SELF_CAP_MS) continue
      h.expiresAt = Math.max(h.expiresAt, now + grant)
    }
  }

  // ---- Tier 2: sampling helpers ---------------------------------------------

  // Movement envelope: 1.0 until TAPER_MS before expiry, linear to 0 at expiry.
  private moveEnvelope(key: string, now: number): number {
    const h = this.moveHolds.get(key)
    if (!h) return 0
    const remaining = h.expiresAt - now
    if (remaining <= 0) {
      this.moveHolds.delete(key)
      return 0
    }
    return remaining >= TAPER_MS ? 1 : remaining / TAPER_MS
  }

  private maxEnvelope(keys: string[], now: number): number {
    let m = 0
    for (const k of keys) m = Math.max(m, this.moveEnvelope(k, now))
    return m
  }

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
    if (this.tier1) {
      return makeInput(seq, {
        forward: this.t1BinaryAxis(['w', 'up'], ['s', 'down']),
        strafe: this.t1BinaryAxis(['d'], ['a']),
        turn: this.turnAxisTier1(now),
        fire: this.t1Held.has(' '),
      })
    }
    const forwardRaw = this.maxEnvelope(['w', 'up'], now) - this.maxEnvelope(['s', 'down'], now)
    const strafeRaw = this.moveEnvelope('d', now) - this.moveEnvelope('a', now)
    return makeInput(seq, {
      forward: this.ease('forward', Math.max(-1, Math.min(1, forwardRaw))),
      strafe: this.ease('strafe', Math.max(-1, Math.min(1, strafeRaw))),
      turn: this.turnAxisTier2(now),
      fire: now < this.fireUntil,
    })
  }
}
