import { describe, expect, it } from 'vitest'
import { parseChessClientMsg, parseChessServerMsg, sanitizeHandle } from '../src/protocol.js'

describe('sanitizeHandle', () => {
  it('lowercases, strips invalid, caps at 24', () => {
    expect(sanitizeHandle('Rebased_Rustacean!')).toBe('rebasedrustacean')
    expect(sanitizeHandle('a'.repeat(40))).toHaveLength(24)
    expect(sanitizeHandle('fake·synth')).toBe('fakesynth') // bot glyph reserved
    expect(sanitizeHandle('###')).toBe('anon')
  })
})

describe('parseChessClientMsg', () => {
  it('valid join/move/resign pass', () => {
    expect(parseChessClientMsg('{"t":"join","handle":"abc"}')).toEqual({ t: 'join', handle: 'abc' })
    expect(parseChessClientMsg('{"t":"resign"}')).toEqual({ t: 'resign' })
    expect(parseChessClientMsg('{"t":"move","move":"e2e4","seq":1}')).toEqual({ t: 'move', move: 'e2e4', seq: 1 })
    expect(parseChessClientMsg('{"t":"move","move":"e7e8q","seq":0}')).toEqual({ t: 'move', move: 'e7e8q', seq: 0 })
  })

  it('sanitizes the handle on join', () => {
    expect(parseChessClientMsg('{"t":"join","handle":"Weird_Name!!"}')).toEqual({ t: 'join', handle: 'weirdname' })
  })

  it('rejects non-JSON', () => {
    expect(parseChessClientMsg('nonsense')).toBeNull()
    expect(parseChessClientMsg('')).toBeNull()
  })

  it('rejects unknown t', () => {
    expect(parseChessClientMsg('{"t":"wat"}')).toBeNull()
  })

  it('rejects missing/wrong-typed fields', () => {
    expect(parseChessClientMsg('{"t":"join"}')).toBeNull()
    expect(parseChessClientMsg('{"t":"join","handle":123}')).toBeNull()
    expect(parseChessClientMsg('{"t":"move","move":"e2e4"}')).toBeNull() // missing seq
    expect(parseChessClientMsg('{"t":"move","seq":1}')).toBeNull() // missing move
    expect(parseChessClientMsg('{"t":"move","move":123,"seq":1}')).toBeNull()
    expect(parseChessClientMsg('{"t":"move","move":"e2e4","seq":"1"}')).toBeNull()
  })

  it('rejects malformed move strings', () => {
    expect(parseChessClientMsg('{"t":"move","move":"nope","seq":1}')).toBeNull()
    expect(parseChessClientMsg('{"t":"move","move":"e2e9","seq":1}')).toBeNull()
    expect(parseChessClientMsg('{"t":"move","move":"e2e4z","seq":1}')).toBeNull()
  })

  it('rejects non-integer or negative seq', () => {
    expect(parseChessClientMsg('{"t":"move","move":"e2e4","seq":1.5}')).toBeNull()
    expect(parseChessClientMsg('{"t":"move","move":"e2e4","seq":-1}')).toBeNull()
  })

  it('accepts seq 0', () => {
    expect(parseChessClientMsg('{"t":"move","move":"e2e4","seq":0}')).toEqual({ t: 'move', move: 'e2e4', seq: 0 })
  })

  it('rejects oversized handle input', () => {
    const raw = `{"t":"join","handle":"${'a'.repeat(9000)}"}`
    // sanitizeHandle caps output at 24, so this should still parse to a capped handle,
    // not reject — oversized raw payloads are rejected separately by MAX_RAW.
    expect(raw.length).toBeGreaterThan(4096)
    expect(parseChessClientMsg(raw)).toBeNull()
  })

  it('rejects a non-object JSON value', () => {
    expect(parseChessClientMsg('42')).toBeNull()
    expect(parseChessClientMsg('null')).toBeNull()
    expect(parseChessClientMsg('[1,2,3]')).toBeNull()
  })
})

