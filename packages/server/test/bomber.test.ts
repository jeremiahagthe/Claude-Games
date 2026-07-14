import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createMatch, MAX_PLAYERS, parseBomberServerMsg, type BomberServerMsg, type BomberState } from 'boomwait-core'
import { BomberLobbyQueue, type LobbyOutcome } from '../src/bomber-lobby.js'
import { BomberMatchDO, BomberMatchHost, parseBomberMatchId, type BomberConn } from '../src/bomber-match.js'

function conn(): BomberConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

function lastMsg(c: { sent: string[] }): BomberServerMsg {
  const msg = parseBomberServerMsg(c.sent.at(-1)!)
  if (!msg) throw new Error('no valid message sent')
  return msg
}

function outcomeCapture(): { outcomes: LobbyOutcome[]; resolve: (o: LobbyOutcome) => void } {
  const outcomes: LobbyOutcome[] = []
  return { outcomes, resolve: (o) => outcomes.push(o) }
}

describe('BomberLobbyQueue', () => {
  it('the 4th joiner fills the room — every waiter (including itself) resolves immediately, humanCount 4', () => {
    const q = new BomberLobbyQueue()
    const w1 = outcomeCapture()
    const w2 = outcomeCapture()
    const w3 = outcomeCapture()
    expect(q.join('m1', 0, w1.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    expect(q.join('m2', 1_000, w2.resolve)).toEqual({ filled: false, isNewRoom: false, matchId: 'm1' })
    expect(q.join('m3', 2_000, w3.resolve)).toEqual({ filled: false, isNewRoom: false, matchId: 'm1' })
    expect(w1.outcomes).toHaveLength(0) // nobody resolved yet
    const w4 = outcomeCapture()
    expect(q.join('m4', 3_000, w4.resolve)).toEqual({ filled: true, matchId: 'm1' })
    for (const w of [w1, w2, w3, w4]) expect(w.outcomes).toEqual([{ matchId: 'm1', humanCount: 4 }])
  })

  it('1 human after the window expires gets a match with humanCount 1 (never blocked, never noOpponent)', () => {
    const q = new BomberLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    q.expire('m1') // the room-creator's own ~10s timeout fires
    expect(waiter.outcomes).toEqual([{ matchId: 'm1', humanCount: 1 }])
  })

  it('a partially-filled room displaced by a late joiner resolves its waiters honestly, never a dead matchId', () => {
    const q = new BomberLobbyQueue()
    const stale1 = outcomeCapture()
    const stale2 = outcomeCapture()
    q.join('m1', 0, stale1.resolve)
    q.join('m2', 1_000, stale2.resolve)
    const fresh = outcomeCapture()
    expect(q.join('m3', 10_001, fresh.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm3' }) // too late to join m1
    expect(stale1.outcomes).toEqual([{ matchId: 'm1', humanCount: 2 }])
    expect(stale2.outcomes).toEqual([{ matchId: 'm1', humanCount: 2 }])
    q.expire('m1') // stale room's own timer fires afterward: must not double-resolve
    expect(stale1.outcomes).toHaveLength(1)
    expect(fresh.outcomes).toHaveLength(0) // the new room is untouched
  })

  it('expire() is a no-op once the room already filled (never double-resolves)', () => {
    const q = new BomberLobbyQueue()
    const w1 = outcomeCapture()
    q.join('m1', 0, w1.resolve)
    q.join('m2', 1_000, outcomeCapture().resolve)
    q.join('m3', 1_500, outcomeCapture().resolve)
    q.join('m4', 2_000, outcomeCapture().resolve) // fills, resolves + clears the room
    q.expire('m1')
    expect(w1.outcomes).toHaveLength(1) // exactly once, from the fill
  })
})

const VALID_ID = 'a'.repeat(64)

describe('parseBomberMatchId', () => {
  it('extracts a well-formed 64-char hex DO id from the ws path', () => {
    expect(parseBomberMatchId(`/bomber/match/${VALID_ID}/ws`)).toBe(VALID_ID)
  })
  it('rejects anything that is not exactly 64 lowercase hex chars', () => {
    expect(parseBomberMatchId('/bomber/match/abc123/ws')).toBeNull()
    expect(parseBomberMatchId(`/bomber/match/${VALID_ID}f/ws`)).toBeNull()
    expect(parseBomberMatchId('/bomber/match//ws')).toBeNull()
    expect(parseBomberMatchId('/match/abc123/ws')).toBeNull()
    expect(parseBomberMatchId(`/bomber/match/${'A'.repeat(64)}/ws`)).toBeNull()
  })
})

describe('BomberMatchHost', () => {
  it('4 humans join → match starts with 0 bots', () => {
    const host = new BomberMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['alice', 'bob', 'cara', 'dee']
    conns.forEach((c, i) => {
      const j = host.join(c, names[i]!)
      expect(j).not.toBeNull()
      expect(j?.connId).toBe(i)
    })
    expect(conns[3]!.sent).toHaveLength(1) // start fires the instant the 4th joins
    const start = lastMsg(conns[0]!)
    if (start.t !== 'start') throw new Error('expected start')
    expect(start.bots).toEqual([false, false, false, false])
    expect(start.names).toEqual(names)
    const start3 = lastMsg(conns[3]!)
    if (start3.t !== 'start') throw new Error('expected start')
    expect(start3.you).toBe(3)
  })

  it('1 human after the gather window → match starts with 3 bots, never blocked waiting for humans', () => {
    const host = new BomberMatchHost(1)
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
    const host = new BomberMatchHost(1)
    host.join(conn(), 'solo')
    expect(host.join(conn(), 'late')).toBeNull()
  })

  it('tick() advances the sim at 20Hz, feeding botDecide for bot slots (state ticks up each call)', () => {
    const host = new BomberMatchHost(1)
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

  it('a client InputMsg drives tap-to-step — a dir moves one tile then the buffer is consumed, keep re-buffers a held dir mid-cooldown, an explicit null stops', () => {
    const host = new BomberMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!))

    // player 0 spawns at (1,1); (2,1) is guaranteed clear (spawn-pocket tile, never a soft
    // block), so this single hop is deterministic regardless of the match's random seed.
    // wire index 9 is the dir buffer (dirCode); index 10 is stepCooldown.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'right', bomb: false }))
    host.tick()
    let snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect([snap.state.players[0]![3], snap.state.players[0]![4]]).toEqual([2, 1]) // moved one tile to (2,1)
    expect(snap.state.players[0]![9]).toBe(0)  // buffer CONSUMED by the step (tap-to-step: one press → one tile)
    expect(snap.state.players[0]![10]).toBeGreaterThan(0) // now mid-cooldown

    // 'keep' re-feeds the held direction. This tick is mid-cooldown so no move happens, but the
    // buffer is set back to 'right' — proving 'keep' sustains a held direction (hold-to-run)
    // rather than being dropped. Seed-independent (position unchanged either way).
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'keep', bomb: false }))
    host.tick()
    snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.players[0]![9]).toBe(4) // dirCode 'right' — held direction re-buffered, not lost

    // an explicit null (the client's one-shot latch releasing) is an authoritative stop: the
    // buffer is cleared this tick, so the player will not take another step.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: null, bomb: false }))
    host.tick()
    snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.players[0]![9]).toBe(0) // buffer cleared → standing still
  })

  it('a queued bomb is not dropped when a dir-change InputMsg lands in the same tick (unsynchronized 50ms client/server clocks can coalesce two client ticks into one server tick)', () => {
    const host = new BomberMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!))

    // "bomb then run": first InputMsg queues the bomb (dir kept), second InputMsg (same tick,
    // before the server has consumed the latch) changes direction and does NOT re-request the
    // bomb -- the pending one-shot must survive the overwrite and still be placed this tick.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'keep', bomb: true }))
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'right', bomb: false }))
    host.tick()
    const snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.bombs).toHaveLength(1) // the queued bomb was placed, not silently dropped
    expect(snap.state.bombs[0]![0]).toBe(0) // owner: player 0's bomb, not lost to the dir-change overwrite
  })

  it('inputs before match start are rejected without crashing (no host yet)', () => {
    const host = new BomberMatchHost(2)
    const c = conn()
    host.join(c, 'solo') // only 1 of 2 humans joined: not started yet
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'up', bomb: false }))).not.toThrow()
  })

  it('disconnect starts a 5s grace, then the player is eliminated but their placed bombs still resolve', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      // Two humans: player 1 stays connected throughout so the room never goes empty and the
      // tick loop keeps running long enough for player 0's grace window to be observed.
      const host = new BomberMatchHost(2)
      const c0 = conn()
      const c1 = conn()
      host.join(c0, 'solo')
      host.join(c1, 'stays')
      host.handleMessage(0, JSON.stringify({ t: 'input', dir: null, bomb: true }))
      host.tick() // places player 0's bomb at their spawn tile
      let snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      expect(snap.state.bombs).toHaveLength(1)

      host.leave(0) // player 0's socket closes: grace period starts, no immediate elimination
      vi.setSystemTime(1_000_000 + 4_000)
      host.tick()
      snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      expect(snap.state.players[0]![5]).toBe(1) // still alive: grace not elapsed yet
      expect(snap.state.bombs).toHaveLength(1) // bomb still ticking down

      vi.setSystemTime(1_000_000 + 5_100)
      host.tick()
      snap = lastMsg(c1)
      if (snap.t !== 'snap') throw new Error('expected snap')
      expect(snap.state.players[0]![5]).toBe(0) // eliminated once the grace elapses
      expect(snap.state.bombs).toHaveLength(1) // their already-placed bomb is untouched by elimination
    } finally {
      vi.useRealTimers()
    }
  })

  it('garbage or oversized ws messages are dropped without crashing the host', () => {
    const host = new BomberMatchHost(1)
    const c = conn()
    host.join(c, 'solo')
    expect(() => host.handleMessage(0, 'not json')).not.toThrow()
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input' }))).not.toThrow() // missing fields
    expect(() => host.handleMessage(0, 'x'.repeat(5000))).not.toThrow() // over MAX_RAW
    expect(() => host.handleMessage(99, JSON.stringify({ t: 'input', dir: 'up', bomb: false }))).not.toThrow() // unknown player id
    expect(host.tick().type).toBe('running') // host is still healthy afterward
  })

  // --- start deadline (socket no-show) ---------------------------------------------------
  // The lobby promised humanCount humans, but getting {matchId, token} from POST /bomber/join
  // and actually opening the ws are separate steps -- a client can vanish in between (Ctrl-C).
  // Without a deadline, the players who DID connect wait forever: start() only fires at
  // conns.size === humanCount, and no alarm runs pre-start.

  it('start deadline: 2 of 3 promised humans connected → force-start with 2 humans + 2 bots', () => {
    const host = new BomberMatchHost(3)
    const c1 = conn()
    const c2 = conn()
    host.join(c1, 'one')
    host.join(c2, 'two')
    expect(host.hasStarted()).toBe(false)
    expect(c1.sent).toHaveLength(0) // still gathering: no start yet
    expect(host.forceStart()).toBe('started')
    expect(host.hasStarted()).toBe(true)
    const s1 = lastMsg(c1)
    if (s1.t !== 'start') throw new Error('expected start')
    expect(s1.bots).toEqual([false, false, true, true]) // the no-show became a bot
    expect(s1.names.slice(0, 2)).toEqual(['one', 'two'])
    const s2 = lastMsg(c2)
    if (s2.t !== 'start') throw new Error('expected start')
    expect(s2.you).toBe(1)
    expect(host.join(conn(), 'late')).toBeNull() // the no-show finally arriving is rejected
    expect(host.tick().type).toBe('running') // tick loop runs normally after a force-start
  })

  it('start deadline with zero connected sockets → empty (room is tombstoned, no start ever sent)', () => {
    const host = new BomberMatchHost(2)
    expect(host.forceStart()).toBe('empty')
    expect(host.hasStarted()).toBe(false)
  })

  it('all promised humans connect before the deadline → starts immediately; a late deadline fire is a no-op', () => {
    const host = new BomberMatchHost(2)
    const c1 = conn()
    const c2 = conn()
    host.join(c1, 'a')
    host.join(c2, 'b')
    expect(host.hasStarted()).toBe(true)
    expect(c1.sent).toHaveLength(1)
    expect(host.forceStart()).toBe('started') // idempotent: already started
    expect(c1.sent).toHaveLength(1) // no duplicate StartMsg
  })

  // --- pre-start churn: final player slots are assigned at START, not at hello ------------
  // Ids handed out at hello time are unstable under pre-start disconnects: with slot = "join
  // order at hello", A(0) B(1) then A leaving pre-start leaves a gap at 0, and a force-start
  // that counts conns would map connected-human B onto a bot slot (their inputs ignored all
  // match). Clients only ever learn their slot from StartMsg.you, so assigning final slots at
  // start() by compacting the surviving connections in join order is free -- and it also
  // keeps each surviving human paired with their OWN name.

  it('hello A, hello B, A leaves pre-start, deadline fires → B gets a human slot with their own name and their inputs drive it', () => {
    const host = new BomberMatchHost(3)
    const cA = conn()
    const cB = conn()
    const jA = host.join(cA, 'aye')!
    const jB = host.join(cB, 'bee')!
    host.leave(jA.connId) // A vanishes before the match starts
    expect(host.forceStart()).toBe('started')

    const startB = lastMsg(cB)
    if (startB.t !== 'start') throw new Error('expected start')
    expect(startB.you).toBe(0) // compacted: B is the only human left
    expect(startB.bots).toEqual([false, true, true, true]) // B's slot is a HUMAN slot (no bot mind)
    expect(startB.names[0]).toBe('bee') // B's own name, not A's stale one
    expect(cA.sent).toHaveLength(0) // the departed socket got nothing

    // B's InputMsg must actually drive slot 0's latch in tick() -- a bot mind on that slot
    // would override it. Slot 0 spawns at (1,1); (2,1) is a spawn-pocket tile, always clear.
    host.handleMessage(jB.connId, JSON.stringify({ t: 'input', dir: 'right', bomb: false }))
    expect(host.tick().type).toBe('running')
    const snap = lastMsg(cB)
    if (snap.t !== 'snap') throw new Error('expected snap')
    // The rightward move to (2,1) is itself the proof B's latch drives slot 0 (a bot mind would
    // pick its own direction). Under tap-to-step the dir buffer is consumed by that step, so the
    // wire dir reads 0 afterward.
    expect([snap.state.players[0]![3], snap.state.players[0]![4]]).toEqual([2, 1]) // B's 'right' moved slot 0
    expect(snap.state.players[0]![9]).toBe(0) // buffer consumed by the step (tap-to-step)
  })

  it('hello A, hello B, A leaves, C hellos → no id collision; both live humans control distinct human slots', () => {
    const host = new BomberMatchHost(3)
    const cA = conn()
    const cB = conn()
    const cC = conn()
    const jA = host.join(cA, 'aye')!
    const jB = host.join(cB, 'bee')!
    host.leave(jA.connId)
    const jC = host.join(cC, 'cee')!
    expect(jC.connId).not.toBe(jB.connId) // monotonic keys: C must not collide with B
    expect(host.hasStarted()).toBe(false) // 2 of 3 connected: still gathering

    expect(host.forceStart()).toBe('started')
    const startB = lastMsg(cB)
    const startC = lastMsg(cC)
    if (startB.t !== 'start' || startC.t !== 'start') throw new Error('expected start')
    expect(startB.you).toBe(0) // join order preserved: B before C
    expect(startC.you).toBe(1)
    expect(startB.bots).toEqual([false, false, true, true])
    expect(startB.names.slice(0, 2)).toEqual(['bee', 'cee'])
    expect(cA.sent).toHaveLength(0)

    // Each human's input routes to their OWN slot. Slot 1 spawns at (11,1); (10,1) is a
    // spawn-pocket tile, always clear, so C stepping left is deterministic too.
    host.handleMessage(jB.connId, JSON.stringify({ t: 'input', dir: 'right', bomb: false }))
    host.handleMessage(jC.connId, JSON.stringify({ t: 'input', dir: 'left', bomb: false }))
    expect(host.tick().type).toBe('running')
    const snap = lastMsg(cC)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect([snap.state.players[0]![3], snap.state.players[0]![4]]).toEqual([2, 1]) // B moved right
    expect([snap.state.players[1]![3], snap.state.players[1]![4]]).toEqual([10, 1]) // C moved left
  })

  // --- result → EndMsg → ended -----------------------------------------------------------

  it('when step() stamps a result: final snap (result included) + EndMsg broadcast, tick returns ended, host inert after', () => {
    const host = new BomberMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!)) // 4 humans: zero bot minds, fully deterministic
    // Hand-craft a near-end state via the core's public createMatch: players 1-3 already dead,
    // so the very next step() sees one survivor and stamps {kind:'win', winner:0}.
    const base = createMatch(5, names, [false, false, false, false])
    const nearEnd: BomberState = { ...base, players: base.players.map((p) => (p.id === 0 ? p : { ...p, alive: false })) }
    ;(host as unknown as { state: BomberState }).state = nearEnd

    const sentBefore = conns[1]!.sent.length
    expect(host.tick()).toEqual({ type: 'ended' })
    // Every conn got exactly two messages: the final board snap, then the formal end notice.
    for (const c of conns) {
      expect(c.sent.length).toBe(sentBefore + 2)
      const snap = parseBomberServerMsg(c.sent.at(-2)!)
      if (snap?.t !== 'snap') throw new Error('expected final snap')
      expect(snap.state.result).toEqual([0, 0]) // wire form of {kind:'win', winner:0}
      const end = parseBomberServerMsg(c.sent.at(-1)!)
      if (end?.t !== 'end') throw new Error('expected end')
      expect(end.result).toEqual({ kind: 'win', winner: 0 })
    }
    // Post-end the host is inert: no more broadcasts, no crashes.
    expect(() => host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'up', bomb: false }))).not.toThrow()
    expect(() => host.leave(0)).not.toThrow()
    expect(host.tick()).toEqual({ type: 'empty' })
    expect(conns[0]!.sent.length).toBe(sentBefore + 2) // nothing sent after the end pair
  })
})

