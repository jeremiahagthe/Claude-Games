import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createMatch, MAX_PLAYERS, parseSnakeServerMsg, type SnakeServerMsg, type MatchState } from 'snakewait-core'
import { SnakeLobbyQueue, type LobbyOutcome } from '../src/snake-lobby.js'
import { SnakeMatchDO, SnakeMatchHost, parseSnakeMatchId, type SnakeConn } from '../src/snake-match.js'

function conn(): SnakeConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

function lastMsg(c: { sent: string[] }): SnakeServerMsg {
  const msg = parseSnakeServerMsg(c.sent.at(-1)!)
  if (!msg) throw new Error('no valid message sent')
  return msg
}

function outcomeCapture(): { outcomes: LobbyOutcome[]; resolve: (o: LobbyOutcome) => void } {
  const outcomes: LobbyOutcome[] = []
  return { outcomes, resolve: (o) => outcomes.push(o) }
}

describe('SnakeLobbyQueue', () => {
  it('the 4th joiner fills the room — every waiter (including itself) resolves immediately, humanCount 4', () => {
    const q = new SnakeLobbyQueue()
    const w1 = outcomeCapture()
    const w2 = outcomeCapture()
    const w3 = outcomeCapture()
    expect(q.join('m1', 0, w1.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    expect(q.join('m2', 1_000, w2.resolve)).toEqual({ filled: false, isNewRoom: false, matchId: 'm1' })
    expect(q.join('m3', 2_000, w3.resolve)).toEqual({ filled: false, isNewRoom: false, matchId: 'm1' })
    expect(w1.outcomes).toHaveLength(0)
    const w4 = outcomeCapture()
    expect(q.join('m4', 3_000, w4.resolve)).toEqual({ filled: true, matchId: 'm1' })
    for (const w of [w1, w2, w3, w4]) expect(w.outcomes).toEqual([{ matchId: 'm1', humanCount: 4 }])
  })

  it('1 human after the window expires gets a match with humanCount 1 (never blocked, never noOpponent)', () => {
    const q = new SnakeLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    q.expire('m1')
    expect(waiter.outcomes).toEqual([{ matchId: 'm1', humanCount: 1 }])
  })

  it('expire() is a no-op once the room already filled (never double-resolves)', () => {
    const q = new SnakeLobbyQueue()
    const w1 = outcomeCapture()
    q.join('m1', 0, w1.resolve)
    q.join('m2', 1_000, outcomeCapture().resolve)
    q.join('m3', 1_500, outcomeCapture().resolve)
    q.join('m4', 2_000, outcomeCapture().resolve)
    q.expire('m1')
    expect(w1.outcomes).toHaveLength(1)
  })
})

const VALID_ID = 'a'.repeat(64)

describe('parseSnakeMatchId', () => {
  it('extracts a well-formed 64-char hex DO id from the ws path', () => {
    expect(parseSnakeMatchId(`/snake/match/${VALID_ID}/ws`)).toBe(VALID_ID)
  })
  it('rejects anything that is not exactly 64 lowercase hex chars', () => {
    expect(parseSnakeMatchId('/snake/match/abc123/ws')).toBeNull()
    expect(parseSnakeMatchId(`/snake/match/${VALID_ID}f/ws`)).toBeNull()
    expect(parseSnakeMatchId('/snake/match//ws')).toBeNull()
    expect(parseSnakeMatchId('/match/abc123/ws')).toBeNull()
  })
})

describe('SnakeMatchHost', () => {
  it('4 humans join → match starts with 0 bots', () => {
    const host = new SnakeMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['alice', 'bob', 'cara', 'dee']
    conns.forEach((c, i) => {
      const j = host.join(c, names[i]!)
      expect(j).not.toBeNull()
      expect(j?.connId).toBe(i)
    })
    expect(conns[3]!.sent).toHaveLength(1)
    const start = lastMsg(conns[0]!)
    if (start.t !== 'start') throw new Error('expected start')
    expect(start.bots).toEqual([false, false, false, false])
    expect(start.names).toEqual(names)
    const start3 = lastMsg(conns[3]!)
    if (start3.t !== 'start') throw new Error('expected start')
    expect(start3.you).toBe(3)
  })

  it('1 human after the gather window → match starts with 3 bots (difficulty normal), never blocked waiting for humans', () => {
    const host = new SnakeMatchHost(1)
    const c = conn()
    const j = host.join(c, 'solo')
    expect(j).toEqual({ connId: 0, started: true })
    const start = lastMsg(c)
    if (start.t !== 'start') throw new Error('expected start')
    expect(start.you).toBe(0)
    expect(start.bots).toEqual([false, true, true, true])
    expect(start.names[0]).toBe('solo')
  })

  it('a join beyond humanCount, or after start, is rejected', () => {
    const host = new SnakeMatchHost(1)
    host.join(conn(), 'solo')
    expect(host.join(conn(), 'late')).toBeNull()
  })

  it('tick() advances the sim, feeding botDecide for bot slots (state ticks up each call)', () => {
    const host = new SnakeMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    const before = c.sent.length
    const status = host.tick()
    expect(status).toEqual({ type: 'running' })
    expect(c.sent.length).toBe(before + 1)
    const snap = lastMsg(c)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.tick).toBe(1)
  })

  it('a client InputMsg turns that slot\'s snake — one-shot latch consumed into exactly one step(), asserted by position after a real move', () => {
    const host = new SnakeMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!))

    // slot 0 spawns heading 'right' at (7,4); a 'down' turn is perpendicular (never a
    // rejected 180) and pends until the sim's stepCooldown completes the tile.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'down' }))
    let snap: SnakeServerMsg | null = null
    for (let i = 0; i < 6; i++) {
      host.tick()
      snap = lastMsg(conns[0]!)
    }
    if (!snap || snap.t !== 'snap') throw new Error('expected snap')
    const mySnake = snap.state.snakes.find((s) => s[0] === 0)!
    // wire index 7,8 = head x,y; original heading 'right' would have moved x rightward from
    // 7 without ever decreasing y. The turn is proven by the head's y actually changing.
    expect(mySnake[8]).toBeGreaterThan(4)
  })

  it('inputs before match start are rejected without crashing (no host yet)', () => {
    const host = new SnakeMatchHost(2)
    const c = conn()
    host.join(c, 'solo')
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'up' }))).not.toThrow()
  })

  it('garbage or oversized ws messages are dropped without crashing the host', () => {
    const host = new SnakeMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    expect(() => host.handleMessage(0, 'not json')).not.toThrow()
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input' }))).not.toThrow()
    expect(() => host.handleMessage(0, 'x'.repeat(5000))).not.toThrow()
    expect(() => host.handleMessage(99, JSON.stringify({ t: 'input', dir: 'up' }))).not.toThrow()
    expect(host.tick().type).toBe('running')
  })

  it('disconnect starts a 5s grace, then the snake dies in-sim and decays to food via killSnake', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const host = new SnakeMatchHost(2)
      const c0 = conn()
      const c1 = conn()
      host.join(c0, 'solo')
      host.join(c1, 'stays')

      host.leave(0)
      vi.setSystemTime(1_000_000 + 4_000)
      host.tick()
      let snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      let mine = snap.state.snakes.find((s) => s[0] === 0)!
      expect(mine[3]).toBe(1) // still alive: grace not elapsed yet

      vi.setSystemTime(1_000_000 + 5_100)
      host.tick()
      snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      mine = snap.state.snakes.find((s) => s[0] === 0)!
      expect(mine[3]).toBe(0) // dead: grace elapsed
      const foodCells = new Set(snap.state.food.map(([x, y]) => `${x},${y}`))
      expect(foodCells.size).toBeGreaterThan(0) // corpse decayed to food
    } finally {
      vi.useRealTimers()
    }
  })

  // --- start deadline (socket no-show) ---------------------------------------------------

  it('start deadline: 2 of 3 promised humans connected → force-start with 2 humans + 2 bots', () => {
    const host = new SnakeMatchHost(3)
    const c1 = conn()
    const c2 = conn()
    host.join(c1, 'one')
    host.join(c2, 'two')
    expect(host.hasStarted()).toBe(false)
    expect(c1.sent).toHaveLength(0)
    expect(host.forceStart()).toBe('started')
    expect(host.hasStarted()).toBe(true)
    const s1 = lastMsg(c1)
    if (s1.t !== 'start') throw new Error('expected start')
    expect(s1.bots).toEqual([false, false, true, true])
    expect(s1.names.slice(0, 2)).toEqual(['one', 'two'])
    expect(host.join(conn(), 'late')).toBeNull()
    expect(host.tick().type).toBe('running')
  })

  it('start deadline with zero connected sockets → empty (room is tombstoned, no start ever sent)', () => {
    const host = new SnakeMatchHost(2)
    expect(host.forceStart()).toBe('empty')
    expect(host.hasStarted()).toBe(false)
  })

  // --- pre-start churn: final player slots are assigned at START, not at hello ------------

  it('hello A, hello B, A leaves pre-start, deadline fires → B gets a human slot with their own name and their inputs drive it', () => {
    const host = new SnakeMatchHost(3)
    const cA = conn()
    const cB = conn()
    const jA = host.join(cA, 'aye')!
    const jB = host.join(cB, 'bee')!
    host.leave(jA.connId)
    expect(host.forceStart()).toBe('started')

    const startB = lastMsg(cB)
    if (startB.t !== 'start') throw new Error('expected start')
    expect(startB.you).toBe(0)
    expect(startB.bots).toEqual([false, true, true, true])
    expect(startB.names[0]).toBe('bee')
    expect(cA.sent).toHaveLength(0)
    expect(jB.connId).not.toBe(jA.connId) // monotonic connIds
  })

  // --- result → EndMsg → ended -----------------------------------------------------------

  it('when step() stamps a result: final snap (result included) + EndMsg broadcast, tick returns ended, host inert after', () => {
    const host = new SnakeMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!))
    const base = createMatch(5, names, [false, false, false, false])
    const nearEnd: MatchState = { ...base, snakes: base.snakes.map((s) => (s.id === 0 ? s : { ...s, alive: false, cells: [] })) }
    ;(host as unknown as { state: MatchState }).state = nearEnd

    const sentBefore = conns[1]!.sent.length
    expect(host.tick()).toEqual({ type: 'ended' })
    for (const c of conns) {
      expect(c.sent.length).toBe(sentBefore + 2)
      const snap = parseSnakeServerMsg(c.sent.at(-2)!)
      if (snap?.t !== 'snap') throw new Error('expected final snap')
      expect(snap.state.result).toEqual([0, 0])
      const end = parseSnakeServerMsg(c.sent.at(-1)!)
      if (end?.t !== 'end') throw new Error('expected end')
      expect(end.result).toEqual([0, 0])
    }
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'up' }))).not.toThrow()
    expect(() => host.leave(0)).not.toThrow()
    expect(host.tick()).toEqual({ type: 'empty' })
    expect(conns[0]!.sent.length).toBe(sentBefore + 2)
  })
})

