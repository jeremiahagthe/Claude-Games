import { describe, expect, it } from 'vitest'
import { createMatch } from '../src/match.js'
import { resolveShot } from '../src/resolve.js'
import { stateHash } from '../src/state.js'
import type { Result } from '../src/state.js'
import {
  MAX_RAW,
  parseTankClientMsg,
  parseTankServerMsg,
  resultFromWire,
  resultToWire,
  sanitizeHandle,
  type EndMsg,
  type JoinMsg,
  type ShotBcast,
  type ShotMsg,
  type StartMsg,
  type TurnMsg,
} from '../src/protocol.js'

describe('sanitizeHandle', () => {
  it('lowercases, strips outside [a-z0-9-], caps at 24, falls back to anon', () => {
    expect(sanitizeHandle('Player-One!!')).toBe('player-one')
    expect(sanitizeHandle('###')).toBe('anon')
    expect(sanitizeHandle('x'.repeat(50))).toBe('x'.repeat(24))
  })
})

describe('legal round-trips: client messages', () => {
  it('JoinMsg', () => {
    const msg: JoinMsg = { t: 'join', name: 'alice' }
    const parsed = parseTankClientMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })

  it('ShotMsg', () => {
    const msg: ShotMsg = { t: 'shot', seq: 4, angle: 60, power: 55 }
    const parsed = parseTankClientMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })
})

describe('legal round-trips: server messages', () => {
  it('StartMsg', () => {
    const msg: StartMsg = { t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, true], firstTurn: 1 }
    const parsed = parseTankServerMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })

  it('ShotBcast', () => {
    const msg: ShotBcast = { t: 'shot', by: 1, seq: 2, angle: 88, power: 40, stateHash: 'a1b2c3d4' }
    const parsed = parseTankServerMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })

  it('TurnMsg', () => {
    const msg: TurnMsg = { t: 'turn', who: 0, deadlineMs: 20_000 }
    const parsed = parseTankServerMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })

  it('EndMsg (win)', () => {
    const msg: EndMsg = { t: 'end', result: [0, 1] }
    const parsed = parseTankServerMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })

  it('EndMsg (draw)', () => {
    const msg: EndMsg = { t: 'end', result: [1] }
    const parsed = parseTankServerMsg(JSON.stringify(msg))
    expect(parsed).toEqual(msg)
  })
})

describe('resultToWire / resultFromWire round-trip', () => {
  it('win', () => {
    const r: Result = { kind: 'win', winner: 1 }
    expect(resultFromWire(resultToWire(r))).toEqual(r)
  })

  it('draw', () => {
    const r: Result = { kind: 'draw' }
    expect(resultFromWire(resultToWire(r))).toEqual(r)
  })
})

describe('parseTankClientMsg hardening', () => {
  it('rejects raw longer than MAX_RAW', () => {
    const huge = JSON.stringify({ t: 'join', name: 'x'.repeat(MAX_RAW) })
    expect(huge.length).toBeGreaterThan(MAX_RAW)
    expect(parseTankClientMsg(huge)).toBeNull()
  })

  it('rejects angle 181', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot', seq: 1, angle: 181, power: 50 }))).toBeNull()
  })

  it('rejects angle 90.5 (non-integer)', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot', seq: 1, angle: 90.5, power: 50 }))).toBeNull()
  })

  it('rejects power -1', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot', seq: 1, angle: 60, power: -1 }))).toBeNull()
  })

  it('rejects seq -1', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot', seq: -1, angle: 60, power: 50 }))).toBeNull()
  })

  it('rejects seq 1.5 (non-integer)', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot', seq: 1.5, angle: 60, power: 50 }))).toBeNull()
  })

  it('rejects non-JSON garbage', () => {
    expect(parseTankClientMsg('{not json')).toBeNull()
  })

  it('rejects valid-JSON-wrong-shape', () => {
    expect(parseTankClientMsg(JSON.stringify({ t: 'shot' }))).toBeNull()
    expect(parseTankClientMsg(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })

  it('rejects a prototype-pollution shaped name', () => {
    const raw = JSON.stringify({ t: 'join', name: { __proto__: 1 } })
    expect(parseTankClientMsg(raw)).toBeNull()
  })
})