// Minimal fake of the ambient (types-only) Workers WebSocketPair/WebSocket/DurableObjectState
// globals, mirroring chess.test.ts's harness -- this repo has no wrangler-runtime test harness,
// so BomberMatchDO itself is otherwise untested. This exists specifically to reproduce the
// empty-room-tombstone / late-event-after-tombstone races: once the last human's socket closes
// mid-match, the next alarm tick sees an empty room and tombstones (host = null); a straggling
// close/message event on that same socket afterward must not throw.
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
  // Real Workers Response supports status 101 + a `webSocket` option; Node's built-in
  // Response rejects 101 outright. Stub it so these tests can exercise fetch()'s return
  // value without tripping over an unrelated environment gap (same as chess.test.ts).
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

describe('BomberMatchDO', () => {
  it('an empty room (last human disconnects mid-match) tombstones on the next alarm; later close/message races do not throw', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new BomberMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=1`))
      const sock = pairs[0]![1]!
      sock.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'solo' }) })
      expect(sock.sent).toHaveLength(1) // start fired: humanCount 1 reached instantly

      sock.dispatch('close') // the only human disconnects
      await doInstance.alarm() // next tick: conns.size === 0 -> empty room -> tombstone

      expect(() => sock.dispatch('close')).not.toThrow() // duplicate close racing after tombstone
      expect(() =>
        sock.dispatch('message', { data: JSON.stringify({ t: 'input', dir: 'up', bomb: false }) }),
      ).not.toThrow()
      await expect(doInstance.alarm()).resolves.toBeUndefined() // host already null: no-op, no throw
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a malformed token without crashing (closes instead of upgrading into a broken room)', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new BomberMatchDO(fakeDoState().state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=nope`))
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
      const doInstance = new BomberMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=3`))
      expect(calls.setAlarm).toBe(1) // deadline armed the moment the room (host) exists
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=3`))
      expect(calls.setAlarm).toBe(1) // not re-armed per socket (that would extend the deadline)
      const s1 = pairs[0]![1]!
      const s2 = pairs[1]![1]!
      s1.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'one' }) })
      s2.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'two' }) })
      expect(s1.sent).toHaveLength(0) // 2 of 3: still gathering, no start

      await doInstance.alarm() // the deadline fires pre-start
      const start = parseBomberServerMsg(s1.sent.at(-1)!)
      if (start?.t !== 'start') throw new Error('expected start')
      expect(start.bots).toEqual([false, false, true, true]) // the no-show backfilled as a bot
      expect(calls.setAlarm).toBe(2) // tick loop armed by the deadline handler

      await doInstance.alarm() // now in the tick phase
      const snap = parseBomberServerMsg(s2.sent.at(-1)!)
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
      const doInstance = new BomberMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=2`))
      const sock = pairs[0]![1]! // socket upgraded but never sends hello

      await doInstance.alarm() // deadline fires: zero humans connected
      expect(calls.deleteAlarm).toBe(1) // alarms stopped: room is dead, not looping
      expect(sock.sent).toHaveLength(0) // no start was ever broadcast
      await expect(doInstance.alarm()).resolves.toBeUndefined() // tombstoned: no-op, no throw
      expect(calls.setAlarm).toBe(1) // only ever the initial deadline; nothing re-armed
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('all humans connect before the deadline → starts immediately; the tick alarm replaces the deadline in the single alarm slot', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new BomberMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=1`))
      const sock = pairs[0]![1]!
      expect(calls.setAlarm).toBe(1) // deadline armed
      sock.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'solo' }) })
      expect(parseBomberServerMsg(sock.sent.at(-1)!)?.t).toBe('start') // started instantly
      expect(calls.setAlarm).toBe(2) // tick alarm overwrote the pending deadline (one alarm slot)

      await doInstance.alarm() // dispatches to the tick phase, not the deadline path
      expect(parseBomberServerMsg(sock.sent.at(-1)!)?.t).toBe('snap')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('result → final snap + EndMsg, alarm deleted, sockets closed game over, tombstone; post-end events safe', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const { state, calls } = fakeDoState()
      const doInstance = new BomberMatchDO(state)
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=1`))
      const sock = pairs[0]![1]!
      sock.dispatch('message', { data: JSON.stringify({ t: 'hello', name: 'solo' }) })
      expect(parseBomberServerMsg(sock.sent.at(-1)!)?.t).toBe('start')

      // Hand-craft a near-end state (players 1-3 dead) so the next tick's step() stamps the
      // win deterministically -- botDecide returns inert inputs for dead players, so the
      // random-seeded bot minds can't influence anything.
      const host = (doInstance as unknown as { host: BomberMatchHost }).host
      const base = createMatch(5, ['solo', 'x', 'y', 'z'], [false, true, true, true])
      const nearEnd: BomberState = { ...base, players: base.players.map((p) => (p.id === 0 ? p : { ...p, alive: false })) }
      ;(host as unknown as { state: BomberState }).state = nearEnd

      await doInstance.alarm() // tick: result stamped -> ended -> tombstone
      const snap = parseBomberServerMsg(sock.sent.at(-2)!)
      if (snap?.t !== 'snap') throw new Error('expected final snap')
      expect(snap.state.result).toEqual([0, 0]) // wire form of {kind:'win', winner:0}
      const end = parseBomberServerMsg(sock.sent.at(-1)!)
      if (end?.t !== 'end') throw new Error('expected end')
      expect(end.result).toEqual({ kind: 'win', winner: 0 })
      expect(calls.deleteAlarm).toBe(1) // alarms stopped
      expect(sock.closedWith).toEqual({ code: 1000, reason: 'game over' })

      const sentAfterEnd = sock.sent.length
      expect(() =>
        sock.dispatch('message', { data: JSON.stringify({ t: 'input', dir: 'up', bomb: false }) }),
      ).not.toThrow() // straggling message after tombstone
      expect(() => sock.dispatch('close')).not.toThrow() // the real close event racing in after
      await expect(doInstance.alarm()).resolves.toBeUndefined() // host already null: no-op
      expect(sock.sent.length).toBe(sentAfterEnd) // nothing sent after the end pair
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wrangler.jsonc migrations', () => {
  // v1/v2/v3 tags/contents are pinned exactly and must never be edited (append-only); later
  // migrations (e.g. v4 for snakewait — see snake.test.ts for its own literal check) are
  // deliberately NOT constrained to an exact array length here, so this test doesn't need
  // editing every time a new game's migration is appended.
  it('append-only: v1, v2, v3 tags present in order at the front; v1/v2/v3 untouched', () => {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')) as {
      migrations: { tag: string; new_sqlite_classes: string[] }[]
      durable_objects: { bindings: { name: string; class_name: string }[] }
    }
    expect(parsed.migrations.slice(0, 3).map((m) => m.tag)).toEqual(['v1', 'v2', 'v3'])
    expect(parsed.migrations[0]).toEqual({ tag: 'v1', new_sqlite_classes: ['MatchDO', 'LobbyDO'] })
    expect(parsed.migrations[1]).toEqual({ tag: 'v2', new_sqlite_classes: ['ChessLobbyDO', 'ChessMatchDO'] })
    expect(parsed.migrations[2]).toEqual({ tag: 'v3', new_sqlite_classes: ['BomberLobbyDO', 'BomberMatchDO'] })
    const names = parsed.durable_objects.bindings.map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining(['MATCH', 'LOBBY', 'CHESS_LOBBY', 'CHESS_MATCH', 'BOMBER_LOBBY', 'BOMBER_MATCH']))
  })
})

// Sanity: MAX_PLAYERS drives both the lobby room size and the match roster —
// pinned here so a future bomber-core bump can't silently desync server assumptions.
describe('MAX_PLAYERS', () => {
  it('is 4', () => {
    expect(MAX_PLAYERS).toBe(4)
  })
})
