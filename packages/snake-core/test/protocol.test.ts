import { describe, expect, it } from 'vitest'
import { GRID_H, GRID_W } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState, SnakeState } from '../src/state.js'
import {
  MAX_RAW,
  fromWire,
  parseSnakeClientMsg,
  parseSnakeServerMsg,
  sanitizeHandle,
  toWire,
} from '../src/protocol.js'

// Same SCRIPT shape as Task 4's golden master (test/golden.test.ts) — turns
// scripted at a handful of ticks, coasting straight otherwise.
const SCRIPT: Record<number, (Input | null)[]> = {
  10: [{ dir: 'down' }, { dir: 'left' }, { dir: 'up' }, { dir: 'right' }],
  30: [{ dir: 'right' }, { dir: 'down' }, { dir: 'left' }, { dir: 'up' }],
  55: [{ dir: 'up' }, { dir: 'right' }, { dir: 'down' }, { dir: 'left' }],
  80: [{ dir: 'left' }, { dir: 'up' }, { dir: 'right' }, { dir: 'down' }],
}

function midMatchState(): MatchState {
  let s = createMatch(7, ['a', 'b', 'c', 'd'], [false, false, true, true])
  for (let t = 0; t < 100; t++) s = step(s, SCRIPT[t] ?? [null, null, null, null])
  return s
}

describe('sanitizeHandle', () => {
  it('lowercases, strips invalid, caps at 24, falls back to anon (copied verbatim from bomber-core)', () => {
    expect(sanitizeHandle('Rebased_Rustacean!')).toBe('rebasedrustacean')
    expect(sanitizeHandle('a'.repeat(40))).toHaveLength(24)
    expect(sanitizeHandle('fake·synth')).toBe('fakesynth') // bot glyph reserved
    expect(sanitizeHandle('###')).toBe('anon')
  })
})

describe('toWire / fromWire round-trip', () => {
  it('round-trips a mid-match state (createMatch stepped 100 ticks with scripted turns)', () => {
    const s = midMatchState()
    const back = fromWire(toWire(s))
    expect(back).toEqual(s)
  })

  it('a straight snake of length 10 encodes as ONE RLE segment', () => {
    const straight: SnakeState = {
      id: 0,
      name: 'a',
      bot: false,
      alive: true,
      dir: 'right',
      pendingDir: null,
      cells: Array.from({ length: 10 }, (_, i) => ({ x: 20 - i, y: 10 })),
      growth: 0,
    }
    const s: MatchState = {
      tick: 0,
      stepCooldown: 4,
      rng: 123,
      rings: 0,
      snakes: [straight],
      food: [],
      result: null,
    }
    const w = toWire(s)
    const segments = w.snakes[0]![9]
    expect(segments).toHaveLength(1)
    expect(segments[0]![1]).toBe(9) // 9 body cells behind the head
    expect(fromWire(w)).toEqual(s)
  })
})

function worstCaseState(): MatchState {
  // 4 fully-twisty staircase snakes of length 60 (turn every cell, so RLE
  // gets zero compression benefit) + 40 food.
  const DIRS: SnakeState['dir'][] = ['right', 'up']
  const starts = [
    { x: 5, y: 5 },
    { x: 50, y: 5 },
    { x: 5, y: 34 },
    { x: 50, y: 34 },
  ]
  const snakes: SnakeState[] = starts.map((start, id) => {
    const cells = [{ x: start.x, y: start.y }]
    let x = start.x
    let y = start.y
    for (let i = 1; i < 60; i++) {
      // alternate horizontal/vertical steps to force a new RLE segment per cell
      if (i % 2 === 1) x -= 1
      else y += 1
      cells.push({ x, y })
    }
    return {
      id,
      name: `player-${id}-longish-handle`,
      bot: id % 2 === 1,
      alive: true,
      dir: DIRS[id % 2]!,
      pendingDir: id % 2 === 0 ? 'up' : 'left',
      cells,
      growth: 3,
    }
  })
  const food = Array.from({ length: 40 }, (_, i) => ({
    x: (i * 7) % GRID_W,
    y: (i * 11) % GRID_H,
  }))
  return {
    tick: 3333,
    stepCooldown: 2,
    rng: 4294967295,
    rings: 5,
    snakes,
    food,
    result: null,
  }
}

