import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createMatch, fromWire, isWall, MAX_PLAYERS, parseSnakeServerMsg, type SnakeServerMsg, type MatchState } from 'snakewait-core'
import { SnakeLobbyQueue, SnakeLobbyDO, type LobbyOutcome } from '../src/snake-lobby.js'
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

// tick() is now time-derived (see snake-match.ts): it runs floor((nowMs - startMs)/TICK_MS) sim
// steps, bounded, instead of exactly one per call. peekStartMs reads the wall-clock zero recorded
// at start(); T_MS mirrors the host's TICK_MS.
function peekStartMs(host: SnakeMatchHost): number {
  return (host as unknown as { startMs: number }).startMs
}
function peekState(host: SnakeMatchHost): MatchState {
  return (host as unknown as { state: MatchState }).state
}
const T_MS = 1000 / 20 // 50ms wall tick, mirrors the host's TICK_MS
// Advancing wall clock: each call lands exactly one 50ms tick later than the last, so tick() runs
// exactly one sim step per call (target - state.tick === 1) — the pre-fix one-step-per-alarm cadence
// every existing assertion was written against. Mirrors block.test.ts's startMs + k*T_MS driving.
function ticker(host: SnakeMatchHost): () => ReturnType<SnakeMatchHost['tick']> {
  let k = 0
  return () => host.tick(peekStartMs(host) + ++k * T_MS)
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

describe('SnakeLobbyDO', () => {
  it('POST /snake/join with an empty {} body → 400 (absent name)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new SnakeLobbyDO({} as unknown as DurableObjectState, { SNAKE_MATCH: {} } as never)
      const res = (await doInst.fetch({ method: 'POST', json: async () => ({}) } as unknown as Request)) as unknown as { init: { status: number } }
      expect(res.init.status).toBe(400)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('POST /snake/join with a malformed / missing body → 400 (never throws)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new SnakeLobbyDO({} as unknown as DurableObjectState, { SNAKE_MATCH: {} } as never)
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
    const status = host.tick(peekStartMs(host) + T_MS) // one 50ms tick elapsed → exactly one sim step
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
    const tk = ticker(host) // advancing wall clock → exactly one sim step per call
    let snap: SnakeServerMsg | null = null
    for (let i = 0; i < 6; i++) {
      tk()
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
    expect(host.tick(peekStartMs(host) + T_MS).type).toBe('running')
  })

  it('disconnect starts a 5s grace, then the snake dies in-sim and decays to food specifically at its own even-indexed pre-death corpse cells (not merely "food exists somewhere")', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const host = new SnakeMatchHost(2)
      const c0 = conn()
      const c1 = conn()
      host.join(c0, 'solo')
      host.join(c1, 'stays') // start() records startMs = 1_000_000
      const tk = ticker(host) // sim clock: startMs + k*T_MS → exactly one sim step per call

      // tick() derives sim progress from the passed nowMs, while grace is measured against the
      // disconnect's own wall-time -- two independent clocks. Record the disconnect ~4.9s "before"
      // the sim's tick-2 instant so grace elapses between tick 1 and tick 2, while each tick still
      // advances exactly one step -- the corpse-cell reconstruction below (and the exact-set check)
      // depend on precisely one kill-then-step, exactly as the pre-fix one-step-per-tick path gave.
      vi.setSystemTime(1_000_000 - 4_925) // disconnectedAt = 995_075
      host.leave(0)
      tk() // tick 1 (nowMs 1_000_050): grace = 1_000_050 - 995_075 = 4975ms < 5000 → still alive
      let snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      let mine = snap.state.snakes.find((s) => s[0] === 0)!
      expect(mine[3]).toBe(1) // still alive: grace not elapsed yet

      // Reconstruct the about-to-die snake's real cell list from this pre-death snapshot
      // (killSnake fires at the TOP of the next tick(), before step() moves anything, so
      // these are exactly the cells the corpse-food rule will consume) and record the food
      // set as it stood before the kill. Vacuity check: assert against ONLY the initial food
      // (the bug this replaces) would trivially pass here too, since food already exists at
      // t+4000 -- proving the old assertion never actually exercised the corpse-food rule.
      const foodBefore = new Set(snap.state.food.map(([x, y]) => `${x},${y}`))
      expect(foodBefore.size).toBeGreaterThan(0) // the vacuous old assertion's target: initial food already present here
      const preDeathSnake = fromWire(snap.state).snakes.find((s) => s.id === 0)!
      const expectedCorpseCells = new Set<string>()
      for (let ci = 0; ci < preDeathSnake.cells.length; ci += 2) {
        const c = preDeathSnake.cells[ci]!
        const key = `${c.x},${c.y}`
        if (!isWall(c.x, c.y, fromWire(snap.state).rings) && !foodBefore.has(key)) expectedCorpseCells.add(key)
      }
      expect(expectedCorpseCells.size).toBeGreaterThan(0) // non-vacuity: there's a real corpse-cell set to prove landing on

      tk() // tick 2 (nowMs 1_000_100): grace = 1_000_100 - 995_075 = 5025ms ≥ 5000 → killed in-sim
      snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      mine = snap.state.snakes.find((s) => s[0] === 0)!
      expect(mine[3]).toBe(0) // dead: grace elapsed

      const foodAfter = new Set(snap.state.food.map(([x, y]) => `${x},${y}`))
      const newFood = new Set([...foodAfter].filter((k) => !foodBefore.has(k)))
      expect(newFood.size).toBeGreaterThan(0) // corpse decayed to NEW food (not just pre-existing food)
      // The exact set of new food cells must equal the dead snake's own even-indexed
      // pre-death corpse cells -- this would FAIL if the corpse-food rule were broken (e.g.
      // no food appearing, food appearing at the wrong/odd-indexed cells, or at some other
      // snake's cells), unlike the old assertion which only checked food.length > 0.
      expect(newFood).toEqual(expectedCorpseCells)
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
    expect(host.tick(peekStartMs(host) + T_MS).type).toBe('running')
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
    expect(host.tick(peekStartMs(host) + T_MS)).toEqual({ type: 'ended' }) // one step stamps the result
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
    expect(host.tick(peekStartMs(host) + 2 * T_MS)).toEqual({ type: 'empty' }) // ended: inert regardless of clock
    expect(conns[0]!.sent.length).toBe(sentBefore + 2)
  })

  it('production alarm latency (~75ms) must not slow the match: sim ticks track real elapsed time, not the alarm count', () => {
    // Reproduces the live ~35% slowdown: Cloudflare alarm processing + reschedule latency stretched
    // the effective alarm period to ~75ms, so a per-alarm-counted sim advanced at ~13Hz instead of
    // the designed 20Hz — the whole match ran uniformly slow. A TIME-DERIVED tick runs as many 20Hz
    // steps as real elapsed time calls for, so the sim tracks wall time regardless of the alarm rate.
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    try {
      // 4 humans, zero input: no snake dies within this window (verified across seeds), so the match
      // never ends and state.tick is a clean, deterministic readout of how many sim steps ran.
      const host = new SnakeMatchHost(4)
      for (const n of ['a', 'b', 'c', 'd']) host.join(conn(), n)
      const startMs = peekStartMs(host)
      for (let alarm = 1; alarm <= 40; alarm++) {
        const nowMs = startMs + alarm * 75 // alarms arrive every ~75ms (the stretched live period)
        vi.setSystemTime(nowMs)
        host.tick(nowMs)
      }
      // 40 alarms ≈ 3s of real time. Time-derived: floor(3000 / 50) = 60 sim ticks. A per-alarm
      // counter would sit at 40 (the ~13Hz sag). Each 75ms alarm advances the sim by 1–2 steps
      // (never near MAX_CATCHUP_STEPS = 4), so no catch-up is dropped.
      expect(peekState(host).tick).toBe(60)
    } finally {
      vi.useRealTimers()
    }
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
    // Fake timers: tick() is time-derived, so the tick-phase alarm must see ≥ one TICK_MS of wall
    // time elapse past the force-start instant (startMs) to run a sim step and broadcast a snap.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
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

      await doInstance.alarm() // deadline fires pre-start → force-start records startMs = now
      const start = parseSnakeServerMsg(s1.sent.at(-1)!)
      if (start?.t !== 'start') throw new Error('expected start')
      expect(start.bots).toEqual([false, false, true, true])
      expect(calls.setAlarm).toBe(2)

      vi.setSystemTime(1_000_000 + 60) // ≥ one 50ms tick past startMs → the tick alarm runs a step
      await doInstance.alarm()
      const snap = parseSnakeServerMsg(s2.sent.at(-1)!)
      expect(snap?.t).toBe('snap')
    } finally {
      vi.useRealTimers()
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
  // v1/v2/v3/v4 tags/contents are pinned exactly and must never be edited (append-only); later
  // migrations (e.g. v5 for blockwait — see block.test.ts for its own exact literal check) are
  // deliberately NOT constrained to an exact array length here, so this test doesn't need
  // editing every time a new game's migration is appended.
  it('append-only: v1, v2, v3, v4 tags present in order at the front; v1/v2/v3/v4 untouched', () => {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')) as {
      migrations: { tag: string; new_sqlite_classes: string[] }[]
      durable_objects: { bindings: { name: string; class_name: string }[] }
    }
    expect(parsed.migrations.slice(0, 4).map((m) => m.tag)).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(parsed.migrations[0]).toEqual({ tag: 'v1', new_sqlite_classes: ['MatchDO', 'LobbyDO'] })
    expect(parsed.migrations[1]).toEqual({ tag: 'v2', new_sqlite_classes: ['ChessLobbyDO', 'ChessMatchDO'] })
    expect(parsed.migrations[2]).toEqual({ tag: 'v3', new_sqlite_classes: ['BomberLobbyDO', 'BomberMatchDO'] })
    expect(parsed.migrations[3]).toEqual({ tag: 'v4', new_sqlite_classes: ['SnakeLobbyDO', 'SnakeMatchDO'] })
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