// Minimal fake of the ambient (types-only) Workers WebSocketPair/WebSocket/DurableObjectState
// globals, mirroring bomber.test.ts's harness.
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
  vi.stubGlobal(
    'Response',
    class {
      constructor(
        public body: unknown,
        public init: unknown,
      ) {}
    },
  )
}

describe('SnakeMatchDO', () => {
  it('an empty room (last human disconnects mid-match) tombstones on the next alarm; later close/message races do not throw', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new SnakeMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/snake/match/${VALID_ID}/ws?token=1`))
      const sock = pairs[0]![1]!
      sock.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'solo' }) })
      expect(sock.sent).toHaveLength(1)

      sock.dispatch('close')
      await doInstance.alarm()

      expect(() => sock.dispatch('close')).not.toThrow()
      expect(() => sock.dispatch('message', { data: JSON.stringify({ t: 'input', dir: 'up' }) })).not.toThrow()
      await expect(doInstance.alarm()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a malformed token without crashing (closes instead of upgrading into a broken room)', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new SnakeMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/snake/match/${VALID_ID}/ws?token=nope`))
      const sock = pairs[0]![1]!
      expect(sock.closedWith?.code).toBe(1002)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('arms the start deadline at host creation; when it fires with 2 of 3 humans helloed, the match force-starts and ticks', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new SnakeMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/snake/match/${VALID_ID}/ws?token=3`))
      expect(calls.setAlarm).toBe(1)
      await doInstance.fetch(fakeRequest(`https://x/snake/match/${VALID_ID}/ws?token=3`))
      expect(calls.setAlarm).toBe(1)
      const s1 = pairs[0]![1]!
      const s2 = pairs[1]![1]!
      s1.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'one' }) })
      s2.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'two' }) })
      expect(s1.sent).toHaveLength(0)

      await doInstance.alarm()
      const start = parseSnakeServerMsg(s1.sent.at(-1)!)
      if (start?.t !== 'start') throw new Error('expected start')
      expect(start.bots).toEqual([false, false, true, true])
      expect(calls.setAlarm).toBe(2)

      await doInstance.alarm()
      const snap = parseSnakeServerMsg(s2.sent.at(-1)!)
      expect(snap?.t).toBe('snap')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('start deadline with zero helloed humans → tombstone, no start ever sent', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new SnakeMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/snake/match/${VALID_ID}/ws?token=2`))
      const sock = pairs[0]![1]!

      await doInstance.alarm()
      expect(calls.deleteAlarm).toBe(1)
      expect(sock.sent).toHaveLength(0)
      await expect(doInstance.alarm()).resolves.toBeUndefined()
      expect(calls.setAlarm).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wrangler.jsonc migrations', () => {
  it('append-only: v1..v5 tags present in order; v1-v4 untouched', () => {
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
      expect.arrayContaining(['MATCH', 'LOBBY', 'CHESS_LOBBY', 'CHESS_MATCH', 'BOMBER_LOBBY', 'BOMBER_MATCH', 'SNAKE_LOBBY', 'SNAKE_MATCH']),
    )
  })
})

describe('MAX_PLAYERS', () => {
  it('is 4', () => {
    expect(MAX_PLAYERS).toBe(4)
  })
})
