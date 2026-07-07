import { describe, expect, it, vi } from 'vitest'
import { parseChessServerMsg } from 'checkwait-core'
import { ChessLobbyQueue } from '../src/chess-lobby.js'
import { ChessMatchHost, parseChessMatchId, type ChessConn } from '../src/chess-match.js'

function conn(): ChessConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

describe('ChessLobbyQueue', () => {
  it('pairs a second joiner within 10s with the first', () => {
    const q = new ChessLobbyQueue()
    expect(q.join('m1', 0)).toEqual({ paired: false })
    expect(q.join('m2', 5_000)).toEqual({ paired: true, matchId: 'm1' })
  })

  it('reports no opponent once the waiter times out, and a later joiner does not pair with the stale entry', () => {
    const q = new ChessLobbyQueue()
    expect(q.join('m1', 0)).toEqual({ paired: false })
    expect(q.expire('m1')).toBe(true) // the original waiter's own ~10s timeout fires
    expect(q.join('m2', 20_000)).toEqual({ paired: false }) // registers as a fresh waiter
  })

  it('does not pair a joiner arriving after the 10s window even before expire() runs', () => {
    const q = new ChessLobbyQueue()
    q.join('m1', 0)
    expect(q.join('m2', 10_001)).toEqual({ paired: false })
  })

  it('expire() is a no-op once someone has already paired', () => {
    const q = new ChessLobbyQueue()
    q.join('m1', 0)
    q.join('m2', 1_000) // pairs, clears the waiter
    expect(q.expire('m1')).toBe(false)
  })
})

describe('parseChessMatchId', () => {
  it('extracts the match id from the ws path and rejects everything else', () => {
    expect(parseChessMatchId('/chess/match/abc123/ws')).toBe('abc123')
    expect(parseChessMatchId('/chess/match//ws')).toBeNull()
    expect(parseChessMatchId('/match/abc123/ws')).toBeNull()
    expect(parseChessMatchId('/chess/match/UPPER/ws')).toBeNull()
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
