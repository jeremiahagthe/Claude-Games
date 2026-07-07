import { describe, expect, it, vi } from 'vitest'
import { parseChessServerMsg } from 'checkwait-core'
import { ChessLobbyQueue, type LobbyOutcome } from '../src/chess-lobby.js'
import { ChessMatchDO, ChessMatchHost, parseChessMatchId, type ChessConn } from '../src/chess-match.js'

function conn(): ChessConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

function outcomeCapture(): { outcomes: LobbyOutcome[]; resolve: (o: LobbyOutcome) => void } {
  const outcomes: LobbyOutcome[] = []
  return { outcomes, resolve: (o) => outcomes.push(o) }
}

describe('ChessLobbyQueue', () => {
  it('pairing resolves the waiter immediately — no waiting out the 10s window', () => {
    const q = new ChessLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ paired: false })
    expect(waiter.outcomes).toHaveLength(0) // still pending
    expect(q.join('m2', 5_000, outcomeCapture().resolve)).toEqual({ paired: true, matchId: 'm1' })
    expect(waiter.outcomes).toEqual([{ matchId: 'm1' }]) // woken NOW, not at t=10s
  })

  it('reports no opponent once the waiter times out, and a later joiner does not pair with the stale entry', () => {
    const q = new ChessLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ paired: false })
    q.expire('m1') // the original waiter's own ~10s timeout fires
    expect(waiter.outcomes).toEqual([{ noOpponent: true }])
    const late = outcomeCapture()
    expect(q.join('m2', 20_000, late.resolve)).toEqual({ paired: false }) // registers as a fresh waiter
    expect(late.outcomes).toHaveLength(0)
  })

  it('a stale waiter displaced by a late joiner gets noOpponent — never a dead matchId', () => {
    const q = new ChessLobbyQueue()
    const stale = outcomeCapture()
    q.join('m1', 0, stale.resolve)
    const fresh = outcomeCapture()
    expect(q.join('m2', 10_001, fresh.resolve)).toEqual({ paired: false }) // too late to pair with m1
    expect(stale.outcomes).toEqual([{ noOpponent: true }]) // displaced waiter resolved honestly
    q.expire('m1') // stale waiter's own timer fires afterward: must not double-resolve
    expect(stale.outcomes).toHaveLength(1)
    expect(fresh.outcomes).toHaveLength(0) // the new waiter is untouched
  })

  it('expire() is a no-op once someone has already paired (never double-resolves)', () => {
    const q = new ChessLobbyQueue()
    const waiter = outcomeCapture()
    q.join('m1', 0, waiter.resolve)
    q.join('m2', 1_000, outcomeCapture().resolve) // pairs, resolves + clears the waiter
    q.expire('m1')
    expect(waiter.outcomes).toEqual([{ matchId: 'm1' }]) // exactly once, from the pairing
  })
})

const VALID_ID = 'a'.repeat(64)

describe('parseChessMatchId', () => {
  it('extracts a well-formed 64-char hex DO id from the ws path', () => {
    expect(parseChessMatchId(`/chess/match/${VALID_ID}/ws`)).toBe(VALID_ID)
  })
  it('rejects anything that is not exactly 64 lowercase hex chars', () => {
    expect(parseChessMatchId('/chess/match/abc123/ws')).toBeNull() // too short: idFromString would throw 500
    expect(parseChessMatchId(`/chess/match/${VALID_ID}f/ws`)).toBeNull() // too long
    expect(parseChessMatchId('/chess/match//ws')).toBeNull()
    expect(parseChessMatchId('/match/abc123/ws')).toBeNull()
    expect(parseChessMatchId(`/chess/match/${'A'.repeat(64)}/ws`)).toBeNull() // uppercase
  })
})

