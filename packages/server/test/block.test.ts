import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createMatch,
  EVENT_CODES,
  parseBlockServerMsg,
  randStep,
  type BlockServerMsg,
  type GameEvent,
  type MatchState,
} from 'blockwait-core'
import { BlockLobbyQueue, BlockLobbyDO, type LobbyOutcome } from '../src/block-lobby.js'
import { BlockMatchDO, BlockMatchHost, parseBlockMatchId, type BlockConn } from '../src/block-match.js'

const code = (e: GameEvent): number => EVENT_CODES.indexOf(e)

function conn(): BlockConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

function serverMsgs(c: { sent: string[] }): BlockServerMsg[] {
  const out: BlockServerMsg[] = []
  for (const s of c.sent) {
    const m = parseBlockServerMsg(s)
    if (m) out.push(m)
  }
  return out
}

function lastOfType<T extends BlockServerMsg['t']>(c: { sent: string[] }, t: T): Extract<BlockServerMsg, { t: T }> | null {
  for (let i = c.sent.length - 1; i >= 0; i--) {
    const m = parseBlockServerMsg(c.sent[i]!)
    if (m && m.t === t) return m as Extract<BlockServerMsg, { t: T }>
  }
  return null
}

function outcomeCapture(): { outcomes: LobbyOutcome[]; resolve: (o: LobbyOutcome) => void } {
  const outcomes: LobbyOutcome[] = []
  return { outcomes, resolve: (o) => outcomes.push(o) }
}

// Peek at the host's private MatchState (mirrors snake.test.ts's cast) to script boards and read
// per-player clocks directly.
function peekState(host: BlockMatchHost): MatchState {
  return (host as unknown as { state: MatchState }).state
}
function setState(host: BlockMatchHost, s: MatchState): void {
  ;(host as unknown as { state: MatchState }).state = s
}
// The wall clock zero recorded at start() — clients receive StartMsg and start their own tick 0 at
// this instant, so a test drives tick(nowMs) with nowMs = startMs + serverTick * TICK_MS to place
// the server at an intended wall tick.
function peekStartMs(host: BlockMatchHost): number {
  return (host as unknown as { startMs: number }).startMs
}
const T_MS = 1000 / 20 // 50ms wall tick, mirrors the host's TICK_MS

