import { describe, expect, it } from 'vitest'
import { castWall, fireHitscan } from '../src/combat.js'
import { parseMap } from '../src/map.js'
import type { MatchState, PlayerState } from '../src/types.js'

const HALL = parseMap('hall', 'Hall', [
  '############',
  '#SSSSSSSS..#',
  '#..........#',
  '#....#.....#',
  '#.......R..#',
  '############',
].join('\n'))

function player(id: string, x: number, y: number, dir = 0): PlayerState {
  return { id, handle: id, bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

function state(...players: PlayerState[]): MatchState {
  const rec: Record<string, PlayerState> = {}
  for (const p of players) rec[p.id] = p
  return { tick: 0, timeLeftTicks: 3600, mapId: 'hall', players: rec, rail: { pos: HALL.railSpawn, present: true, respawnTimer: 0 }, kills: [] }
}

describe('castWall', () => {
  it('measures distance to a wall', () => {
    const r = castWall(HALL, 1.5, 2.5, 0) // +x, wall at x=11
    expect(r.dist).toBeCloseTo(11 - 1.5, 1)
    expect(r.side).toBe(0)
  })
  it('hits the pillar', () => {
    const r = castWall(HALL, 1.5, 3.5, 0) // pillar cell at x=5,y=3
    expect(r.dist).toBeCloseTo(5 - 1.5, 1)
  })
})

describe('fireHitscan', () => {
  it('hits a player straight ahead', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 2.5))
    expect(fireHitscan('a', s, HALL)).toBe('b')
  })
  it('nearest target wins', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 2.5), player('c', 5.5, 2.5))
    expect(fireHitscan('a', s, HALL)).toBe('c')
  })
  it('walls block shots', () => {
    const s = state(player('a', 2.5, 3.5, 0), player('b', 8.5, 3.5)) // pillar between
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
  it('misses when aim is off by more than HIT_RADIUS', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 1.3))
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
  it('never hits self or the dead', () => {
    const dead = player('b', 8.5, 2.5)
    dead.hp = 0
    const s = state(player('a', 2.5, 2.5, 0), dead)
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
})

// Open box so the aimed ray reaches an off-axis target with no wall in the way.
const OPEN = parseMap('open', 'Open', [
  '################',
  '#SSSSSSSS......#',
  '#..............#',
  '#..............#',
  '#..............#',
  '#............R.#',
  '################',
].join('\n'))

describe('fireHitscan cursor aim (aimOffset)', () => {
  // Shooter faces dir 0 (+x); target sits 0.3 rad off that axis, in range:
  // y = 2.5 + 5·tan(0.3), 5 cells ahead. Head-on the perpendicular miss is
  // ~1.5 cells (≫ HIT_RADIUS); an aimOffset of 0.3 steers the ray onto it.
  const OFFSET = 0.3
  const target = () => player('b', 7.5, 2.5 + 5 * Math.tan(OFFSET))

  it('a target 0.3 rad off-axis is missed head-on (no offset)', () => {
    const s = state(player('a', 2.5, 2.5, 0), target())
    expect(fireHitscan('a', s, OPEN)).toBeNull()
    expect(fireHitscan('a', s, OPEN, 0)).toBeNull() // explicit 0 is the same
  })

  it('the same target is hit with aimOffset ≈ 0.3 (the ray follows the cursor, not the facing)', () => {
    const s = state(player('a', 2.5, 2.5, 0), target())
    expect(fireHitscan('a', s, OPEN, OFFSET)).toBe('b')
  })

  it('aimOffset does not mutate the shooter (pure direction steer, facing untouched)', () => {
    const a = player('a', 2.5, 2.5, 0)
    const s = state(a, target())
    fireHitscan('a', s, OPEN, OFFSET)
    expect(a.dir).toBe(0)
    expect(a.pos).toEqual({ x: 2.5, y: 2.5 })
  })
})
