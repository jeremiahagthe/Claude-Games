import { describe, expect, it } from 'vitest'
import type { Shot } from 'tankwait-core'
import { applyKey, isFireKey } from '../src/game.js'

// applyKey: pure aim reducer. left/right angle ∓/±1 · a/d angle ∓/±5 · up/down
// power ±1 · w/s power ±5 (all clamped to angle 0..180, power 0..100). OS
// auto-repeat delivers hold-to-sweep as repeated keys, so each key is one step.

const aim: Shot = { angle: 60, power: 50 }

describe('applyKey angle', () => {
  it('left/right nudge angle ∓/± 1', () => {
    expect(applyKey(aim, 'left')).toEqual({ angle: 59, power: 50 })
    expect(applyKey(aim, 'right')).toEqual({ angle: 61, power: 50 })
  })
  it('a/d nudge angle ∓/± 5', () => {
    expect(applyKey(aim, 'a')).toEqual({ angle: 55, power: 50 })
    expect(applyKey(aim, 'd')).toEqual({ angle: 65, power: 50 })
  })
  it('clamps angle at 180 (right) and 0 (left)', () => {
    expect(applyKey({ angle: 180, power: 50 }, 'right')).toEqual({ angle: 180, power: 50 })
    expect(applyKey({ angle: 180, power: 50 }, 'd')).toEqual({ angle: 180, power: 50 })
    expect(applyKey({ angle: 0, power: 50 }, 'left')).toEqual({ angle: 0, power: 50 })
  })
})

describe('applyKey power', () => {
  it('up/down nudge power ± 1', () => {
    expect(applyKey(aim, 'up')).toEqual({ angle: 60, power: 51 })
    expect(applyKey(aim, 'down')).toEqual({ angle: 60, power: 49 })
  })
  it('w/s nudge power ± 5', () => {
    expect(applyKey(aim, 'w')).toEqual({ angle: 60, power: 55 })
    expect(applyKey(aim, 's')).toEqual({ angle: 60, power: 45 })
  })
  it('clamps power at 0 (down) and 100 (up)', () => {
    expect(applyKey({ angle: 60, power: 0 }, 'down')).toEqual({ angle: 60, power: 0 })
    expect(applyKey({ angle: 60, power: 0 }, 's')).toEqual({ angle: 60, power: 0 })
    expect(applyKey({ angle: 60, power: 100 }, 'up')).toEqual({ angle: 60, power: 100 })
  })
})

describe('applyKey ignores unmapped keys', () => {
  it('leaves the aim unchanged for a non-aim key', () => {
    expect(applyKey(aim, 'z')).toEqual(aim)
    expect(applyKey(aim, ' ')).toEqual(aim)
    expect(applyKey(aim, 'enter')).toEqual(aim)
  })
})

describe('isFireKey', () => {
  it('space and enter fire; movement keys do not', () => {
    expect(isFireKey(' ')).toBe(true)
    expect(isFireKey('space')).toBe(true)
    expect(isFireKey('enter')).toBe(true)
    expect(isFireKey('left')).toBe(false)
    expect(isFireKey('w')).toBe(false)
  })
})
