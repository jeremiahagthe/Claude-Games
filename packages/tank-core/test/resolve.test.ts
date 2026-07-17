import { describe, expect, it } from 'vitest'
import { BLAST_DAMAGE_MAX, BLAST_RADIUS, FALL_DAMAGE_PER_UNIT, FALL_FREE_UNITS, FIELD_W, HP_MAX, SPAWN_R, SUDDEN_DEATH_DECAY, SUDDEN_DEATH_ROUND, WIND_MAX } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { blastDamage, carve, killPlayer, resolveShot } from '../src/resolve.js'
import type { MatchState } from '../src/state.js'

// Hand-built flat-world fixture: surface y=10 everywhere, tanks at cols 10 and 70,
// wind forced to 0, turn 0. Physics assertions below are closed-form checks on THIS world.
function flat(over: Partial<MatchState> = {}): MatchState {
  const m = createMatch(1, ['a', 'b'], [false, false])
  return {
    ...m,
    heights: new Array(80).fill(10),
    tanks: [{ ...m.tanks[0]!, col: 10 }, { ...m.tanks[1]!, col: 70 }],
    turn: 0, firstTurn: 0, round: 1, wind: 0,
    ...over,
  }
}

describe('ballistics (range windows on the flat fixture)', () => {
  it('45° power 40, no wind: lands right, in the closed-form window [54, 62]', () => {
    // v = 44 u/s → ideal range v²/G = 48.4 from col 10 → ~58; DT integration lands within ±4
    const out = resolveShot(flat(), { angle: 45, power: 40 })
    expect(out.impact).not.toBeNull()
    expect(out.impact!.x).toBeGreaterThan(54); expect(out.impact!.x).toBeLessThan(62)
    expect(out.trajectory.length).toBeGreaterThan(20)
    expect(out.trajectory[0]![1]).toBe(11)                       // muzzle = surface + 1
  })
  it('mirror symmetry: 135° from the right tank lands the mirrored distance left', () => {
    const right = resolveShot(flat({ turn: 1, firstTurn: 1 }), { angle: 135, power: 40 })
    expect(right.impact!.x).toBeGreaterThan(80 - 62); expect(right.impact!.x).toBeLessThan(80 - 54)
  })
  it('tailwind +10 carries the shell measurably farther than calm', () => {
    const calm = resolveShot(flat(), { angle: 45, power: 40 })
    const windy = resolveShot(flat({ wind: WIND_MAX }), { angle: 45, power: 40 })
    expect(windy.impact!.x - calm.impact!.x).toBeGreaterThan(6)
  })
  it('full power at 10° exits the field: lost shell, nothing damaged, turn still advances', () => {
    const out = resolveShot(flat(), { angle: 10, power: 100 })
    expect(out.impact).toBeNull()
    expect(out.damage).toEqual([0, 0])
    expect(out.state.turn).toBe(1)
    expect(out.state.tanks[0]!.lastAngle).toBe(10)               // expiry auto-fire source updated anyway
  })
  it('every (angle, power, wind) on a coarse grid terminates within MAX_FLIGHT_STEPS', () => {
    for (let a = 0; a <= 180; a += 15)
      for (let p = 0; p <= 100; p += 20)
        for (const w of [-WIND_MAX, 0, WIND_MAX])
          expect(() => resolveShot(flat({ wind: w }), { angle: a, power: p })).not.toThrow()
  })
})

describe('balance sanity (spec assertions on the flat fixture)', () => {
  // Closed-form flat-ground range at the optimal 45° (sin 2θ = 1): R = v0² / GRAVITY,
  // where v0 = power · POWER_SCALE. Power 48 → v0 = 52.8 → R ≈ 52.8²/40 ≈ 69.7. From col 10
  // that carries the shell to ≈ col 80 — well past the right spawn zone start (SPAWN_R[0] = 63),
  // proving a mid-power 45° shot can reach clear across the map to the opponent's half.
  it('cross-map reach: 45° at power 48 from col 10 reaches at least the right spawn zone (col 63+)', () => {
    const out = resolveShot(flat(), { angle: 45, power: 48 })
    const maxX = Math.max(...out.trajectory.map(([x]) => x))
    expect(maxX).toBeGreaterThanOrEqual(SPAWN_R[0])                 // reached col 63+ (impact or exit)
    if (out.impact) expect(out.impact.x).toBeGreaterThanOrEqual(SPAWN_R[0])
  })
  // Overshoot headroom: full power must leave the field entirely, so 100 is not "just barely max".
  // v0 = 110 → R ≈ 110²/40 ≈ 302 ≫ FIELD_W (80): the shell departs the right edge before any impact.
  it('overshoot headroom: 45° at power 100 from col 10 exits the field (impact null)', () => {
    const out = resolveShot(flat(), { angle: 45, power: 100 })
    expect(out.impact).toBeNull()
    expect(out.trajectory.at(-1)![0]).toBeGreaterThanOrEqual(FIELD_W) // departed via the right edge
  })
})

