import { makeInput, type PlayerInput } from '@fragwait/core'
import { FACTORY_TIMINGS, type OsKeyTimings } from './os-timings.js'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

// Three key classes with different tier-2 models (feel iteration 5):
// - TURN keys are event-driven two-mode (tap quanta / OS-repeat-confirmed
//   hold), unchanged. No envelope, no easing — budget conservation makes "one
//   tap = exactly TURN_TAP_RAD of rotation" literally true in the sim. Mouse
//   motion deltas feed the SAME pending budget (see onMouseMotion).
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

// --- Mouse look (1:1 relative delta, active in BOTH tiers) ------------------
// Pointer MOTION drives the view: each event's horizontal delta (in cells) adds
// dx·MOUSE_SENS radians to the shared pending-turn budget, so the view follows
// the hand and STOPS when the hand stops (no residual joystick spin). Budget
// drains through the same TURN_TICK_RAD pipe, so TURN_SPEED still caps the rate.
const MOUSE_SENS = 0.025 // rad/cell — the mouse-look sensitivity tunable
// Per-event delta clamp: swallows pointer teleports (window re-entry, focus
// jumps) that would otherwise snap the view by hundreds of cells at once.
const MOUSE_DX_CLAMP = 8
// Mouse-fed budget saturation: a stale look backlog is worse than a dropped
// one, so a mouse contribution never leaves more than this banked. Keyboard tap
// quanta are exempt (see enqueueTurnQuantum) — they are intentional units.
const MOUSE_SATURATION_RAD = 0.35
// Screen-edge turn zones (RTS-style): a pointer parked within EDGE_COLS of an
// edge turns the view at a constant axis every tick, so 360° turns work without
// pointer lock. A parked pointer emits no events, so this reads stored state.
const EDGE_COLS = 2
const EDGE_TURN_AXIS = 0.6

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

  // Mouse look/walk/fire (shared by both tiers). offline.ts owns geometry and
  // passes raw pointer x (in cells) plus the current viewCols per event.
  private lastMouseX: number | null = null // null until first event → no delta
  private lastViewCols = 0 // viewCols seen on the last event (edge-zone test)
  private walkHeld = false // right/middle mouse button held → forward override
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
  // latches, walk-hold, mouse-fire state, fire latch, smoothed axes) and the
  // stored mouse position. Called from enableTier1() and on self-death: a
  // respawn or tier switch must not drain stale turn budget, keep walking into
  // the new facing, or replay a stale pointer delta. Deliberately does NOT clear
  // the tier-1 physical held map (those keys are ground truth — their releases
  // will arrive).
  resetTransient(): void {
    this.latch = { forward: 0, strafe: 0 }
    this.walkHeld = false
    this.mouseFireHeld = false
    this.turns.clear()
    this.turnPending = 0
    this.fireUntil = -Infinity
    this.smoothed = { forward: 0, strafe: 0 }
    this.resetMousePosition()
  }

  // ---- Mouse look + walk + fire (shared by both tiers) ----------------------

  // 1:1 relative look: every position-bearing event (motion AND press/release)
  // feeds its horizontal delta into the shared pending-turn budget. The first
  // event after a reset only stores position (no phantom delta); later events
  // add dx·MOUSE_SENS, dx clamped to swallow teleports. viewCols is stashed for
  // the edge-zone test. Saturation clamps only the mouse contribution.
  onMouseMotion(x: number, viewCols: number): void {
    this.lastViewCols = viewCols
    if (this.lastMouseX === null) {
      this.lastMouseX = x
      return
    }
    const dx = Math.max(-MOUSE_DX_CLAMP, Math.min(MOUSE_DX_CLAMP, x - this.lastMouseX))
    this.lastMouseX = x
    const next = this.turnPending + dx * MOUSE_SENS
    this.turnPending = Math.max(-MOUSE_SATURATION_RAD, Math.min(MOUSE_SATURATION_RAD, next))
  }

  // Clears the stored pointer position so the next event stores without a
  // delta; the edge-zone state (which reads lastMouseX) clears with it.
  resetMousePosition(): void {
    this.lastMouseX = null
  }

  // Left button reports REAL press AND release → fire. Right/middle → hold-to-
  // walk (some terminals reserve right-click for a context menu, middle is the
  // fallback). Motion actions never toggle either.
  onMouseButton(button: 'left' | 'middle' | 'right' | 'none', action: 'press' | 'release' | 'motion'): void {
    if (button === 'left') {
      if (action === 'press') this.mouseFireHeld = true
      else if (action === 'release') this.mouseFireHeld = false
      return
    }
    if (button === 'right' || button === 'middle') {
      if (action === 'press') this.walkHeld = true
      else if (action === 'release') this.walkHeld = false
    }
  }

  // Edge-zone turn contribution from stored state (a parked pointer emits no
  // events): ±EDGE_TURN_AXIS toward whichever edge the pointer sits within, 0
  // otherwise. Uses the viewCols from the most recent event.
  private edgeTurn(): number {
    if (this.lastMouseX === null) return 0
    if (this.lastMouseX <= EDGE_COLS) return -EDGE_TURN_AXIS
    if (this.lastMouseX >= this.lastViewCols - 1) return EDGE_TURN_AXIS
    return 0
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
    // Keyboard taps keep their feel-4 budget-conserving cap (±0.24): five taps
    // bank at most four. But a tap is an intentional unit, so it is never
    // clamped DOWN a budget the mouse has already inflated past the cap in the
    // tap's own direction — it adds on top (the mouse saturation rule owns that
    // ceiling, not this one).
    if (Math.abs(this.turnPending) > TURN_PENDING_CAP_RAD && Math.sign(next) === Math.sign(this.turnPending)) {
      this.turnPending = next
      return
    }
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
    // Mouse look/walk/fire are identical in both tiers (they never touch tier
    // state). The edge-zone axis adds to the drained budget; makeInput clamps
    // the turn sum to [-1, 1]. A held walk-button overrides the forward source
    // (latch in tier 2, binary axis in tier 1) without modifying it.
    const edge = this.edgeTurn()
    if (this.tier1) {
      return makeInput(seq, {
        forward: this.walkHeld ? 1 : this.t1BinaryAxis(['w', 'up'], ['s', 'down']),
        strafe: this.t1BinaryAxis(['d'], ['a']),
        turn: this.turnAxisTier1(now) + edge,
        fire: this.t1Held.has(' ') || this.mouseFireHeld,
      })
    }
    return makeInput(seq, {
      forward: this.ease('forward', this.walkHeld ? 1 : this.latch.forward),
      strafe: this.ease('strafe', this.latch.strafe),
      turn: this.turnAxisTier2(now) + edge,
      fire: now < this.fireUntil || this.mouseFireHeld,
    })
  }
}
