import { describe, expect, it } from 'vitest'
import { parseClientMsg, parseServerMsg, quantizeInput, sanitizeHandle } from '../src/protocol.js'

describe('sanitizeHandle', () => {
  it('lowercases, strips invalid, caps at 24', () => {
    expect(sanitizeHandle('Rebased_Rustacean!')).toBe('rebasedrustacean')
    expect(sanitizeHandle('a'.repeat(40))).toHaveLength(24)
    expect(sanitizeHandle('fake·synth')).toBe('fakesynth') // bot glyph reserved
    expect(sanitizeHandle('###')).toBe('anon')
  })
})

describe('parseClientMsg', () => {
  it('valid join/input/leave pass', () => {
    expect(parseClientMsg('{"t":"join","handle":"abc"}')).toEqual({ t: 'join', handle: 'abc' })
    expect(parseClientMsg('{"t":"leave"}')).toEqual({ t: 'leave' })
    const input = parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":1,"strafe":0,"turn":-1,"fire":true}]}')
    // PlayerInput gained `aimOffset` after this brief was written (cursor-aim feel
    // iteration); it's optional on the wire and parses to a concrete 0 when absent.
    expect(input).toEqual({ t: 'input', inputs: [{ seq: 1, forward: 1, strafe: 0, turn: -1, fire: true, aimOffset: 0 }] })
  })
  it('rejects malformed payloads', () => {
    expect(parseClientMsg('nonsense')).toBeNull()
    expect(parseClientMsg('{"t":"input","inputs":[{"seq":"x"}]}')).toBeNull()
    expect(parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":9,"strafe":0,"turn":0,"fire":false}]}')).toBeNull()
    expect(parseClientMsg(`{"t":"join","handle":"${'a'.repeat(9000)}"}`)).toBeNull() // oversized
    const many = JSON.stringify({ t: 'input', inputs: Array(50).fill({ seq: 1, forward: 0, strafe: 0, turn: 0, fire: false }) })
    expect(parseClientMsg(many)).toBeNull()
  })

  // Amendment 1: axes are analog floats in [-1, 1], not tri-state.
  it('accepts analog axis values within [-1, 1]', () => {
    const msg = parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":0.5,"strafe":-0.25,"turn":0.9,"fire":false}]}')
    expect(msg).toEqual({ t: 'input', inputs: [{ seq: 1, forward: 0.5, strafe: -0.25, turn: 0.9, fire: false, aimOffset: 0 }] })
  })
  it('rejects out-of-range or non-finite axis values', () => {
    const bad = (forward: string) =>
      `{"t":"input","inputs":[{"seq":1,"forward":${forward},"strafe":0,"turn":0,"fire":false}]}`
    expect(parseClientMsg(bad('1.5'))).toBeNull()
    expect(parseClientMsg(bad('-2'))).toBeNull()
    expect(parseClientMsg(bad('NaN'))).toBeNull() // not valid JSON -> caught by JSON.parse
    expect(parseClientMsg(bad('Infinity'))).toBeNull() // not valid JSON -> caught by JSON.parse
  })

  // Amendment 2: aimOffset is optional, defaults to 0, clamped range check when present.
  describe('aimOffset', () => {
    it('defaults to 0 when absent', () => {
      const msg = parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":0,"strafe":0,"turn":0,"fire":false}]}')
      expect(msg).toEqual({ t: 'input', inputs: [{ seq: 1, forward: 0, strafe: 0, turn: 0, fire: false, aimOffset: 0 }] })
    })
    it('accepts a present finite value within ±AIM_OFFSET_MAX', () => {
      const msg = parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":0,"strafe":0,"turn":0,"fire":false,"aimOffset":0.6}]}')
      expect(msg).toEqual({ t: 'input', inputs: [{ seq: 1, forward: 0, strafe: 0, turn: 0, fire: false, aimOffset: 0.6 }] })
    })
    it('rejects the whole message when aimOffset exceeds ±AIM_OFFSET_MAX', () => {
      expect(parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":0,"strafe":0,"turn":0,"fire":false,"aimOffset":0.61}]}')).toBeNull()
      expect(parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":0,"strafe":0,"turn":0,"fire":false,"aimOffset":-0.7}]}')).toBeNull()
    })
  })

  // Amendment 4: seq must be a non-negative integer, not just any finite number.
  describe('seq validation', () => {
    it('rejects non-integer or negative seq', () => {
      expect(parseClientMsg('{"t":"input","inputs":[{"seq":1.5,"forward":0,"strafe":0,"turn":0,"fire":false}]}')).toBeNull()
      expect(parseClientMsg('{"t":"input","inputs":[{"seq":-1,"forward":0,"strafe":0,"turn":0,"fire":false}]}')).toBeNull()
    })
    it('accepts seq 0', () => {
      const msg = parseClientMsg('{"t":"input","inputs":[{"seq":0,"forward":0,"strafe":0,"turn":0,"fire":false}]}')
      expect(msg).toEqual({ t: 'input', inputs: [{ seq: 0, forward: 0, strafe: 0, turn: 0, fire: false, aimOffset: 0 }] })
    })
  })
})

describe('parseServerMsg', () => {
  it('round-trips a snap', () => {
    const snap = { t: 'snap', state: { tick: 1, timeLeftTicks: 10, mapId: 'x', players: {}, rail: { pos: { x: 1, y: 1 }, present: true, respawnTimer: 0 }, kills: [] } }
    expect(parseServerMsg(JSON.stringify(snap))).toEqual(snap)
    expect(parseServerMsg('{"t":"wat"}')).toBeNull()
  })
})

// Amendment 3: quantizeInput snaps analog axes + aimOffset to the nearest 1/64 step
// so wire payloads stay compact (no 17-digit float tails from client-side math).
describe('quantizeInput', () => {
  const base = { seq: 5, forward: 0, strafe: 0, turn: 0, fire: true, aimOffset: 0 }

  it('snaps to the nearest 1/64 step', () => {
    const q = quantizeInput({ ...base, forward: 0.333333333333 })
    expect(q.forward).toBeCloseTo(21 / 64, 10)
  })
  it('is idempotent', () => {
    const once = quantizeInput({ ...base, forward: 0.333333333333, strafe: 0.1, turn: -0.7, aimOffset: 0.41 })
    const twice = quantizeInput(once)
    expect(twice).toEqual(once)
  })
  it('leaves exact values unchanged', () => {
    const q = quantizeInput({ ...base, forward: 1, strafe: -1, turn: 0, aimOffset: 0 })
    expect(q.forward).toBe(1)
    expect(q.strafe).toBe(-1)
    expect(q.turn).toBe(0)
    expect(q.aimOffset).toBe(0)
  })
  it('leaves seq and fire untouched', () => {
    const q = quantizeInput({ ...base, forward: 0.123456 })
    expect(q.seq).toBe(5)
    expect(q.fire).toBe(true)
  })
})