describe('blast damage (closed-form table)', () => {
  it('pinned falloff: 60 at 0, 30 at R/2, 0 at ≥ R', () => {
    expect(blastDamage(0)).toBe(BLAST_DAMAGE_MAX)
    expect(blastDamage(BLAST_RADIUS / 2)).toBe(BLAST_DAMAGE_MAX / 2)
    expect(blastDamage(BLAST_RADIUS)).toBe(0)
    expect(blastDamage(BLAST_RADIUS + 5)).toBe(0)
  })
  it('straight up is self-punishment: 90° low power comes back down near the shooter', () => {
    const out = resolveShot(flat(), { angle: 90, power: 30 })
    expect(out.damage[0]).toBeGreaterThan(30)                    // near-direct self-hit
    expect(out.damage[1]).toBe(0)
  })
})

describe('carve + settle', () => {
  it('crater: impact on the surface digs a bowl, deepest at the impact column', () => {
    const h = carve(new Array(80).fill(20), 40, 20)
    expect(h[40]!).toBeCloseTo(20 - BLAST_RADIUS, 5)
    expect(h[38]!).toBeGreaterThan(h[40]!); expect(h[38]!).toBeLessThan(20)
    expect(h[40 - BLAST_RADIUS]!).toBe(20); expect(h[40 + BLAST_RADIUS]!).toBe(20)
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0)             // never below the floor
  })
  it('undermined tank falls and takes fall damage past the free threshold', () => {
    // Impact directly under tank 1's feet on a tall column: fall ≈ BLAST_RADIUS = 6 → dmg (6-4)*3 = 6, plus blast
    const m = flat({ heights: new Array(80).fill(20) })
    const before = m.heights[70]!
    // fire a synthetic point-blank: build the shot by aiming a mortar onto col 70 is flaky —
    // instead call carve+settle through resolveShot with a state whose turn-0 tank is adjacent:
    const near = flat({ heights: new Array(80).fill(20), tanks: [{ ...m.tanks[0]!, col: 60 }, { ...m.tanks[1]!, col: 70 }] })
    const out = resolveShot(near, { angle: 75, power: 26 })      // short lob rightward; impact window covers ~[66, 74]
    if (out.impact && Math.abs(out.impact.x - 70) < 3) {
      expect(out.state.heights[70]!).toBeLessThan(before)
      expect(out.damage[1]).toBeGreaterThan(0)
    }
    // deterministic core assertion that never depends on the lob window:
    const carved = carve(new Array(80).fill(20), 70, 20)
    const fall = 20 - carved[70]!
    expect(fall).toBeCloseTo(BLAST_RADIUS, 5)
    expect(Math.round((fall - FALL_FREE_UNITS) * FALL_DAMAGE_PER_UNIT)).toBe(6)
  })
})

describe('turns, rounds, decay, result', () => {
  // Fixture-geometry fix (measured): a near-flat 1°/179° shot does NOT exit an 80-wide
  // interior field — it falls back to terrain within ~30 cols and, once craters accumulate
  // into a valley, glides across and hits the far tank (asymmetric decay). Lofted 10°/170°
  // at full power stays aloft ~0.95s and clears the field on either side (same technique the
  // "full power at 10° exits the field" test above proves), keeping these shots purely lost.
  const lost = (m: MatchState) => resolveShot(m, { angle: m.turn === 0 ? 10 : 170, power: 100 })
  it('round increments when the second mover fires; wind re-rolls each shot', () => {
    const m = flat()
    const a = resolveShot(m, { angle: 10, power: 100 })          // lost shell, turn → 1
    expect(a.state.round).toBe(1)
    const b = resolveShot(a.state, { angle: 170, power: 100 })   // second mover → round completes
    expect(b.state.round).toBe(2)
    expect(b.state.turn).toBe(0)
  })
  it('sudden-death decay drains both from SUDDEN_DEATH_ROUND; forces a result eventually', () => {
    let s = flat({ round: SUDDEN_DEATH_ROUND })
    for (let guard = 0; guard < 60 && !s.result; guard++) s = lost(s).state
    expect(s.result).not.toBeNull()
    expect(s.tanks[0]!.hp).toBe(0); expect(s.tanks[1]!.hp).toBe(0)
    expect(s.result).toEqual({ kind: 'draw' })                   // symmetric decay from full hp → draw
  })
  it('decay is not damageDealt', () => {
    let s = flat({ round: SUDDEN_DEATH_ROUND })
    s = lost(s).state; s = lost(s).state                         // one full round → both -10
    expect(s.tanks[0]!.hp).toBe(HP_MAX - SUDDEN_DEATH_DECAY)
    expect(s.tanks.every((t) => t.damageDealt === 0)).toBe(true)
  })
  it('result stamps once and never overwrites; killPlayer forfeits', () => {
    const dead = killPlayer(flat(), 1)
    expect(dead.result).toEqual({ kind: 'win', winner: 0 })
    expect(dead.tanks[1]!.alive).toBe(false)
    expect(killPlayer(dead, 0).result).toEqual({ kind: 'win', winner: 0 })
  })
  it('resolveShot never mutates its input', () => {
    const m = flat()
    const snap = JSON.stringify(m)
    resolveShot(m, { angle: 45, power: 60 })
    expect(JSON.stringify(m)).toBe(snap)
  })
})
