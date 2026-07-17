import {
  ANGLE_MAX, ANGLE_MIN, BLAST_DAMAGE_MAX, BLAST_RADIUS, DT, FALL_DAMAGE_PER_UNIT, FALL_FREE_UNITS,
  FIELD_W, GRAVITY, MAX_FLIGHT_STEPS, POWER_MAX, POWER_MIN, POWER_SCALE, SUDDEN_DEATH_DECAY,
  SUDDEN_DEATH_ROUND, TANK_HIT_RADIUS, WIND_ACCEL,
} from './constants.js'
import { muzzle, rollWind } from './state.js'
import type { MatchState, Shot, Tank } from './state.js'

export interface ResolveOut {
  state: MatchState
  trajectory: [number, number][]        // world [x,y] per DT step, muzzle first
  impact: { x: number; y: number } | null  // null = lost shell (left the field / step cap)
  damage: [number, number]              // total hp lost this shot per tank id (blast + fall + decay)
}

const clampInt = (v: number, lo: number, hi: number): number => Math.round(Math.max(lo, Math.min(hi, v)))

// blastDamage: round(BLAST_DAMAGE_MAX * max(0, 1 - dist/BLAST_RADIUS))
export function blastDamage(dist: number): number {
  return Math.round(BLAST_DAMAGE_MAX * Math.max(0, 1 - dist / BLAST_RADIUS))
}

// carve: crater bowl, pure. For each col c with |c - ix| < BLAST_RADIUS:
// chord = sqrt(R² - (c-ix)²); h' = max(0, min(heights[c], iy - chord)).
export function carve(heights: number[], ix: number, iy: number): number[] {
  const out = heights.slice()
  for (let c = 0; c < out.length; c++) {
    const dx = c - ix
    if (Math.abs(dx) < BLAST_RADIUS) {
      const chord = Math.sqrt(BLAST_RADIUS * BLAST_RADIUS - dx * dx)
      out[c] = Math.max(0, Math.min(out[c]!, iy - chord))
    }
  }
  return out
}

// killPlayer: forfeit — target tank alive=false; stamp win for the other (once, never overwritten).
export function killPlayer(m: MatchState, id: number): MatchState {
  const tanks = m.tanks.map((t) => (t.id === id ? { ...t, alive: false } : { ...t })) as [Tank, Tank]
  const other = id === 0 ? 1 : 0
  const result = m.result ?? { kind: 'win' as const, winner: other }
  return { ...m, tanks, result }
}

