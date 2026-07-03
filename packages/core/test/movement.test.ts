import { describe, expect, it } from 'vitest'
import { AIM_OFFSET_MAX, MOVE_SPEED, PLAYER_RADIUS, TURN_SPEED } from '../src/constants.js'
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
  it('turn-only input rotates without moving and still updates lastInputSeq', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(7, { turn: 1 }), ROOM)
    expect(p.dir).toBeCloseTo(TURN_SPEED)
    expect(p.pos).toEqual({ x: 5, y: 3 })
    expect(p.lastInputSeq).toBe(7)
  })
  it('analog forward magnitude scales speed (half input = half speed)', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(1, { forward: 0.5 }), ROOM)
    const d = Math.hypot(p.pos.x - 5, p.pos.y - 3)
    expect(d).toBeCloseTo(MOVE_SPEED * 0.5)
  })
  it('analog (forward 1, strafe 1) is still capped at MOVE_SPEED, not scaled above it', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(1, { forward: 1, strafe: 1 }), ROOM)
    const d = Math.hypot(p.pos.x - 5, p.pos.y - 3)
    expect(d).toBeCloseTo(MOVE_SPEED)
  })
  it('fractional turn scales rotation', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(1, { turn: 0.5 }), ROOM)
    expect(p.dir).toBeCloseTo(TURN_SPEED * 0.5)
  })
})

describe('makeInput analog clamping', () => {
  it('clamps in-range values unchanged', () => {
    const i = makeInput(1, { forward: 0.5, strafe: -0.75, turn: 1 })
    expect(i.forward).toBe(0.5)
    expect(i.strafe).toBe(-0.75)
    expect(i.turn).toBe(1)
  })
  it('clamps out-of-range values to [-1, 1]', () => {
    const i = makeInput(1, { forward: 5, strafe: -5, turn: 1.0001 })
    expect(i.forward).toBe(1)
    expect(i.strafe).toBe(-1)
    expect(i.turn).toBe(1)
  })
  it('maps NaN and Infinity to 0', () => {
    const i = makeInput(1, { forward: NaN, strafe: Infinity, turn: -Infinity })
    expect(i.forward).toBe(0)
    expect(i.strafe).toBe(0)
    expect(i.turn).toBe(0)
  })
  it('defaults unset axes to 0 and fire to false', () => {
    const i = makeInput(1)
    expect(i.forward).toBe(0)
    expect(i.strafe).toBe(0)
    expect(i.turn).toBe(0)
    expect(i.fire).toBe(false)
  })
})

describe('makeInput aimOffset (cursor aim)', () => {
  it('defaults to 0 when absent (bots and existing call sites are unaffected)', () => {
    expect(makeInput(1).aimOffset).toBe(0)
    expect(makeInput(1, { forward: 1 }).aimOffset).toBe(0)
  })
  it('passes an in-range offset through unchanged', () => {
    expect(makeInput(1, { aimOffset: 0.3 }).aimOffset).toBeCloseTo(0.3, 12)
    expect(makeInput(1, { aimOffset: -0.3 }).aimOffset).toBeCloseTo(-0.3, 12)
  })
  it('clamps to ±AIM_OFFSET_MAX (0.6)', () => {
    expect(makeInput(1, { aimOffset: 5 }).aimOffset).toBe(AIM_OFFSET_MAX)
    expect(makeInput(1, { aimOffset: -5 }).aimOffset).toBe(-AIM_OFFSET_MAX)
  })
  it('maps non-finite offsets to 0', () => {
    expect(makeInput(1, { aimOffset: NaN }).aimOffset).toBe(0)
    expect(makeInput(1, { aimOffset: Infinity }).aimOffset).toBe(0)
    expect(makeInput(1, { aimOffset: -Infinity }).aimOffset).toBe(0)
  })
})

describe('wrapAngle', () => {
  it('wraps into (-pi, pi]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(0.5)).toBeCloseTo(0.5)
  })
})