describe('BlockLobbyQueue', () => {
  it('the 2nd joiner fills the room — both waiters resolve immediately, humanCount 2', () => {
    const q = new BlockLobbyQueue()
    const w1 = outcomeCapture()
    expect(q.join('m1', 0, w1.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    expect(w1.outcomes).toHaveLength(0)
    const w2 = outcomeCapture()
    expect(q.join('m2', 1_000, w2.resolve)).toEqual({ filled: true, matchId: 'm1' })
    for (const w of [w1, w2]) expect(w.outcomes).toEqual([{ matchId: 'm1', humanCount: 2 }])
  })

  it('1 human after the window expires gets a match with humanCount 1 (a bot backfills, never blocked)', () => {
    const q = new BlockLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    q.expire('m1')
    expect(waiter.outcomes).toEqual([{ matchId: 'm1', humanCount: 1 }])
  })

  it('expire() is a no-op once the room already filled (never double-resolves)', () => {
    const q = new BlockLobbyQueue()
    const w1 = outcomeCapture()
    q.join('m1', 0, w1.resolve)
    q.join('m2', 500, outcomeCapture().resolve)
    q.expire('m1')
    expect(w1.outcomes).toHaveLength(1)
  })
})

const VALID_ID = 'a'.repeat(64)

describe('parseBlockMatchId', () => {
  it('extracts a well-formed 64-char hex DO id from the ws path', () => {
    expect(parseBlockMatchId(`/block/match/${VALID_ID}/ws`)).toBe(VALID_ID)
  })
  it('rejects anything that is not exactly 64 lowercase hex chars', () => {
    expect(parseBlockMatchId('/block/match/abc123/ws')).toBeNull()
    expect(parseBlockMatchId(`/block/match/${VALID_ID}f/ws`)).toBeNull()
    expect(parseBlockMatchId('/block/match//ws')).toBeNull()
    expect(parseBlockMatchId('/match/abc123/ws')).toBeNull()
  })
})

describe('BlockLobbyDO', () => {
  it('POST /block/join with an empty {} body → 400 (absent name)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new BlockLobbyDO({} as unknown as DurableObjectState, { BLOCK_MATCH: {} } as never)
      const res = (await doInst.fetch({ method: 'POST', json: async () => ({}) } as unknown as Request)) as unknown as { init: { status: number } }
      expect(res.init.status).toBe(400)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('POST /block/join with a malformed / missing body → 400 (never throws)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new BlockLobbyDO({} as unknown as DurableObjectState, { BLOCK_MATCH: {} } as never)
      const res = (await doInst.fetch({
        method: 'POST',
        json: async () => {
          throw new Error('bad json')
        },
      } as unknown as Request)) as unknown as { init: { status: number } }
      expect(res.init.status).toBe(400)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('BlockMatchHost', () => {
  it('2 humans join → match starts with 0 bots', () => {
    const host = new BlockMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    expect(host.join(c0, 'alice')?.connId).toBe(0)
    expect(host.join(c1, 'bob')).toEqual({ connId: 1, started: true })
    const s0 = lastOfType(c0, 'start')!
    expect(s0.bots).toEqual([false, false])
    expect(s0.names).toEqual(['alice', 'bob'])
    expect(lastOfType(c1, 'start')!.you).toBe(1)
  })

  it('1 human after the gather window → match starts with 1 normal bot, never blocked', () => {
    const host = new BlockMatchHost(1)
    const c = conn()
    expect(host.join(c, 'solo')).toEqual({ connId: 0, started: true })
    const s = lastOfType(c, 'start')!
    expect(s.you).toBe(0)
    expect(s.bots).toEqual([false, true])
    expect(s.names[0]).toBe('solo')
  })

  it('a join beyond humanCount, or after start, is rejected', () => {
    const host = new BlockMatchHost(1)
    host.join(conn(), 'solo')
    expect(host.join(conn(), 'late')).toBeNull()
  })

  it('a valid InputMsg batch moves that slot\'s piece (asserted by piece x on the next snap)', () => {
    const host = new BlockMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    const x0 = (peekState(host).players[0].piece!).x
    // seq 0, upTo 3, a single 'left' stamped at tick 1 → advances slot 0 from tick 0 to 3.
    host.handleMessage(0, JSON.stringify({ t: 'input', seq: 0, upTo: 3, events: [[1, code('left')]] }))
    // Five 50ms-spaced alarms → wallTick reaches 5 (snap fires on the 5th alarm), same as before.
    for (let i = 1; i <= 5; i++) host.tick(peekStartMs(host) + i * T_MS)
    const snap = lastOfType(c, 'snap')!
    const piece = snap.state.players[0][6]
    if (piece === 0) throw new Error('expected a live piece')
    expect(piece[2]).toBe(x0 - 1) // moved one column left, gravity leaves x untouched
    expect(snap.state.players[0][4]).toBe(3) // board advanced exactly to upTo
  })

  it('a batch with upTo > wallTick + LEAD_TICKS is dropped silently (board unchanged)', () => {
    const host = new BlockMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    const x0 = (peekState(host).players[0].piece!).x
    // At the first alarm wallTick is 1; LEAD_TICKS is 5, so upTo 7 is 1 past the lead cap → drop.
    host.handleMessage(0, JSON.stringify({ t: 'input', seq: 0, upTo: 7, events: [[1, code('left')]] }))
    // The batch is drained on the FIRST alarm, where wallTick is 1 and upTo 7 > 1 + LEAD_TICKS(5) →
    // dropped and the buffer cleared, so the later ticks never see it. Same as the old +1 clock.
    for (let i = 1; i <= 5; i++) host.tick(peekStartMs(host) + i * T_MS)
    const snap = lastOfType(c, 'snap')!
    const piece = snap.state.players[0][6]
    if (piece === 0) throw new Error('expected a live piece')
    expect(piece[2]).toBe(x0) // never moved
    expect(snap.state.players[0][4]).toBe(0) // human slot never advanced (no valid batch)
  })

  it('a silent human is force-advanced past LAG_TICKS with empty inputs (tick grows without batches)', () => {
    const host = new BlockMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    // 30 alarms at 50ms → wallTick reaches 30; floor = 30 - LAG_TICKS(25) = 5.
    for (let i = 1; i <= 30; i++) host.tick(peekStartMs(host) + i * T_MS)
    expect(peekState(host).players[0].tick).toBe(5)
  })

  it('a scripted double on slot 0 lands 1 garbage row on slot 1 + a matching garbage msg (holeCol/atTick)', () => {
    const host = new BlockMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'atk')
    host.join(c1, 'vic')

    // Script slot 0: two bottom rows full except column 0, and a vertical I hovering over column
    // 0. A hardDrop fills column 0 rows 22-23 → a 2-line clear → attack 1 (ATTACK[2]).
    const base = createMatch(123, ['atk', 'vic'], [false, false])
    const board = new Array<number>(24 * 10).fill(0)
    for (const y of [22, 23]) for (let x = 1; x < 10; x++) board[y * 10 + x] = 1
    const KNOWN_RNG = 0x1234abcd
    setState(host, {
      players: [
        { ...base.players[0], tick: 0, board, piece: { kind: 'I', rot: 1, x: -2, y: 2 }, pendingGarbage: [], alive: true },
        { ...base.players[1], tick: 0, pendingGarbage: [], alive: true },
      ],
      garbageRng: KNOWN_RNG,
      result: null,
    })
    const expectedHole = Math.floor(randStep(KNOWN_RNG).value * 10)

    host.handleMessage(0, JSON.stringify({ t: 'input', seq: 0, upTo: 1, events: [[1, code('hardDrop')]] }))
    host.tick(peekStartMs(host) + T_MS) // one 50ms alarm → wallTick 1, so the upTo-1 batch is in-window

    const p1 = peekState(host).players[1]
    expect(p1.pendingGarbage).toEqual([{ rows: 1, holeCol: expectedHole }])
    const garbage = lastOfType(c1, 'garbage')!
    expect(garbage.rows).toBe(1)
    expect(garbage.holeCol).toBe(expectedHole)
    expect(garbage.atTick).toBe(0) // the victim's own clock when the garbage was queued
  })

  it('garbage or oversized ws messages are dropped without crashing the host', () => {
    const host = new BlockMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    expect(() => host.handleMessage(0, 'not json')).not.toThrow()
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input' }))).not.toThrow()
    expect(() => host.handleMessage(0, 'x'.repeat(9000))).not.toThrow()
    expect(() => host.handleMessage(99, JSON.stringify({ t: 'input', seq: 0, upTo: 1, events: [] }))).not.toThrow()
    expect(host.tick(peekStartMs(host) + T_MS).type).toBe('running')
  })

  it('inputs before match start are rejected without crashing (no host state yet)', () => {
    const host = new BlockMatchHost(2)
    const c = conn()
    host.join(c, 'solo')
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input', seq: 0, upTo: 1, events: [] }))).not.toThrow()
  })

  it('disconnect starts a 5s grace, then the board is killed in-sim → the opponent wins, end broadcast', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const host = new BlockMatchHost(2)
      const c0 = conn()
      const c1 = conn()
      const j0 = host.join(c0, 'leaver')!
      host.join(c1, 'stays')

      host.leave(j0.connId)
      vi.setSystemTime(1_000_000 + 4_000)
      expect(host.tick(Date.now()).type).toBe('running') // grace not elapsed
      expect(lastOfType(c1, 'end')).toBeNull()

      vi.setSystemTime(1_000_000 + 5_100)
      expect(host.tick(Date.now()).type).toBe('ended') // grace elapsed → forfeit
      const end = lastOfType(c1, 'end')!
      expect(end.result).toEqual([0, 1]) // slot 1 (the one who stayed) wins
    } finally {
      vi.useRealTimers()
    }
  })

  it('production alarm latency (~75ms) must not starve inputs: time-derived wallTick tracks the client clock', () => {
    // Reproduces the live starvation: Cloudflare alarm processing + reschedule latency stretched the
    // effective alarm period to ~75ms, so an alarm-COUNTED wallTick advanced at ~13Hz while the client
    // ticks a true 20Hz via setInterval. Within ~1s every batch's upTo outran wallTick + LEAD_TICKS and
    // applyOneBatch dropped EVERY batch forever; the board stalled at the force-advance floor
    // (~wallTick - LAG_TICKS). A TIME-DERIVED wallTick tracks real elapsed, so batches stay accepted.
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    try {
      const host = new BlockMatchHost(1)
      const c = conn()
      host.join(c, 'solo') // start() records startMs = 2_000_000 (client's tick-0 instant)
      const startMs = peekStartMs(host)
      let seq = 0
      let lastUpTo = 0
      for (let alarm = 1; alarm <= 40; alarm++) {
        const nowMs = startMs + alarm * 75 // alarms arrive every ~75ms (the stretched period)
        const clientTick = Math.floor((alarm * 75) / T_MS) // client's true 20Hz clock: elapsed / 50
        if (clientTick > lastUpTo) {
          host.handleMessage(0, JSON.stringify({ t: 'input', seq: seq++, upTo: clientTick, events: [] }))
          lastUpTo = clientTick
        }
        vi.setSystemTime(nowMs)
        host.tick(nowMs)
      }
      // 40 alarms ≈ 3s of real time → the client is at tick 60. Every batch was accepted, so the board
      // followed upTo to 60 — NOT stalled near an alarm-counted wallTick(40) - LAG_TICKS(25) = 15.
      expect(peekState(host).players[0].tick).toBe(60)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Minimal fake of the ambient Workers WebSocketPair/WebSocket/DurableObjectState globals,
// mirroring snake.test.ts's harness.
class FakeSocket {
  sent: string[] = []
  closedWith: { code: number; reason: string } | null = null
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  accept(): void {}
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(code: number, reason: string): void {
    this.closedWith = { code, reason }
  }
  dispatch(type: string, ev: unknown = {}): void {
    for (const cb of [...(this.listeners[type] ?? [])]) cb(ev)
  }
}

function fakeRequest(url: string): Request {
  return {
    headers: { get: (h: string) => (h === 'Upgrade' ? 'websocket' : null) },
    url,
  } as unknown as Request
}

function fakeDoState(): { state: DurableObjectState; calls: { setAlarm: number; deleteAlarm: number } } {
  const calls = { setAlarm: 0, deleteAlarm: 0 }
  const state = {
    storage: {
      setAlarm: async () => {
        calls.setAlarm++
      },
      deleteAlarm: async () => {
        calls.deleteAlarm++
      },
    },
  } as unknown as DurableObjectState
  return { state, calls }
}

function stubWorkersGlobals(pairs: FakeSocket[][]): void {
  vi.stubGlobal(
    'WebSocketPair',
    class {
      constructor() {
        const pair = [new FakeSocket(), new FakeSocket()]
        pairs.push(pair)
        return pair as unknown as [FakeSocket, FakeSocket]
      }
    },
  )
  vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
}

describe('BlockMatchDO', () => {
  it('an empty room (last human disconnects) tombstones on the next alarm; later races do not throw', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new BlockMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/block/match/${VALID_ID}/ws?token=1`))
      const sock = pairs[0]![1]!
      sock.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'solo' }) })
      expect(sock.sent).toHaveLength(1) // start

      sock.dispatch('close')
      await doInstance.alarm()

      expect(() => sock.dispatch('close')).not.toThrow()
      expect(() => sock.dispatch('message', { data: JSON.stringify({ t: 'input', seq: 0, upTo: 1, events: [] }) })).not.toThrow()
      await expect(doInstance.alarm()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a malformed token without crashing (closes instead of upgrading into a broken room)', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new BlockMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/block/match/${VALID_ID}/ws?token=nope`))
      expect(pairs[0]![1]!.closedWith?.code).toBe(1002)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('arms the start deadline at host creation; when it fires with 1 of 2 humans helloed, force-starts and ticks', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new BlockMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/block/match/${VALID_ID}/ws?token=2`))
      expect(calls.setAlarm).toBe(1) // start deadline armed once at host creation
      const s1 = pairs[0]![1]!
      s1.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'one' }) })
      expect(s1.sent).toHaveLength(0) // not enough humans → no start yet

      await doInstance.alarm() // deadline fires → force-start with 1 human + 1 bot
      const start = parseBlockServerMsg(s1.sent.at(-1)!)
      if (start?.t !== 'start') throw new Error('expected start')
      expect(start.bots).toEqual([false, true])
      expect(calls.setAlarm).toBe(2) // entered tick phase

      await doInstance.alarm()
      // running: another alarm scheduled, no tombstone
      expect(calls.setAlarm).toBe(3)
      expect(calls.deleteAlarm).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('start deadline with zero helloed humans → tombstone, no start ever sent', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new BlockMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/block/match/${VALID_ID}/ws?token=2`))
      const sock = pairs[0]![1]!

      await doInstance.alarm()
      expect(calls.deleteAlarm).toBe(1)
      expect(sock.sent).toHaveLength(0)
      await expect(doInstance.alarm()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wrangler.jsonc migrations', () => {
  it('append-only: v1..v5 tags present in order; v1-v4 byte-identical; BLOCK bindings added', () => {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')) as {
      migrations: { tag: string; new_sqlite_classes: string[] }[]
      durable_objects: { bindings: { name: string; class_name: string }[] }
    }
    expect(parsed.migrations.map((m) => m.tag)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5'])
    expect(parsed.migrations[0]).toEqual({ tag: 'v1', new_sqlite_classes: ['MatchDO', 'LobbyDO'] })
    expect(parsed.migrations[1]).toEqual({ tag: 'v2', new_sqlite_classes: ['ChessLobbyDO', 'ChessMatchDO'] })
    expect(parsed.migrations[2]).toEqual({ tag: 'v3', new_sqlite_classes: ['BomberLobbyDO', 'BomberMatchDO'] })
    expect(parsed.migrations[3]).toEqual({ tag: 'v4', new_sqlite_classes: ['SnakeLobbyDO', 'SnakeMatchDO'] })
    expect(parsed.migrations[4]).toEqual({ tag: 'v5', new_sqlite_classes: ['BlockLobbyDO', 'BlockMatchDO'] })
    const names = parsed.durable_objects.bindings.map((b) => b.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'MATCH', 'LOBBY', 'CHESS_LOBBY', 'CHESS_MATCH', 'BOMBER_LOBBY', 'BOMBER_MATCH',
        'SNAKE_LOBBY', 'SNAKE_MATCH', 'BLOCK_LOBBY', 'BLOCK_MATCH',
      ]),
    )
  })
})