export function resolveShot(m: MatchState, shot: Shot): ResolveOut {
  // Input clamping: angle/power clamped to range and rounded to integers on entry.
  const angle = clampInt(shot.angle, ANGLE_MIN, ANGLE_MAX)
  const power = clampInt(shot.power, POWER_MIN, POWER_MAX)

  const shooterId = m.turn
  const heights = m.heights // read-only during flight (pre-carve)
  const [mx, my] = muzzle(m, shooterId)
  const rad = (angle * Math.PI) / 180
  let vx = Math.cos(rad) * power * POWER_SCALE
  let vy = Math.sin(rad) * power * POWER_SCALE
  let x = mx
  let y = my

  const trajectory: [number, number][] = [[x, y]] // muzzle first
  let impact: { x: number; y: number } | null = null
  let leftMuzzle = false // shooter immune until shell once > 2·TANK_HIT_RADIUS from its muzzle

  // Phase 1: Integrate (semi-implicit Euler)
  for (let step = 0; step < MAX_FLIGHT_STEPS; step++) {
    vx += m.wind * WIND_ACCEL * DT
    vy -= GRAVITY * DT
    x += vx * DT
    y += vy * DT
    trajectory.push([x, y])

    // (a) left the field → lost shell
    if (x < 0 || x >= FIELD_W) { impact = null; break }

    // IEEE-exact distance: sqrt(dx²+dy²), NOT Math.hypot — hypot's result varies across V8
    // versions, so client Node vs server workerd would diverge and trip the desync tripwire.
    if (!leftMuzzle && Math.sqrt((x - mx) * (x - mx) + (y - my) * (y - my)) > 2 * TANK_HIT_RADIUS) leftMuzzle = true

    // (b) tank contact
    let contact = false
    for (const t of m.tanks) {
      if (!t.alive) continue
      if (t.id === shooterId && !leftMuzzle) continue
      const cx = t.col
      const cy = heights[t.col]! + 1
      if (Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) <= TANK_HIT_RADIUS) { contact = true; break }
    }
    if (contact) { impact = { x, y }; break }

    // (c) terrain
    const col = Math.min(79, Math.max(0, Math.round(x)))
    if (y <= heights[col]!) { impact = { x, y }; break }

    // (d) y <= 0 safety
    if (y <= 0) { impact = { x, y }; break }

    // (e) step cap handled by loop bound → impact stays null (lost shell)
  }

  // Working copies (never mutate inputs)
  const tanks = m.tanks.map((t) => ({ ...t })) as [Tank, Tank]
  let newHeights = m.heights.slice()
  const damage: [number, number] = [0, 0]        // total hp lost this shot per tank id
  const blastFallLoss: [number, number] = [0, 0] // phases 3-4 only (feeds damageDealt)

  if (impact) {
    const ix = Math.min(79, Math.max(0, Math.round(impact.x)))
    const iy = impact.y

    // Phase 2: Carve
    newHeights = carve(m.heights, ix, iy)

    // Phase 3: Damage (blast). preCarveY = heights BEFORE carving.
    for (const t of tanks) {
      if (!t.alive) continue
      const preCarveY = m.heights[t.col]!
      const d = Math.sqrt((t.col - ix) * (t.col - ix) + (preCarveY + 1 - iy) * (preCarveY + 1 - iy))
      const dmg = blastDamage(d)
      t.hp -= dmg
      damage[t.id as 0 | 1] += dmg
      blastFallLoss[t.id as 0 | 1] += dmg
    }

    // Phase 4: Settle (fall damage)
    for (const t of tanks) {
      if (!t.alive) continue
      const fall = m.heights[t.col]! - newHeights[t.col]!
      if (fall > FALL_FREE_UNITS) {
        const dmg = Math.round((fall - FALL_FREE_UNITS) * FALL_DAMAGE_PER_UNIT)
        t.hp -= dmg
        damage[t.id as 0 | 1] += dmg
        blastFallLoss[t.id as 0 | 1] += dmg
      }
    }
  }

  // Phase 5: Bookkeeping (runs for lost shells too)
  const shooter = tanks[shooterId]!
  shooter.lastAngle = angle
  shooter.lastPower = power
  shooter.shotsFired += 1
  const opponentId = shooterId === 0 ? 1 : 0
  shooter.damageDealt += blastFallLoss[opponentId]

  let rng = m.rng
  let round = m.round
  const turn: 0 | 1 = shooterId === 0 ? 1 : 0

  if (turn === m.firstTurn) {
    // round just completed
    if (round >= SUDDEN_DEATH_ROUND) {
      for (const t of tanks) {
        if (t.alive) {
          t.hp -= SUDDEN_DEATH_DECAY
          damage[t.id as 0 | 1] += SUDDEN_DEATH_DECAY // counted into damage, NOT damageDealt
        }
      }
    }
    round += 1
  }

  // Re-roll wind (one rollWind draw)
  const wr = rollWind(rng)
  const wind = wr.wind
  rng = wr.rng

  // Floor hp at 0, recompute alive
  for (const t of tanks) {
    t.hp = Math.max(0, t.hp)
    t.alive = t.hp > 0
  }

  // Stamp result once, never overwrite
  let result = m.result
  if (!result) {
    const dead0 = tanks[0]!.hp <= 0
    const dead1 = tanks[1]!.hp <= 0
    if (dead0 && dead1) result = { kind: 'draw' }
    else if (dead0) result = { kind: 'win', winner: 1 }
    else if (dead1) result = { kind: 'win', winner: 0 }
  }

  const state: MatchState = {
    ...m,
    heights: newHeights,
    tanks,
    turn,
    round,
    wind,
    rng,
    result,
  }

  return { state, trajectory, impact, damage }
}
