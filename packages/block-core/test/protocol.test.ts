import { describe, expect, it } from 'vitest'
import { BOARD_W, TOTAL_ROWS } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { KINDS } from '../src/pieces.js'
import { step } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { GameEvent } from '../src/state.js'
import {
  BATCH_TICKS,
  MAX_RAW,
  fromWire,
  parseBlockClientMsg,
  parseBlockServerMsg,
  toWire,
  toWirePlayer,
  type WireState,
} from '../src/protocol.js'

const NAMES = ['alice', 'bob']
const BOTS = [false, false]

const TAPE: GameEvent[] = ['rotCW', 'left', 'left', 'softDrop', 'hardDrop', 'hold', 'right', 'rotCCW', 'hardDrop']

function runDuel(seed: number, upTo: number) {
  let m = createMatch(seed, NAMES, BOTS)
  let i0 = 0
  let i1 = 0
  for (let t = 1; t <= upTo; t++) {
    const e0: GameEvent[] = t % 31 === 0 ? [TAPE[i0++ % TAPE.length]!] : []
    const e1: GameEvent[] = t % 37 === 0 ? [TAPE[i1++ % TAPE.length]!] : []
    m = step(m, [e0, e1])
  }
  return m
}

describe('round-trip', () => {
  it('fromWire(toWire(m)) deep-equals a fresh createMatch', () => {
    const m = createMatch(7, NAMES, BOTS)
    expect(fromWire(toWire(m))).toEqual(m)
  })

  it('fromWire(toWire(m)) deep-equals a mid-duel state (tick 300)', () => {
    const m = runDuel(7, 300)
    expect(fromWire(toWire(m))).toEqual(m)
  })
})

describe('hex-row board codec', () => {
  it('spot pin: cell (0,23)=8 and (9,4)=1 produce hand-checked row strings', () => {
    const m = createMatch(1, NAMES, BOTS)
    const board = [...m.players[0]!.board]
    board[bIdx(0, 23)] = 8
    board[bIdx(9, 4)] = 1
    const p = { ...m.players[0]!, board }
    const wp = toWirePlayer(p)
    const rows = wp[5]
    expect(rows).toHaveLength(TOTAL_ROWS)
    // row 23: column 0 is '8', rest '0'
    expect(rows[23]).toBe('8000000000')
    // row 4: column 9 is '1', rest '0'
    expect(rows[4]).toBe('0000000001')
    // every row is exactly 10 hex-nibble chars in [0-8]
    for (const row of rows) expect(row).toMatch(/^[0-8]{10}$/)
  })
})

describe('snapshot size pin', () => {
  it('worst-case toWire(worst) snap payload stays under 2048 bytes', () => {
    const base = createMatch(1, NAMES, BOTS)
    const worstBoard = (): number[] => {
      const b = new Array<number>(TOTAL_ROWS * BOARD_W)
      for (let y = 0; y < TOTAL_ROWS; y++) {
        for (let x = 0; x < BOARD_W; x++) {
          b[bIdx(x, y)] = ((x + y) % 2 === 0) ? 8 : 1
        }
      }
      return b
    }
    const worstQueue = (): (typeof KINDS)[number][] => {
      const q: (typeof KINDS)[number][] = []
      for (let i = 0; i < 16; i++) q.push(KINDS[i % KINDS.length]!)
      return q
    }
    const worstPending = () => {
      const arr: { rows: number; holeCol: number }[] = []
      for (let i = 0; i < 40; i++) arr.push({ rows: 20, holeCol: 9 })
      return arr
    }
    const worstPlayer = (id: number) => ({
      ...base.players[id]!,
      id,
      name: 'x'.repeat(24),
      tick: 999999,
      board: worstBoard(),
      queue: worstQueue(),
      bagRng: 0xffffffff,
      hold: 'I' as const,
      holdUsed: true,
      fallCooldown: 20,
      lockTicks: 10,
      lockResets: 15,
      pendingGarbage: worstPending(),
      linesCleared: 999999,
      linesSent: 999999,
    })
    const worst = {
      players: [worstPlayer(0), worstPlayer(1)] as [ReturnType<typeof worstPlayer>, ReturnType<typeof worstPlayer>],
      garbageRng: 0xffffffff,
      result: null,
    }
    const payload = JSON.stringify({ t: 'snap', state: toWire(worst) })
    expect(payload.length).toBeLessThan(2048)
  })
})

