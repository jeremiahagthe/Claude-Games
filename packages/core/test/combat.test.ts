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
