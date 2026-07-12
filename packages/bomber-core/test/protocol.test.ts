import { describe, expect, it } from 'vitest'
import { GRID_H, GRID_W } from '../src/constants.js'
import type { BomberState } from '../src/state.js'
import {
  MAX_RAW,
  fromWire,
  parseBomberClientMsg,
  parseBomberServerMsg,
  sanitizeHandle,
  toWire,
} from '../src/protocol.js'

describe('sanitizeHandle', () => {
  it('lowercases, strips invalid, caps at 24, falls back to anon', () => {
    expect(sanitizeHandle('Rebased_Rustacean!')).toBe('rebasedrustacean')
    expect(sanitizeHandle('a'.repeat(40))).toHaveLength(24)
    expect(sanitizeHandle('fake·synth')).toBe('fakesynth') // bot glyph reserved
    expect(sanitizeHandle('###')).toBe('anon')
  })
})

describe('parseBomberClientMsg', () => {
  it('valid hello/input pass', () => {
    expect(parseBomberClientMsg('{"t":"hello","name":"abc"}')).toEqual({ t: 'hello', name: 'abc' })
    expect(parseBomberClientMsg('{"t":"input","dir":"up","bomb":false}')).toEqual({
      t: 'input',
      dir: 'up',
      bomb: false,
    })
    expect(parseBomberClientMsg('{"t":"input","dir":null,"bomb":true}')).toEqual({
      t: 'input',
      dir: null,
      bomb: true,
    })
    expect(parseBomberClientMsg('{"t":"input","dir":"keep","bomb":false}')).toEqual({
      t: 'input',
      dir: 'keep',
      bomb: false,
    })
  })

  it('sanitizes the name on hello', () => {
    expect(parseBomberClientMsg('{"t":"hello","name":"Weird_Name!!"}')).toEqual({ t: 'hello', name: 'weirdname' })
  })

  it('rejects non-JSON', () => {
    expect(parseBomberClientMsg('nonsense')).toBeNull()
    expect(parseBomberClientMsg('')).toBeNull()
  })

  it('rejects unknown t', () => {
    expect(parseBomberClientMsg('{"t":"wat"}')).toBeNull()
  })

  it('rejects missing/wrong-typed fields', () => {
    expect(parseBomberClientMsg('{"t":"hello"}')).toBeNull()
    expect(parseBomberClientMsg('{"t":"hello","name":123}')).toBeNull()
    expect(parseBomberClientMsg('{"t":"input","dir":"up"}')).toBeNull() // missing bomb
    expect(parseBomberClientMsg('{"t":"input","bomb":true}')).toBeNull() // missing dir
    expect(parseBomberClientMsg('{"t":"input","dir":"sideways","bomb":true}')).toBeNull() // invalid dir literal
    expect(parseBomberClientMsg('{"t":"input","dir":"up","bomb":"yes"}')).toBeNull() // bomb not boolean
  })

  it('rejects oversized raw (> MAX_RAW)', () => {
    const raw = `{"t":"hello","name":"${'a'.repeat(9000)}"}`
    expect(raw.length).toBeGreaterThan(MAX_RAW)
    expect(parseBomberClientMsg(raw)).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(parseBomberClientMsg(null)).toBeNull()
    expect(parseBomberClientMsg(undefined)).toBeNull()
    expect(parseBomberClientMsg(42)).toBeNull()
    expect(parseBomberClientMsg({})).toBeNull()
    expect(parseBomberClientMsg([])).toBeNull()
    expect(parseBomberClientMsg('x'.repeat(5000))).toBeNull()
    expect(parseBomberClientMsg('\x00\x01\x02binary-ish￿')).toBeNull()
    expect(parseBomberClientMsg('{"t":"hello","name":')).toBeNull() // truncated JSON
  })

  it('rejects a non-object JSON value', () => {
    expect(parseBomberClientMsg('42')).toBeNull()
    expect(parseBomberClientMsg('null')).toBeNull()
    expect(parseBomberClientMsg('[1,2,3]')).toBeNull()
  })
})