describe('snapshot size pin', () => {
  it('worst-case 4 twisty snakes (len 60) + 40 food serializes under 2048 bytes', () => {
    const worst = worstCaseState()
    const json = JSON.stringify(toWire(worst))
    expect(json.length).toBeLessThan(2048)
  })
})

describe('parseSnakeClientMsg', () => {
  it('valid hello/input pass', () => {
    expect(parseSnakeClientMsg('{"t":"hello","name":"abc"}')).toEqual({ t: 'hello', name: 'abc' })
    expect(parseSnakeClientMsg('{"t":"input","dir":"up"}')).toEqual({ t: 'input', dir: 'up' })
    expect(parseSnakeClientMsg('{"t":"input","dir":"left"}')).toEqual({ t: 'input', dir: 'left' })
  })

  it('sanitizes the name on hello', () => {
    expect(parseSnakeClientMsg('{"t":"hello","name":"Weird_Name!!"}')).toEqual({ t: 'hello', name: 'weirdname' })
  })

  it('rejects unknown t and malformed dir', () => {
    expect(parseSnakeClientMsg('{"t":"wat"}')).toBeNull()
    expect(parseSnakeClientMsg('{"t":"input","dir":"diagonal"}')).toBeNull()
    expect(parseSnakeClientMsg('{"t":"input","dir":null}')).toBeNull() // no null/keep — sent only on change
    expect(parseSnakeClientMsg('{"t":"input"}')).toBeNull() // missing dir
    expect(parseSnakeClientMsg('{"t":"hello"}')).toBeNull() // missing name
  })

  it('rejects oversized raw (> MAX_RAW)', () => {
    const raw = `{"t":"hello","name":"${'a'.repeat(9000)}"}`
    expect(raw.length).toBeGreaterThan(MAX_RAW)
    expect(parseSnakeClientMsg(raw)).toBeNull()
  })

  it('never throws on garbage', () => {
    expect(parseSnakeClientMsg(null)).toBeNull()
    expect(parseSnakeClientMsg(undefined)).toBeNull()
    expect(parseSnakeClientMsg(42)).toBeNull()
    expect(parseSnakeClientMsg({})).toBeNull()
    expect(parseSnakeClientMsg([])).toBeNull()
    expect(parseSnakeClientMsg('\u0000\u0001\u0002binary-ish\uffff')).toBeNull()
    expect(parseSnakeClientMsg('{"t":"hello","name":')).toBeNull() // truncated JSON
    expect(parseSnakeClientMsg('not json at all')).toBeNull()
  })

  it('rejects a non-object JSON value', () => {
    expect(parseSnakeClientMsg('42')).toBeNull()
    expect(parseSnakeClientMsg('null')).toBeNull()
    expect(parseSnakeClientMsg('[1,2,3]')).toBeNull()
  })
})