describe('parseChessServerMsg', () => {
  it('valid welcome/move/end pass', () => {
    const welcome = {
      t: 'welcome',
      color: 'w',
      opponent: 'bob',
      state: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      clocksMs: { w: 180000, b: 180000 },
    }
    expect(parseChessServerMsg(JSON.stringify(welcome))).toEqual(welcome)

    const move = { t: 'move', move: 'e2e4', clocksMs: { w: 178000, b: 180000 }, seq: 1 }
    expect(parseChessServerMsg(JSON.stringify(move))).toEqual(move)

    const end = { t: 'end', result: { kind: 'checkmate', winner: 'w' }, state: '8/8/8/8/8/8/8/K6k w - - 0 1' }
    expect(parseChessServerMsg(JSON.stringify(end))).toEqual(end)

    const draw = { t: 'end', result: { kind: 'stalemate' }, state: '8/8/8/8/8/8/8/K6k w - - 0 1' }
    expect(parseChessServerMsg(JSON.stringify(draw))).toEqual(draw)
  })

  it('rejects non-JSON and unknown t', () => {
    expect(parseChessServerMsg('nonsense')).toBeNull()
    expect(parseChessServerMsg('{"t":"wat"}')).toBeNull()
  })

  it('rejects a welcome with wrong-typed or missing fields', () => {
    expect(parseChessServerMsg('{"t":"welcome","color":"x","opponent":"bob","state":"fen","clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"welcome","color":"w","opponent":123,"state":"fen","clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"welcome","color":"w","opponent":"bob","state":123,"clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"welcome","color":"w","opponent":"bob","state":"fen","clocksMs":{"w":"1","b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"welcome","color":"w","opponent":"bob","state":"fen"}')).toBeNull()
  })

  it('rejects a move with wrong-typed or missing fields', () => {
    expect(parseChessServerMsg('{"t":"move","move":"e2e4","clocksMs":{"w":1,"b":1}}')).toBeNull() // missing seq
    expect(parseChessServerMsg('{"t":"move","move":"e2e4","seq":1.5,"clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"move","move":"e2e4","seq":-1,"clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"move","move":"bogus","seq":1,"clocksMs":{"w":1,"b":1}}')).toBeNull()
    expect(parseChessServerMsg('{"t":"move","move":"e2e4","seq":1,"clocksMs":{"w":1}}')).toBeNull()
  })

  it('validates the Result shape field-by-field on end', () => {
    // unknown kind
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"bogus"},"state":"fen"}')).toBeNull()
    // winner-bearing kind missing winner
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"checkmate"},"state":"fen"}')).toBeNull()
    // winner-bearing kind with invalid winner
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"resign","winner":"x"},"state":"fen"}')).toBeNull()
    // non-winner kind must NOT carry a winner field with a bogus value
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"stalemate","winner":"z"},"state":"fen"}')).toBeNull()
    // missing state
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"stalemate"}}')).toBeNull()
    // flag/threefold/fifty-move/insufficient all accepted in their proper shapes
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"flag","winner":"b"},"state":"fen"}')).toEqual({
      t: 'end',
      result: { kind: 'flag', winner: 'b' },
      state: 'fen',
    })
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"threefold"},"state":"fen"}')).toEqual({
      t: 'end',
      result: { kind: 'threefold' },
      state: 'fen',
    })
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"fifty-move"},"state":"fen"}')).toEqual({
      t: 'end',
      result: { kind: 'fifty-move' },
      state: 'fen',
    })
    expect(parseChessServerMsg('{"t":"end","result":{"kind":"insufficient"},"state":"fen"}')).toEqual({
      t: 'end',
      result: { kind: 'insufficient' },
      state: 'fen',
    })
  })

  it('rejects a non-object JSON value', () => {
    expect(parseChessServerMsg('42')).toBeNull()
    expect(parseChessServerMsg('null')).toBeNull()
    expect(parseChessServerMsg('[1,2,3]')).toBeNull()
  })
})
