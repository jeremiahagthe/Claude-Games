import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MAX_PLAYERS, parseBomberServerMsg, type BomberServerMsg } from 'boomwait-core'
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
      expect(j?.playerId).toBe(i)
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
    expect(j).toEqual({ playerId: 0, started: true })
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

  it('a client InputMsg updates that player\'s latch — dir is applied on the next tick, keep leaves it untouched, null clears it', () => {
    const host = new BomberMatchHost(4)
    const conns = [conn(), conn(), conn(), conn()]
    const names = ['a', 'b', 'c', 'd']
    conns.forEach((c, i) => host.join(c, names[i]!))

    // player 0 spawns at (1,1); (2,1) is guaranteed clear (spawn-pocket tile, never a soft
    // block), so this single hop is deterministic regardless of the match's random seed.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'right', bomb: false }))
    host.tick()
    let snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect([snap.state.players[0]![3], snap.state.players[0]![4]]).toEqual([2, 1]) // x,y moved to (2,1)
    expect(snap.state.players[0]![9]).toBe(4) // dirCode for 'right'

    // 'keep' must not clear the latched direction. Position is mid-cooldown either way (not
    // asserted), so the latch itself (wire dirCode) is the only thing that distinguishes
    // "kept" from "incorrectly cleared" here — and it's deterministic regardless of seed.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: 'keep', bomb: false }))
    host.tick()
    snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.players[0]![9]).toBe(4) // still latched right, not cleared by 'keep'

    // an explicit null clears the latch.
    host.handleMessage(0, JSON.stringify({ t: 'input', dir: null, bomb: false }))
    host.tick()
    snap = lastMsg(conns[0]!)
    if (snap.t !== 'snap') throw new Error('expected snap')
    expect(snap.state.players[0]![9]).toBe(0) // cleared
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

function fakeDoState(): DurableObjectState {
  return { storage: { setAlarm: async () => {}, deleteAlarm: async () => {} } } as unknown as DurableObjectState
}

describe('BomberMatchDO', () => {
  it('an empty room (last human disconnects mid-match) tombstones on the next alarm; later close/message races do not throw', async () => {
    const pairs: FakeSocket[][] = []
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
    try {
      const doInstance = new BomberMatchDO(fakeDoState())
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
    try {
      const doInstance = new BomberMatchDO(fakeDoState())
      await doInstance.fetch(fakeRequest(`https://x/bomber/match/${VALID_ID}/ws?token=nope`))
      const sock = pairs[0]![1]!
      expect(sock.closedWith?.code).toBe(1002)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wrangler.jsonc migrations', () => {
  it('append-only: v1, v2, v3 tags present in order; v1/v2 untouched', () => {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')) as {
      migrations: { tag: string; new_sqlite_classes: string[] }[]
      durable_objects: { bindings: { name: string; class_name: string }[] }
    }
    expect(parsed.migrations.map((m) => m.tag)).toEqual(['v1', 'v2', 'v3'])
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