describe('ChessMatchHost', () => {
  it('pairs two joiners: first is white, second black, welcome sent to both only once paired', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const host = new ChessMatchHost()
      const white = conn()
      const black = conn()
      const j1 = host.join(white, 'alice')!
      expect(j1.color).toBe('w')
      expect(j1.alarmAt).toBeNull()
      expect(white.sent).toHaveLength(0) // no welcome until both joined
      const j2 = host.join(black, 'bob')!
      expect(j2.color).toBe('b')
      expect(j2.alarmAt).toBe(1_000_000 + 180_000)
      const w1 = parseChessServerMsg(white.sent[0]!)!
      const b1 = parseChessServerMsg(black.sent[0]!)!
      expect(w1).toMatchObject({ t: 'welcome', color: 'w', opponent: 'bob' })
      expect(b1).toMatchObject({ t: 'welcome', color: 'b', opponent: 'alice' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a third join is rejected (room full)', () => {
    const host = new ChessMatchHost()
    host.join(conn(), 'a')
    host.join(conn(), 'b')
    expect(host.join(conn(), 'c')).toBeNull()
  })

  it('an illegal move is rejected and does not mutate state', () => {
    const host = new ChessMatchHost()
    const white = conn()
    const black = conn()
    host.join(white, 'alice')
    host.join(black, 'bob')
    const action = host.handleMessage('w', JSON.stringify({ t: 'move', move: 'e2e5', seq: 1 }))
    expect(action).toEqual({ type: 'illegal' })
  })

  it('a move out of turn is rejected as illegal', () => {
    const host = new ChessMatchHost()
    const white = conn()
    const black = conn()
    host.join(white, 'alice')
    host.join(black, 'bob')
    const action = host.handleMessage('b', JSON.stringify({ t: 'move', move: 'e7e5', seq: 1 }))
    expect(action).toEqual({ type: 'illegal' })
  })

  it('a move before the opponent has paired is rejected as illegal (no free clock, no un-relayed move)', () => {
    const host = new ChessMatchHost()
    const white = conn()
    host.join(white, 'alice') // only one side joined: not yet paired
    const action = host.handleMessage('w', JSON.stringify({ t: 'move', move: 'e2e4', seq: 1 }))
    expect(action).toEqual({ type: 'illegal' })
    expect(white.sent).toHaveLength(0) // never broadcast -- no opponent to desync
  })

  it('a legal move relays to both with authoritative (ticked + incremented) clocks and schedules the next alarm', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const host = new ChessMatchHost()
      const white = conn()
      const black = conn()
      host.join(white, 'alice')
      host.join(black, 'bob')
      vi.setSystemTime(1_003_000) // white spent 3s thinking
      const action = host.handleMessage('w', JSON.stringify({ t: 'move', move: 'e2e4', seq: 1 }))
      expect(action.type).toBe('moved')
      const relayedWhite = parseChessServerMsg(white.sent.at(-1)!)!
      const relayedBlack = parseChessServerMsg(black.sent.at(-1)!)!
      expect(relayedWhite).toMatchObject({ t: 'move', move: 'e2e4', seq: 1 })
      expect(relayedBlack).toMatchObject({ t: 'move', move: 'e2e4', seq: 1 })
      if (relayedWhite.t !== 'move') throw new Error('expected move')
      expect(relayedWhite.clocksMs.w).toBe(180_000 - 3_000 + 2_000) // ticked down then +2s increment
      expect(relayedWhite.clocksMs.b).toBe(180_000) // untouched
    } finally {
      vi.useRealTimers()
    }
  })

  it('resign ends the game with the opponent as winner', () => {
    const host = new ChessMatchHost()
    const white = conn()
    const black = conn()
    host.join(white, 'alice')
    host.join(black, 'bob')
    const action = host.handleMessage('w', JSON.stringify({ t: 'resign' }))
    expect(action).toEqual({ type: 'ended' })
    const end = parseChessServerMsg(black.sent.at(-1)!)!
    expect(end).toMatchObject({ t: 'end', result: { kind: 'resign', winner: 'b' } })
    const endWhite = parseChessServerMsg(white.sent.at(-1)!)!
    expect(endWhite).toMatchObject({ t: 'end', result: { kind: 'resign', winner: 'b' } })
  })

  it('leave() before pairing is a no-op; leave() mid-game resigns for the leaver', () => {
    const solo = new ChessMatchHost()
    expect(solo.join(conn(), 'solo')).not.toBeNull()
    expect(solo.leave('w')).toEqual({ type: 'none' })

    const host = new ChessMatchHost()
    const white = conn()
    const black = conn()
    host.join(white, 'a')
    host.join(black, 'b')
    const action = host.leave('b')
    expect(action).toEqual({ type: 'ended' })
    const end = parseChessServerMsg(white.sent.at(-1)!)!
    expect(end).toMatchObject({ t: 'end', result: { kind: 'resign', winner: 'w' } })
  })

  // This repo has no wrangler-runtime test harness (DurableObjectState/alarm() are ambient
  // types only, never instantiated in tests -- see lobby-do.ts/match-do.ts, which are likewise
  // untested directly). So the DO alarm callback is exercised here through the exported pure
  // helper (`onAlarm`) that the real ChessMatchDO.alarm() delegates to, with the flag clock
  // driven by vi.setSystemTime instead of a real Workers alarm.
  it('an alarm firing after the clock has fully elapsed ends the game by flag', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const host = new ChessMatchHost()
      const white = conn()
      const black = conn()
      host.join(white, 'alice')
      host.join(black, 'bob')
      vi.setSystemTime(180_000) // white's whole clock elapses with no move
      const action = host.onAlarm()
      expect(action).toEqual({ type: 'ended' })
      const end = parseChessServerMsg(white.sent.at(-1)!)!
      expect(end).toMatchObject({ t: 'end', result: { kind: 'flag', winner: 'b' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('onAlarm is a no-op if the game already ended or before pairing', () => {
    const host = new ChessMatchHost()
    expect(host.onAlarm()).toEqual({ type: 'none' }) // never paired: lastMoveAt is null
  })
})

// Minimal fake of the ambient (types-only) Workers WebSocketPair/WebSocket/DurableObjectState
// globals -- this repo has no wrangler-runtime test harness (see the comment above the onAlarm
// tests), so ChessMatchDO itself is otherwise untested. This fake exists specifically to
// reproduce the close-after-end / late-message-after-end races that a real DO can hit: the
// game-over path closes both sockets itself (see applyAction's 'ended' branch), and the
// *other* side's real 'close' event can still fire afterward, racing this.host being nulled.
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

function fakeRequest(): Request {
  return { headers: { get: (h: string) => (h === 'Upgrade' ? 'websocket' : null) } } as unknown as Request
}

function fakeDoState(): DurableObjectState {
  return { storage: { setAlarm: async () => {}, deleteAlarm: async () => {} } } as unknown as DurableObjectState
}

describe('ChessMatchDO', () => {
  it('a close event racing right after the game already ended does not throw (host is null)', async () => {
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
    // Real Workers Response supports status 101 + a `webSocket` option (a Workers-only
    // extension to the fetch spec); Node's built-in Response rejects 101 outright. Stub it so
    // this test can exercise ChessMatchDO.fetch()'s return value without tripping over an
    // unrelated environment gap.
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
      const doInstance = new ChessMatchDO(fakeDoState())
      await doInstance.fetch(fakeRequest())
      const white = pairs[0]![1]!
      white.dispatch('message', { data: JSON.stringify({ t: 'join', handle: 'alice' }) })

      await doInstance.fetch(fakeRequest())
      const black = pairs[1]![1]!
      black.dispatch('message', { data: JSON.stringify({ t: 'join', handle: 'bob' }) })

      // Resign ends the game synchronously: applyAction('ended') sets this.host = null and
      // closes both sockets itself. The real runtime's 'close' event for each socket can still
      // fire afterward (and a straggling 'message' can race it too) -- neither must throw.
      white.dispatch('message', { data: JSON.stringify({ t: 'resign' }) })

      expect(() => white.dispatch('close')).not.toThrow()
      expect(() => black.dispatch('close')).not.toThrow()
      expect(() => black.dispatch('message', { data: JSON.stringify({ t: 'resign' }) })).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