describe('parseTankServerMsg hardening', () => {
  it('rejects stateHash "XYZ" (not lowercase hex)', () => {
    const raw = JSON.stringify({ t: 'shot', by: 0, seq: 1, angle: 60, power: 50, stateHash: 'XYZ' })
    expect(parseTankServerMsg(raw)).toBeNull()
  })

  it('rejects a stateHash 40 chars long', () => {
    const raw = JSON.stringify({ t: 'shot', by: 0, seq: 1, angle: 60, power: 50, stateHash: 'a'.repeat(40) })
    expect(parseTankServerMsg(raw)).toBeNull()
  })

  it('rejects a name 300 chars long in StartMsg.names', () => {
    const raw = JSON.stringify({
      t: 'start', you: 0, seed: 1, names: ['x'.repeat(300), 'bob'], bots: [false, false], firstTurn: 0,
    })
    expect(parseTankServerMsg(raw)).toBeNull()
  })

  it('rejects a names tuple of 3', () => {
    const raw = JSON.stringify({
      t: 'start', you: 0, seed: 1, names: ['a', 'b', 'c'], bots: [false, false], firstTurn: 0,
    })
    expect(parseTankServerMsg(raw)).toBeNull()
  })

  it('rejects deadlineMs of 10^9', () => {
    const raw = JSON.stringify({ t: 'turn', who: 0, deadlineMs: 1_000_000_000 })
    expect(parseTankServerMsg(raw)).toBeNull()
  })

  it('rejects non-JSON garbage', () => {
    expect(parseTankServerMsg('not json at all {{{')).toBeNull()
  })

  it('rejects valid-JSON-wrong-shape', () => {
    expect(parseTankServerMsg(JSON.stringify({ t: 'shot' }))).toBeNull()
    expect(parseTankServerMsg(JSON.stringify({ t: 'start', you: 0 }))).toBeNull()
    expect(parseTankServerMsg(JSON.stringify('just a string'))).toBeNull()
  })

  it('rejects raw longer than MAX_RAW', () => {
    const huge = JSON.stringify({ t: 'end', result: [0, 0], pad: 'y'.repeat(MAX_RAW) })
    expect(huge.length).toBeGreaterThan(MAX_RAW)
    expect(parseTankServerMsg(huge)).toBeNull()
  })
})

describe('transcript determinism (the client desync tripwire)', () => {
  it('a 6-shot scripted duel replays identically through the wire on a second createMatch(seed) copy', () => {
    const seed = 123
    const names: [string, string] = ['a', 'b']
    const bots: [boolean, boolean] = [false, false]
    const script = [
      { angle: 50, power: 60 },
      { angle: 120, power: 55 },
      { angle: 65, power: 70 },
      { angle: 110, power: 48 },
      { angle: 80, power: 90 },
      { angle: 100, power: 40 },
    ]

    let live = createMatch(seed, names, bots)
    let replay = createMatch(seed, names, bots)
    expect(script.length).toBe(6)

    for (let seq = 0; seq < script.length; seq++) {
      const shot = script[seq]!
      const by = live.turn
      const out = resolveShot(live, shot)
      live = out.state
      const hashAfter = stateHash(live)

      const bcast: ShotBcast = { t: 'shot', by, seq, angle: shot.angle, power: shot.power, stateHash: hashAfter }
      const raw = JSON.stringify(bcast)
      const parsed = parseTankServerMsg(raw)
      expect(parsed).not.toBeNull()
      expect(parsed).toEqual(bcast)

      const p = parsed as ShotBcast
      const replayOut = resolveShot(replay, { angle: p.angle, power: p.power })
      replay = replayOut.state
      expect(stateHash(replay)).toBe(p.stateHash)
    }
  })
})
