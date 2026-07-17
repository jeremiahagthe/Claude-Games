import { GRAVITY, POWER_MAX, POWER_MIN, POWER_SCALE, ANGLE_MIN, ANGLE_MAX, WIND_ACCEL } from './constants.js'
import { randStep } from './prng.js'
import type { MatchState, Shot } from './state.js'

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface BotMind {
  rng: number
  lastShot: Shot | null
  lastImpactX: number | null
}

interface Knobs {
  powerHalf: number   // uniform ± half-width applied multiplicatively to power
  angleHalf: number   // uniform ± half-width added to angle, in degrees
  gain: number        // bracketing correction gain (< 1 for stable brackets)
  wind: boolean       // first-order wind compensation on the first shot
  opener: number      // OPENER_SCALE: first shot deliberately targets opener·dist
}

const KNOBS: Record<Difficulty, Knobs> = {
  easy: { powerHalf: 0.30, angleHalf: 8, gain: 0.3, wind: false, opener: 0.55 },
  // normal gain/noise retuned from the brief's 0.7/±12%/±3° to meet the duel +
  // convergence gates with margin (measured: median 13, selfKills 2/20, convFail 0):
  normal: { powerHalf: 0.06, angleHalf: 1, gain: 0.4, wind: false, opener: 0.70 },
  hard: { powerHalf: 0.05, angleHalf: 1, gain: 0.9, wind: true, opener: 0.90 },
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function createBotMind(seed: number): BotMind {
  return { rng: seed >>> 0, lastShot: null, lastImpactX: null }
}

// Callers record the outcome of the bot's own shot after resolving it.
export function botObserve(mind: BotMind, shot: Shot, impactX: number | null): BotMind {
  return { rng: mind.rng, lastShot: shot, lastImpactX: impactX }
}

export function botDecide(
  m: MatchState,
  id: number,
  mind: BotMind,
  d: Difficulty,
): { shot: Shot; mind: BotMind } {
  const k = KNOBS[d]
  const self = m.tanks[id]!
  const target = m.tanks[id === 0 ? 1 : 0]!

  const delta = target.col - self.col
  const dir = delta >= 0 ? 1 : -1                 // +1 = shooting right, -1 = shooting left
  const dist = Math.abs(delta)
  const baseAngle = dir >= 0 ? 60 : 120           // elevation 60° on either side
  const rad = (baseAngle * Math.PI) / 180
  // level-ground range: |R| = v² · |sin(2θ)| / g  →  v = sqrt(R·g / |sin(2θ)|)
  const s2 = Math.max(1e-6, Math.abs(Math.sin(2 * rad)))

  let power: number

  if (mind.lastShot === null) {
    // First shot: closed-form muzzle velocity for a DELIBERATELY SHORTENED
    // distance (OPENER_SCALE · dist) — ranges in without cratering the target.
    const openDist = k.opener * dist
    let v = Math.sqrt((openDist * GRAVITY) / s2)
    if (k.wind) {
      // one fixed-point iteration for time of flight from the no-wind v
      const t = (2 * v * Math.sin(rad)) / GRAVITY
      const drift = 0.5 * m.wind * WIND_ACCEL * t * t   // world +x displacement from wind
      const distEff = Math.max(2, openDist - drift * dir) // subtract drift measured along the shot
      v = Math.sqrt((distEff * GRAVITY) / s2)
    }
    power = v / POWER_SCALE
  } else {
    // Bracketing correction. err signed along the shot direction: overshoot > 0.
    // Lost shell → treat as a max-range overshoot in the shot direction.
    const errDir = mind.lastImpactX === null ? 20 : (mind.lastImpactX - target.col) * dir
    // range ∝ v²: overshoot shrinks power, undershoot grows it; gain < 1 brackets stably.
    power = mind.lastShot.power * (1 - (k.gain * errDir) / Math.max(dist, 8))
  }

  // Difficulty noise: two randStep draws, always both, threading mind.rng.
  let rng = mind.rng
  const p = randStep(rng)
  rng = p.next
  power *= 1 + (2 * p.value - 1) * k.powerHalf

  const a = randStep(rng)
  rng = a.next
  const angle = baseAngle + (2 * a.value - 1) * k.angleHalf

  // Wire protocol validates angle/power as integers and the server broadcasts
  // bot shots verbatim — round first, then clamp (so 180.4 → 180).
  const shot: Shot = {
    angle: clamp(Math.round(angle), ANGLE_MIN, ANGLE_MAX),
    power: clamp(Math.round(power), POWER_MIN, POWER_MAX),
  }
  return { shot, mind: { rng, lastShot: mind.lastShot, lastImpactX: mind.lastImpactX } }
}