describe('parseBlockClientMsg hardening', () => {
  it('accepts a legal InputMsg', () => {
    const raw = JSON.stringify({ t: 'input', seq: 3, upTo: 15, events: [[10, 0], [12, 5]] })
    const parsed = parseBlockClientMsg(raw)
    expect(parsed).toEqual({ t: 'input', seq: 3, upTo: 15, events: [[10, 0], [12, 5]] })
  })

  it('accepts a legal HelloMsg', () => {
    const parsed = parseBlockClientMsg(JSON.stringify({ t: 'hello', name: 'Player-One!!' }))
    expect(parsed).toEqual({ t: 'hello', name: 'player-one' })
  })

  it('rejects raw longer than MAX_RAW', () => {
    const huge = JSON.stringify({ t: 'hello', name: 'x'.repeat(MAX_RAW) })
    expect(huge.length).toBeGreaterThan(MAX_RAW)
    expect(parseBlockClientMsg(huge)).toBeNull()
  })

  it('rejects an event code of 7 (out of 0-6 range)', () => {
    const raw = JSON.stringify({ t: 'input', seq: 1, upTo: 5, events: [[3, 7]] })
    expect(parseBlockClientMsg(raw)).toBeNull()
  })

  it('rejects an event tick greater than upTo', () => {
    const raw = JSON.stringify({ t: 'input', seq: 1, upTo: 5, events: [[6, 0]] })
    expect(parseBlockClientMsg(raw)).toBeNull()
  })

  it('rejects seq -1', () => {
    const raw = JSON.stringify({ t: 'input', seq: -1, upTo: 5, events: [] })
    expect(parseBlockClientMsg(raw)).toBeNull()
  })

  it('rejects too many events in a batch', () => {
    const events: [number, number][] = []
    for (let i = 0; i < 200; i++) events.push([i, 0])
    const raw = JSON.stringify({ t: 'input', seq: 1, upTo: 500, events })
    expect(parseBlockClientMsg(raw)).toBeNull()
  })

  it('rejects non-JSON garbage', () => {
    expect(parseBlockClientMsg('{not json')).toBeNull()
  })

  it('rejects valid-JSON-wrong-shape', () => {
    expect(parseBlockClientMsg(JSON.stringify({ t: 'input', seq: 1 }))).toBeNull()
    expect(parseBlockClientMsg(JSON.stringify({ foo: 'bar' }))).toBeNull()
    expect(parseBlockClientMsg(JSON.stringify([1, 2, 3]))).toBeNull()
  })
})