describe('parseSnakeServerMsg', () => {
  it('valid start/snap/end pass', () => {
    const start = { t: 'start', you: 1, seed: 7, names: ['a', 'b', 'c', 'd'], bots: [false, true, false, true] }
    expect(parseSnakeServerMsg(JSON.stringify(start))).toEqual(start)

    const good = toWire(midMatchState())
    const snap = { t: 'snap', state: good }
    expect(parseSnakeServerMsg(JSON.stringify(snap))).toEqual(snap)

    const end = { t: 'end', result: [0, 2] }
    expect(parseSnakeServerMsg(JSON.stringify(end))).toEqual(end)

    const draw = { t: 'end', result: [1] }
    expect(parseSnakeServerMsg(JSON.stringify(draw))).toEqual(draw)
  })

  it('rejects non-JSON and unknown t', () => {
    expect(parseSnakeServerMsg('nonsense')).toBeNull()
    expect(parseSnakeServerMsg('{"t":"wat"}')).toBeNull()
  })

  it('rejects a start with wrong-typed or missing fields', () => {
    expect(parseSnakeServerMsg('{"t":"start","you":-1,"seed":7,"names":["a","b","c","d"],"bots":[true,true,true,true]}')).toBeNull() // bad player id
    expect(parseSnakeServerMsg('{"t":"start","you":1,"seed":"7","names":["a","b","c","d"],"bots":[true,true,true,true]}')).toBeNull() // seed not number
    expect(parseSnakeServerMsg('{"t":"start","you":1,"seed":7,"names":["a","b","c"],"bots":[true,true,true,true]}')).toBeNull() // wrong names length
    expect(parseSnakeServerMsg('{"t":"start","you":1,"seed":7,"names":["a","b","c","d"],"bots":[true,true,true]}')).toBeNull() // wrong bots length
    expect(parseSnakeServerMsg(`{"t":"start","you":1,"seed":7,"names":["${'a'.repeat(25)}","b","c","d"],"bots":[true,true,true,true]}`)).toBeNull() // name over 24-char cap
  })

  it('rejects oversized raw (> MAX_RAW)', () => {
    const bigNames = JSON.stringify(Array(4).fill('x'.repeat(2000)))
    const raw = `{"t":"start","you":0,"seed":1,"names":${bigNames},"bots":[true,true,true,true]}`
    expect(raw.length).toBeGreaterThan(MAX_RAW)
    expect(parseSnakeServerMsg(raw)).toBeNull()
  })

  it('rejects a snap with out-of-bounds coordinates', () => {
    const good = toWire(midMatchState())
    const snake0 = good.snakes[0]! as unknown[]
    const tampered = { ...good, snakes: [[...snake0.slice(0, 7), 999999999, snake0[8], snake0[9]]] }
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: tampered }))).toBeNull() // headX absurd
    const tamperedY = { ...good, snakes: [[...snake0.slice(0, 8), 999999999, snake0[9]]] }
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: tamperedY }))).toBeNull() // headY absurd
    expect(
      parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: { ...good, food: [[999999999, 1]] } })),
    ).toBeNull() // food coord absurd
  })

  it('rejects a snap with an absurd segment count', () => {
    const good = toWire(midMatchState())
    const snake0 = good.snakes[0]! as unknown[]
    const tampered = { ...good, snakes: [[...snake0.slice(0, 9), [[1, 1000000000]]]] }
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: tampered }))).toBeNull()
  })

  it('rejects a snap whose segment counts SUM exceeds GRID_CELLS (cumulative body cap)', () => {
    const good = toWire(midMatchState())
    const snake0 = good.snakes[0]! as unknown[]
    // Each segment count is individually valid (≤ GRID_CELLS) and there are only 2
    // segments (≤ GRID_CELLS), so every existing per-field check passes — but the SUM
    // decodes into ~4000 cells, far more than the grid holds (GRID_W*GRID_H = 2240).
    const tampered = { ...good, snakes: [[...snake0.slice(0, 9), [[1, 2000], [2, 2000]]]] }
    expect(GRID_W * GRID_H).toBe(2240)
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: tampered }))).toBeNull()
  })

  it('rejects a snap with a malformed or truncated WireState', () => {
    const good = toWire(midMatchState())
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: { ...good, tick: -1 } }))).toBeNull()
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: { ...good, result: [9] } }))).toBeNull()
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap' }))).toBeNull() // missing state
    expect(parseSnakeServerMsg(JSON.stringify({ t: 'snap', state: { ...good, snakes: [[0, 'a']] } }))).toBeNull() // truncated tuple
  })

  it('validates the Result shape on end', () => {
    expect(parseSnakeServerMsg('{"t":"end","result":[9]}')).toBeNull()
    expect(parseSnakeServerMsg('{"t":"end","result":[0,-1]}')).toBeNull()
    expect(parseSnakeServerMsg('{"t":"end","result":[0,99]}')).toBeNull()
    expect(parseSnakeServerMsg('{"t":"end","result":null}')).toBeNull() // end requires a settled result
  })

  it('never throws on garbage', () => {
    expect(parseSnakeServerMsg(null)).toBeNull()
    expect(parseSnakeServerMsg(undefined)).toBeNull()
    expect(parseSnakeServerMsg(42)).toBeNull()
    expect(parseSnakeServerMsg({})).toBeNull()
    expect(parseSnakeServerMsg([])).toBeNull()
    expect(parseSnakeServerMsg('\u0000\u0001\u0002binary-ish\uffff')).toBeNull()
    expect(parseSnakeServerMsg('{"t":"snap","state":')).toBeNull() // truncated JSON
    expect(parseSnakeServerMsg('not json at all')).toBeNull()
  })

  it('rejects a non-object JSON value', () => {
    expect(parseSnakeServerMsg('42')).toBeNull()
    expect(parseSnakeServerMsg('null')).toBeNull()
    expect(parseSnakeServerMsg('[1,2,3]')).toBeNull()
  })
})
