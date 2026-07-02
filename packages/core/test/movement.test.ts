import { describe, expect, it } from 'vitest'
import { MOVE_SPEED, PLAYER_RADIUS } from '../src/constants.js'
import { parseMap } from '../src/map.js'
import { makeInput, stepPlayer, wrapAngle } from '../src/movement.js'
import type { PlayerState } from '../src/types.js'

const ROOM = parseMap('room', 'Room', [
  '##########',
  '#SSSSSSSS#',
  '#........#',
  '#...R....#',
  '#........#',
  '##########',
].join('\n'))

function player(x: number, y: number, dir = 0): PlayerState {
  return { id: 'p1', handle: 'h', bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

describe('stepPlayer', () => {
  it('moves forward along dir', () => {
    const p = player(5, 3, 0) // dir 0 = +x
    stepPlayer(p, makeInput(1, { forward: 1 }), ROOM)
    expect(p.pos.x).toBeCloseTo(5 + MOVE_SPEED)
    expect(p.pos.y).toBeCloseTo(3)
    expect(p.lastInputSeq).toBe(1)
  })
  it('never clips into walls (property)', () => {
    const p = player(1.5, 2.5, 0)
    let seq = 0
    // hammer the west wall for 200 ticks from every angle
    for (let i = 0; i < 200; i++) {
      p.dir = (i / 200) * Math.PI * 2
      stepPlayer(p, makeInput(++seq, { forward: 1, strafe: i % 3 === 0 ? 1 : 0 }), ROOM)
      expect(p.pos.x).toBeGreaterThanOrEqual(1 + PLAYER_RADIUS - 1e-9)
      expect(p.pos.y).toBeGreaterThanOrEqual(1 + PLAYER_RADIUS - 1e-9)
      expect(p.pos.x).toBeLessThanOrEqual(9 - PLAYER_RADIUS + 1e-9)
      expect(p.pos.y).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    }
  })
  it('slides along walls (axis-separated)', () => {
    const p = player(1.31, 3, Math.PI) // facing -x, against west wall
    stepPlayer(p, makeInput(1, { forward: 1, strafe: 1 }), ROOM) // strafe right = -y when facing -x
    expect(p.pos.x).toBeCloseTo(1.31, 1) // blocked in x
    expect(p.pos.y).not.toBeCloseTo(3) // free in y
  })
  it('diagonal speed is normalized', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(1, { forward: 1, strafe: 1 }), ROOM)
    const d = Math.hypot(p.pos.x - 5, p.pos.y - 3)
    expect(d).toBeCloseTo(MOVE_SPEED)
  })
})

describe('wrapAngle', () => {
  it('wraps into (-pi, pi]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(0.5)).toBeCloseTo(0.5)
  })
})