function busyState(): BomberState {
  const grid: BomberState['grid'] = []
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const onBorder = x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1
      grid.push(onBorder ? 'hard' : (x + y) % 3 === 0 ? 'soft' : 'empty')
    }
  }
  const hidden: BomberState['hidden'] = new Array(grid.length).fill(null)

  const names = ['playerone-longhandle', 'playertwo-longhandle', 'playerthree-longhandle', 'playerfour-longhandle']
  const players: BomberState['players'] = names.map((name, id) => ({
    id,
    name,
    bot: id % 2 === 0,
    x: 3 + id,
    y: 4 + id,
    alive: id !== 3,
    bombCap: 5,
    range: 7,
    speed: 3,
    // id 3 pins dir to null (standing) -- every other slot was already exercising a real
    // heading, leaving dirToCode(null) <-> codeToDir(0) round-tripped by nothing (id % 4 for
    // 4 players never lands past index 3, so the `?? null` fallback above was dead).
    dir: id === 3 ? null : (['up', 'down', 'left', 'right'] as const)[id % 4]!,
    stepCooldown: 4,
    activeBombs: 3,
  }))

  const bombs: BomberState['bombs'] = []
  for (let i = 0; i < 12; i++) {
    bombs.push({ owner: i % 4, x: 1 + (i % (GRID_W - 2)), y: 1 + (i % (GRID_H - 2)), fuse: 40, range: 7 })
  }

  const flames: BomberState['flames'] = []
  for (let i = 0; i < 40; i++) {
    flames.push({ x: 1 + (i % (GRID_W - 2)), y: 1 + ((i * 3) % (GRID_H - 2)), ticks: 10 })
  }

  const drops: BomberState['drops'] = []
  const kinds = ['bomb', 'range', 'speed'] as const
  for (let i = 0; i < 10; i++) {
    drops.push({ x: 2 + (i % (GRID_W - 4)), y: 2 + (i % (GRID_H - 4)), kind: kinds[i % 3]! })
  }

  return {
    tick: 1234,
    grid,
    hidden,
    drops,
    players,
    bombs,
    flames,
    shrinkIndex: 17,
    result: null,
  }
}

describe('toWire / fromWire', () => {
  it('round-trips: fromWire(toWire(s)) equals s minus hidden (all-null)', () => {
    const s = busyState()
    const w = toWire(s)
    const back = fromWire(w)
    expect(back).toEqual({ ...s, hidden: new Array(s.grid.length).fill(null) })
  })

  it('round-trips a state with a win result', () => {
    const s: BomberState = { ...busyState(), result: { kind: 'win', winner: 2 } }
    expect(fromWire(toWire(s))).toEqual({ ...s, hidden: new Array(s.grid.length).fill(null) })
  })

  it('round-trips a state with a draw result', () => {
    const s: BomberState = { ...busyState(), result: { kind: 'draw' } }
    expect(fromWire(toWire(s))).toEqual({ ...s, hidden: new Array(s.grid.length).fill(null) })
  })

  it('does not send hidden on the wire', () => {
    const w = toWire(busyState()) as unknown as Record<string, unknown>
    expect(w['hidden']).toBeUndefined()
  })

  it('busy mid-game snapshot JSON stays under 2048 bytes', () => {
    const msg = { t: 'snap' as const, state: toWire(busyState()) }
    const json = JSON.stringify(msg)
    expect(json.length).toBeLessThan(2048)
  })
})