describe('parseBlockServerMsg hardening', () => {
  it('accepts a legal round-tripped SnapMsg', () => {
    const m = createMatch(9, NAMES, BOTS)
    const raw = JSON.stringify({ t: 'snap', state: toWire(m) })
    const parsed = parseBlockServerMsg(raw)
    expect(parsed).not.toBeNull()
    if (parsed && parsed.t === 'snap') {
      expect(fromWire(parsed.state)).toEqual(m)
    }
  })

  it('accepts a legal round-tripped mid-duel SnapMsg', () => {
    const m = runDuel(11, 300)
    const raw = JSON.stringify({ t: 'snap', state: toWire(m) })
    const parsed = parseBlockServerMsg(raw)
    expect(parsed).not.toBeNull()
    if (parsed && parsed.t === 'snap') {
      expect(fromWire(parsed.state)).toEqual(m)
    }
  })

  it('accepts a snap whose active piece is I rot1 at x=-2 (vertical I in column 0)', () => {
    const m = createMatch(9, NAMES, BOTS)
    const p0 = { ...m.players[0]!, piece: { kind: 'I' as const, rot: 1 as const, x: -2, y: 5 } }
    const m2 = { ...m, players: [p0, m.players[1]!] as [typeof p0, typeof m.players[1]] }
    const raw = JSON.stringify({ t: 'snap', state: toWire(m2) })
    const parsed = parseBlockServerMsg(raw)
    expect(parsed).not.toBeNull()
    if (parsed && parsed.t === 'snap') {
      expect(fromWire(parsed.state)).toEqual(m2)
    }
  })

  it('accepts a snap with a JLSTZ piece at rot1 x=-1 (left wall)', () => {
    const m = createMatch(9, NAMES, BOTS)
    const p0 = { ...m.players[0]!, piece: { kind: 'T' as const, rot: 1 as const, x: -1, y: 5 } }
    const m2 = { ...m, players: [p0, m.players[1]!] as [typeof p0, typeof m.players[1]] }
    const parsed = parseBlockServerMsg(JSON.stringify({ t: 'snap', state: toWire(m2) }))
    expect(parsed).not.toBeNull()
    if (parsed && parsed.t === 'snap') {
      expect(fromWire(parsed.state)).toEqual(m2)
    }
  })

  it('rejects a piece whose cells fall out of the board (I rot1 x=-3)', () => {
    const m = createMatch(9, NAMES, BOTS)
    const state = toWire(m) as WireState
    const bad: WireState = {
      ...state,
      players: [
        { ...state.players[0], 6: [1, 1, -3, 5] } as WireState['players'][0],
        state.players[1],
      ],
    }
    expect(parseBlockServerMsg(JSON.stringify({ t: 'snap', state: bad }))).toBeNull()
  })

  it('rejects a piece with an absurd raw coordinate magnitude', () => {
    const m = createMatch(9, NAMES, BOTS)
    const state = toWire(m) as WireState
    const bad: WireState = {
      ...state,
      players: [
        { ...state.players[0], 6: [1, 1, 2, 1e9] } as WireState['players'][0],
        state.players[1],
      ],
    }
    expect(parseBlockServerMsg(JSON.stringify({ t: 'snap', state: bad }))).toBeNull()
  })

  it('rejects a StartMsg whose seed is not a non-negative integer', () => {
    expect(parseBlockServerMsg(JSON.stringify({ t: 'start', you: 0, seed: 1.5, names: ['a', 'b'], bots: [false, false] }))).toBeNull()
    expect(parseBlockServerMsg(JSON.stringify({ t: 'start', you: 0, seed: -1, names: ['a', 'b'], bots: [false, false] }))).toBeNull()
  })

  it('rejects a board row that is not valid hex-nibble digits', () => {
    const m = createMatch(9, NAMES, BOTS)
    const state = toWire(m) as WireState
    const bad: WireState = {
      ...state,
      players: [
        { ...state.players[0], 5: state.players[0][5].map((r, i) => (i === 0 ? 'zzzzzzzzzz' : r)) } as WireState['players'][0],
        state.players[1],
      ],
    }
    const raw = JSON.stringify({ t: 'snap', state: bad })
    expect(parseBlockServerMsg(raw)).toBeNull()
  })

  it('rejects a board with only 23 rows', () => {
    const m = createMatch(9, NAMES, BOTS)
    const state = toWire(m) as WireState
    const shortRows = state.players[0][5].slice(0, 23)
    const bad: WireState = {
      ...state,
      players: [
        { ...state.players[0], 5: shortRows } as WireState['players'][0],
        state.players[1],
      ],
    }
    const raw = JSON.stringify({ t: 'snap', state: bad })
    expect(parseBlockServerMsg(raw)).toBeNull()
  })

  it('rejects a name 300 chars long', () => {
    const m = createMatch(9, NAMES, BOTS)
    const state = toWire(m) as WireState
    const bad: WireState = {
      ...state,
      players: [
        { ...state.players[0], 1: 'x'.repeat(300) } as WireState['players'][0],
        state.players[1],
      ],
    }
    const raw = JSON.stringify({ t: 'snap', state: bad })
    expect(parseBlockServerMsg(raw)).toBeNull()
  })

  it('rejects non-JSON garbage', () => {
    expect(parseBlockServerMsg('not json at all {{{')).toBeNull()
  })

  it('rejects valid-JSON-wrong-shape', () => {
    expect(parseBlockServerMsg(JSON.stringify({ t: 'snap' }))).toBeNull()
    expect(parseBlockServerMsg(JSON.stringify({ t: 'garbage', rows: 1 }))).toBeNull()
    expect(parseBlockServerMsg(JSON.stringify('just a string'))).toBeNull()
  })

  it('rejects raw longer than MAX_RAW', () => {
    const huge = JSON.stringify({ t: 'end', result: [0, 0], pad: 'y'.repeat(MAX_RAW) })
    expect(huge.length).toBeGreaterThan(MAX_RAW)
    expect(parseBlockServerMsg(huge)).toBeNull()
  })

  it('accepts a legal StartMsg', () => {
    const raw = JSON.stringify({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, true] })
    expect(parseBlockServerMsg(raw)).toEqual({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, true] })
  })

  it('accepts a legal GarbageMsg', () => {
    const raw = JSON.stringify({ t: 'garbage', rows: 2, holeCol: 4, atTick: 100 })
    expect(parseBlockServerMsg(raw)).toEqual({ t: 'garbage', rows: 2, holeCol: 4, atTick: 100 })
  })

  it('accepts a legal EndMsg (win)', () => {
    const raw = JSON.stringify({ t: 'end', result: [0, 1] })
    expect(parseBlockServerMsg(raw)).toEqual({ t: 'end', result: [0, 1] })
  })

  it('accepts a legal EndMsg (draw)', () => {
    const raw = JSON.stringify({ t: 'end', result: [1] })
    expect(parseBlockServerMsg(raw)).toEqual({ t: 'end', result: [1] })
  })
})

describe('BATCH_TICKS constant', () => {
  it('is 5', () => {
    expect(BATCH_TICKS).toBe(5)
  })
})