describe('parseBomberServerMsg', () => {
  it('valid start/snap/end pass', () => {
    const start = {
      t: 'start',
      you: 1,
      seed: 7,
      names: ['a', 'b', 'c', 'd'],
      bots: [false, true, false, true],
      startTick: 0,
    }
    expect(parseBomberServerMsg(JSON.stringify(start))).toEqual(start)

    const snap = { t: 'snap', state: toWire(busyState()) }
    expect(parseBomberServerMsg(JSON.stringify(snap))).toEqual(snap)

    const end = { t: 'end', result: { kind: 'win', winner: 2 } }
    expect(parseBomberServerMsg(JSON.stringify(end))).toEqual(end)

    const draw = { t: 'end', result: { kind: 'draw' } }
    expect(parseBomberServerMsg(JSON.stringify(draw))).toEqual(draw)
  })

  it('rejects non-JSON and unknown t', () => {
    expect(parseBomberServerMsg('nonsense')).toBeNull()
    expect(parseBomberServerMsg('{"t":"wat"}')).toBeNull()
  })

  it('rejects a start with wrong-typed or missing fields', () => {
    expect(parseBomberServerMsg('{"t":"start","you":1,"seed":7,"names":["a","b","c","d"],"bots":[true,true,true,true]}')).toBeNull() // missing startTick
    expect(parseBomberServerMsg('{"t":"start","you":-1,"seed":7,"names":["a","b","c","d"],"bots":[true,true,true,true],"startTick":0}')).toBeNull() // bad player id
    expect(parseBomberServerMsg('{"t":"start","you":1,"seed":"7","names":["a","b","c","d"],"bots":[true,true,true,true],"startTick":0}')).toBeNull() // seed not number
    expect(parseBomberServerMsg('{"t":"start","you":1,"seed":7,"names":["a","b","c"],"bots":[true,true,true,true],"startTick":0}')).toBeNull() // wrong names length
    expect(parseBomberServerMsg('{"t":"start","you":1,"seed":7,"names":["a","b","c","d"],"bots":[true,true,true],"startTick":0}')).toBeNull() // wrong bots length
  })

  it('rejects a snap with a malformed or truncated WireState', () => {
    const good = toWire(busyState())
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, g: good.g.slice(1) } }))).toBeNull() // wrong grid length
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, g: 'x'.repeat(good.g.length) } }))).toBeNull() // non-digit grid
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [[0, 'a']] } }))).toBeNull() // truncated player tuple
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, tick: -1 } }))).toBeNull() // negative tick
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, result: [9] } }))).toBeNull() // bad result code
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap' }))).toBeNull() // missing state
  })

  // WirePlayer tuple indices: [id, name, bot, x, y, alive, bombCap, range, speed, dirCode, stepCooldown, activeBombs]
  const tamperPlayer = (base: (string | number)[], index: number, value: number): (string | number)[] => {
    const p = [...base]
    p[index] = value
    return p
  }

  it('rejects a snap with out-of-bounds coordinates', () => {
    const good = toWire(busyState())
    const p0 = good.players[0]! as (string | number)[]
    // player x = GRID_W / y = GRID_H are one past the last valid tile
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 3, GRID_W)] } }))).toBeNull()
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 4, GRID_H)] } }))).toBeNull()
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 3, 999999999)] } }))).toBeNull()
    // bombs / flames / drops share the same tile bounds
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, bombs: [[0, GRID_W, 1, 40, 2]] } }))).toBeNull()
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, flames: [[1, GRID_H, 10]] } }))).toBeNull()
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, drops: [[999999999, 1, 0]] } }))).toBeNull()
  })

  it('rejects a snap with absurd stat/fuse/cooldown values', () => {
    const good = toWire(busyState())
    const p0 = good.players[0]! as (string | number)[]
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 6, 999999999)] } }))).toBeNull() // bombCap
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 7, 999999999)] } }))).toBeNull() // range
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 8, 999999999)] } }))).toBeNull() // speed
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 10, 999999999)] } }))).toBeNull() // stepCooldown
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, players: [tamperPlayer(p0, 11, 999999999)] } }))).toBeNull() // activeBombs
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, bombs: [[0, 1, 1, 999999999, 2]] } }))).toBeNull() // fuse
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, bombs: [[0, 1, 1, 40, 999999999]] } }))).toBeNull() // bomb range
    expect(parseBomberServerMsg(JSON.stringify({ t: 'snap', state: { ...good, flames: [[1, 1, 999999999]] } }))).toBeNull() // flame ticks
  })

  it('accepts boundary coordinates (x = GRID_W-1, y = GRID_H-1)', () => {
    const good = toWire(busyState())
    const p0 = tamperPlayer(tamperPlayer(good.players[0]! as (string | number)[], 3, GRID_W - 1), 4, GRID_H - 1)
    const state = {
      ...good,
      players: [p0],
      bombs: [[0, GRID_W - 1, GRID_H - 1, 40, 2]],
      flames: [[GRID_W - 1, GRID_H - 1, 10]],
      drops: [[GRID_W - 1, GRID_H - 1, 0]],
    }
    const parsed = parseBomberServerMsg(JSON.stringify({ t: 'snap', state }))
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual({ t: 'snap', state })
  })

  it('validates the Result shape field-by-field on end', () => {
    expect(parseBomberServerMsg('{"t":"end","result":{"kind":"bogus"}}')).toBeNull()
    expect(parseBomberServerMsg('{"t":"end","result":{"kind":"win"}}')).toBeNull() // missing winner
    expect(parseBomberServerMsg('{"t":"end","result":{"kind":"win","winner":-1}}')).toBeNull() // bad winner
    expect(parseBomberServerMsg('{"t":"end","result":{"kind":"win","winner":99}}')).toBeNull() // out of range
    expect(parseBomberServerMsg('{"t":"end","result":{"kind":"draw","winner":1}}')).toBeNull() // draw must not carry winner
  })

  it('rejects oversized raw (> MAX_RAW)', () => {
    const bigNames = JSON.stringify(Array(4).fill('x'.repeat(2000)))
    const raw = `{"t":"start","you":0,"seed":1,"names":${bigNames},"bots":[true,true,true,true],"startTick":0}`
    expect(raw.length).toBeGreaterThan(MAX_RAW)
    expect(parseBomberServerMsg(raw)).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(parseBomberServerMsg(null)).toBeNull()
    expect(parseBomberServerMsg(undefined)).toBeNull()
    expect(parseBomberServerMsg(42)).toBeNull()
    expect(parseBomberServerMsg({})).toBeNull()
    expect(parseBomberServerMsg([])).toBeNull()
    expect(parseBomberServerMsg('x'.repeat(5000))).toBeNull()
    expect(parseBomberServerMsg('\x00\x01\x02binary-ish￿')).toBeNull()
    expect(parseBomberServerMsg('{"t":"snap","state":')).toBeNull() // truncated JSON
  })

  it('rejects a non-object JSON value', () => {
    expect(parseBomberServerMsg('42')).toBeNull()
    expect(parseBomberServerMsg('null')).toBeNull()
    expect(parseBomberServerMsg('[1,2,3]')).toBeNull()
  })
})
