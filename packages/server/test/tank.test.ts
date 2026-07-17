import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createMatch,
  DEFAULT_ANGLE,
  DEFAULT_POWER,
  MAX_RAW,
  parseTankServerMsg,
  resolveShot,
  SHOT_CLOCK_MS,
  stateHash,
  type MatchState,
  type TankServerMsg,
} from 'tankwait-core'
import { TankLobbyQueue, TankLobbyDO, type LobbyOutcome } from '../src/tank-lobby.js'
import { TankMatchDO, TankMatchHost, parseTankMatchId, type TankConn } from '../src/tank-match.js'

function conn(): TankConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

function serverMsgs(c: { sent: string[] }): TankServerMsg[] {
  const out: TankServerMsg[] = []
  for (const s of c.sent) {
    const m = parseTankServerMsg(s)
    if (m) out.push(m)
  }
  return out
}

function lastOfType<T extends TankServerMsg['t']>(c: { sent: string[] }, t: T): Extract<TankServerMsg, { t: T }> | null {
  for (let i = c.sent.length - 1; i >= 0; i--) {
    const m = parseTankServerMsg(c.sent[i]!)
    if (m && m.t === t) return m as Extract<TankServerMsg, { t: T }>
  }
  return null
}

function outcomeCapture(): { outcomes: LobbyOutcome[]; resolve: (o: LobbyOutcome) => void } {
  const outcomes: LobbyOutcome[] = []
  return { outcomes, resolve: (o) => outcomes.push(o) }
}

// Peek at the host's private MatchState (mirrors block.test.ts's cast) to read turn/result directly.
function peekState(host: TankMatchHost): MatchState {
  return (host as unknown as { state: MatchState }).state
}

describe('TankLobbyQueue', () => {
  it('the 2nd joiner fills the room — both waiters resolve immediately, humanCount 2', () => {
    const q = new TankLobbyQueue()
    const w1 = outcomeCapture()
    expect(q.join('m1', 0, w1.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    expect(w1.outcomes).toHaveLength(0)
    const w2 = outcomeCapture()
    expect(q.join('m2', 1_000, w2.resolve)).toEqual({ filled: true, matchId: 'm1' })
    for (const w of [w1, w2]) expect(w.outcomes).toEqual([{ matchId: 'm1', humanCount: 2 }])
  })

  it('1 human after the window expires gets a match with humanCount 1 (a bot backfills, never blocked)', () => {
    const q = new TankLobbyQueue()
    const waiter = outcomeCapture()
    expect(q.join('m1', 0, waiter.resolve)).toEqual({ filled: false, isNewRoom: true, matchId: 'm1' })
    q.expire('m1')
    expect(waiter.outcomes).toEqual([{ matchId: 'm1', humanCount: 1 }])
  })

  it('expire() is a no-op once the room already filled (never double-resolves)', () => {
    const q = new TankLobbyQueue()
    const w1 = outcomeCapture()
    q.join('m1', 0, w1.resolve)
    q.join('m2', 500, outcomeCapture().resolve)
    q.expire('m1')
    expect(w1.outcomes).toHaveLength(1)
  })
})

describe('TankLobbyDO', () => {
  it('POST /tank/join with an empty {} body → 400 (absent name)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new TankLobbyDO({} as unknown as DurableObjectState, { TANK_MATCH: {} } as never)
      const res = (await doInst.fetch({ method: 'POST', json: async () => ({}) } as unknown as Request)) as unknown as { init: { status: number } }
      expect(res.init.status).toBe(400)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('POST /tank/join with a malformed / missing body → 400 (never throws)', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new TankLobbyDO({} as unknown as DurableObjectState, { TANK_MATCH: {} } as never)
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

  it('a non-POST method → 405', async () => {
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: unknown) {} })
    try {
      const doInst = new TankLobbyDO({} as unknown as DurableObjectState, { TANK_MATCH: {} } as never)
      const res = (await doInst.fetch({ method: 'GET' } as unknown as Request)) as unknown as { init: { status: number } }
      expect(res.init.status).toBe(405)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

const VALID_ID = 'a'.repeat(64)

describe('parseTankMatchId', () => {
  it('extracts a well-formed 64-char hex DO id from the ws path', () => {
    expect(parseTankMatchId(`/tank/match/${VALID_ID}/ws`)).toBe(VALID_ID)
  })
  it('rejects anything that is not exactly 64 lowercase hex chars', () => {
    expect(parseTankMatchId('/tank/match/abc123/ws')).toBeNull()
    expect(parseTankMatchId(`/tank/match/${VALID_ID}f/ws`)).toBeNull()
    expect(parseTankMatchId('/tank/match//ws')).toBeNull()
    expect(parseTankMatchId('/match/abc123/ws')).toBeNull()
    expect(parseTankMatchId(`/tank/match/${'A'.repeat(64)}/ws`)).toBeNull()
  })
})

describe('TankMatchHost', () => {
  it('2 joiners → both receive start (correct you/names/firstTurn) then turn', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    const j0 = host.join(c0, 'alice')!
    expect(j0.slot).toBe(0)
    expect(j0.alarmAt).toBeNull() // not started until the 2nd human joins
    expect(c0.sent).toHaveLength(0)
    const j1 = host.join(c1, 'bob')!
    expect(j1.slot).toBe(1)
    expect(j1.alarmAt).not.toBeNull()

    const s0 = lastOfType(c0, 'start')!
    const s1 = lastOfType(c1, 'start')!
    expect(s0.you).toBe(0)
    expect(s1.you).toBe(1)
    expect(s0.names).toEqual(['alice', 'bob'])
    expect(s0.bots).toEqual([false, false])
    // firstTurn is deterministic from the match seed and identical for both clients.
    expect(s0.firstTurn).toBe(s1.firstTurn)
    const t0 = lastOfType(c0, 'turn')!
    expect(t0.who).toBe(s0.firstTurn)
    expect(t0.deadlineMs).toBe(SHOT_CLOCK_MS) // first turn, no anim allowance, both humans
  })

  it('a valid shot from the turn-holder → both receive a matching ShotBcast (stateHash == local replay) then turn for the other', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const start = lastOfType(c0, 'start')!
    const shooter = start.firstTurn
    // A shot fired straight into the near wall leaves the field → lost shell, damage [0,0]:
    // guaranteed non-lethal regardless of seed, so the match continues to the other player's turn.
    const angle = shooter === 0 ? 180 : 0
    const shot = { angle, power: 100 }

    const action = host.handleMessage(shooter, JSON.stringify({ t: 'shot', seq: 0, angle, power: 100 }))
    expect(action.type).toBe('fired')

    // Local replay from the broadcast seed/names/bots must reproduce the authoritative stateHash.
    const replay = resolveShot(createMatch(start.seed, start.names, start.bots), shot)
    expect(replay.state.result).toBeNull() // precondition: the lost-shell shot did not end the match

    const bcast0 = lastOfType(c0, 'shot')!
    const bcast1 = lastOfType(c1, 'shot')!
    expect(bcast0).toEqual(bcast1)
    expect(bcast0.by).toBe(shooter)
    expect(bcast0.angle).toBe(angle)
    expect(bcast0.power).toBe(100)
    expect(bcast0.stateHash).toBe(stateHash(replay.state))

    const turn = lastOfType(c0, 'turn')!
    expect(turn.who).toBe(shooter === 0 ? 1 : 0)
    expect(turn.deadlineMs).toBeGreaterThan(SHOT_CLOCK_MS) // anim allowance added on top of the clock
  })

  it('an out-of-turn shot is ignored silently — no close, no broadcast, no throw', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const shooter = lastOfType(c0, 'start')!.firstTurn
    const offTurn = shooter === 0 ? 1 : 0
    const before0 = c0.sent.length
    const before1 = c1.sent.length
    const action = host.handleMessage(offTurn, JSON.stringify({ t: 'shot', seq: 0, angle: 45, power: 50 }))
    expect(action).toEqual({ type: 'none' })
    expect(c0.sent.length).toBe(before0) // nothing broadcast
    expect(c1.sent.length).toBe(before1)
  })

  it('a stale / non-increasing seq from the turn-holder is ignored silently', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const shooter = lastOfType(c0, 'start')!.firstTurn
    const angle = shooter === 0 ? 180 : 0
    // First shot with seq 5 is accepted and flips the turn away; a later seq 5 (or lower) is stale.
    host.handleMessage(shooter, JSON.stringify({ t: 'shot', seq: 5, angle, power: 100 }))
    // Flip back to the shooter via the opponent firing a lost shell too.
    const opp = shooter === 0 ? 1 : 0
    host.handleMessage(opp, JSON.stringify({ t: 'shot', seq: 0, angle: opp === 0 ? 180 : 0, power: 100 }))
    const before = c0.sent.length
    const action = host.handleMessage(shooter, JSON.stringify({ t: 'shot', seq: 5, angle, power: 100 }))
    expect(action).toEqual({ type: 'none' }) // seq 5 <= lastSeq 5 → stale, ignored
    expect(c0.sent.length).toBe(before)
  })

  it('malformed raw is ignored without throwing (oversized, bad JSON, out-of-range angle)', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const shooter = lastOfType(c0, 'start')!.firstTurn
    expect(() => host.handleMessage(shooter, 'x'.repeat(MAX_RAW + 1))).not.toThrow()
    expect(() => host.handleMessage(shooter, 'not json')).not.toThrow()
    expect(() => host.handleMessage(shooter, JSON.stringify({ t: 'shot', seq: 0, angle: 999, power: 50 }))).not.toThrow()
    expect(host.handleMessage(shooter, JSON.stringify({ t: 'shot', seq: 0, angle: 999, power: 50 }))).toEqual({ type: 'none' })
    expect(peekState(host).turn).toBe(shooter) // never advanced: none of the garbage fired
  })

  it('onAlarm on a human turn auto-fires that tank\'s last angle/power (first turn = seeded defaults) with seq 0', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const shooter = lastOfType(c0, 'start')!.firstTurn
    const action = host.onAlarm()
    expect(action.type).not.toBe('none')
    const bcast = lastOfType(c0, 'shot')!
    expect(bcast.by).toBe(shooter)
    expect(bcast.seq).toBe(0) // server-originated fire
    // createMatch pre-loads DEFAULT_ANGLE for the left tank and 180-DEFAULT_ANGLE for the right.
    expect(bcast.angle).toBe(shooter === 0 ? DEFAULT_ANGLE : 180 - DEFAULT_ANGLE)
    expect(bcast.power).toBe(DEFAULT_POWER)
  })

  it('onAlarm on a bot turn fires a bot shot and play continues', () => {
    const host = new TankMatchHost(1) // 1 human (slot 0) + 1 bot (slot 1)
    const c = conn()
    host.join(c, 'solo')
    const s = lastOfType(c, 'start')!
    expect(s.bots).toEqual([false, true])
    // Advance to the bot's turn: if the human moves first, auto-fire its turn, then it's the bot's.
    if (peekState(host).turn === 0) host.onAlarm()
    expect(peekState(host).turn).toBe(1) // bot's turn now
    const before = c.sent.length
    const action = host.onAlarm() // bot decides + fires
    expect(action.type).not.toBe('none')
    expect(c.sent.length).toBeGreaterThan(before)
    const bcast = lastOfType(c, 'shot')!
    expect(bcast.by).toBe(1) // the bot fired
    expect(bcast.seq).toBe(0)
  })

  it('a full scripted duel through the host reaches end with a result', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    let ended = false
    for (let i = 0; i < 500; i++) {
      const action = host.onAlarm() // each turn auto-fires the seeded defaults; sudden death forces an end
      if (action.type === 'ended') {
        ended = true
        break
      }
    }
    expect(ended).toBe(true)
    expect(peekState(host).result).not.toBeNull()
    expect(lastOfType(c0, 'end')).not.toBeNull()
    expect(lastOfType(c1, 'end')).not.toBeNull()
  })

  it('leave() mid-match forfeits: the opponent receives an end win', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    const c1 = conn()
    host.join(c0, 'alice')
    host.join(c1, 'bob')
    const action = host.leave(1) // slot 1 abandons
    expect(action).toEqual({ type: 'ended' })
    const end = lastOfType(c0, 'end')!
    expect(end.result).toEqual([0, 0]) // slot 0 (who stayed) wins
  })

  it('leave() before the match started is a no-op (opponent never joined)', () => {
    const host = new TankMatchHost(2)
    const c0 = conn()
    host.join(c0, 'alice') // only one side present, not started
    expect(host.leave(0)).toEqual({ type: 'none' })
  })

  it('a third join is rejected (room full)', () => {
    const host = new TankMatchHost(2)
    host.join(conn(), 'a')
    host.join(conn(), 'b')
    expect(host.join(conn(), 'c')).toBeNull()
  })
})

// Minimal fake of the ambient (types-only) Workers globals, mirroring chess.test.ts / block.test.ts.
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

describe('TankMatchDO', () => {
  it('two joins over ws → both sockets receive a start, then a message racing after end does not throw', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new TankMatchDO(fakeDoState())
      await doInstance.fetch(fakeRequest(`https://x/tank/match/${VALID_ID}/ws?token=2`))
      const a = pairs[0]![1]!
      a.dispatch('message', { data: JSON.stringify({ t: 'join', name: 'alice' }) })
      await doInstance.fetch(fakeRequest(`https://x/tank/match/${VALID_ID}/ws?token=2`))
      const b = pairs[1]![1]!
      b.dispatch('message', { data: JSON.stringify({ t: 'join', name: 'bob' }) })

      expect(serverMsgs(a).some((m) => m.t === 'start')).toBe(true)
      expect(serverMsgs(b).some((m) => m.t === 'start')).toBe(true)

      // A leaving socket ends the match and closes both sockets; a straggling message / close after
      // that (with this.host already null) must not throw.
      a.dispatch('close')
      expect(() => b.dispatch('close')).not.toThrow()
      expect(() => b.dispatch('message', { data: JSON.stringify({ t: 'shot', seq: 1, angle: 45, power: 50 }) })).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a malformed token closes the socket (1002) instead of upgrading into a broken room', async () => {
    const pairs: FakeSocket[][] = []
    stubWorkersGlobals(pairs)
    try {
      const doInstance = new TankMatchDO(fakeDoState())
      await doInstance.fetch(fakeRequest(`https://x/tank/match/${VALID_ID}/ws?token=nope`))
      expect(pairs[0]![1]!.closedWith?.code).toBe(1002)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wrangler.jsonc migrations', () => {
  it('append-only: v1..v7 tags present in order; v1-v6 byte-identical; TANK bindings added', () => {
    const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')) as {
      migrations: { tag: string; new_sqlite_classes: string[] }[]
      durable_objects: { bindings: { name: string; class_name: string }[] }
    }
    // Front-pinned prefix (house rule: the NEWEST migration's test owns exactness; this one pins
    // v1-v6 byte-identical so history can only be appended to, never rewritten). This test now
    // owns the migration literal — it was moved here out of block.test.ts when v7 was appended.
    expect(parsed.migrations.map((m) => m.tag)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'])
    expect(parsed.migrations[0]).toEqual({ tag: 'v1', new_sqlite_classes: ['MatchDO', 'LobbyDO'] })
    expect(parsed.migrations[1]).toEqual({ tag: 'v2', new_sqlite_classes: ['ChessLobbyDO', 'ChessMatchDO'] })
    expect(parsed.migrations[2]).toEqual({ tag: 'v3', new_sqlite_classes: ['BomberLobbyDO', 'BomberMatchDO'] })
    expect(parsed.migrations[3]).toEqual({ tag: 'v4', new_sqlite_classes: ['SnakeLobbyDO', 'SnakeMatchDO'] })
    expect(parsed.migrations[4]).toEqual({ tag: 'v5', new_sqlite_classes: ['BlockLobbyDO', 'BlockMatchDO'] })
    expect(parsed.migrations[5]).toEqual({ tag: 'v6', new_sqlite_classes: ['BomberLobby2DO', 'BomberMatch2DO'] })
    expect(parsed.migrations[6]).toEqual({ tag: 'v7', new_sqlite_classes: ['TankLobbyDO', 'TankMatchDO'] })
    const tankBindings = parsed.durable_objects.bindings.filter((b) => b.name.startsWith('TANK_'))
    expect(tankBindings).toEqual([
      { name: 'TANK_LOBBY', class_name: 'TankLobbyDO' },
      { name: 'TANK_MATCH', class_name: 'TankMatchDO' },
    ])
    const names = parsed.durable_objects.bindings.map((b) => b.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'MATCH', 'LOBBY', 'CHESS_LOBBY', 'CHESS_MATCH', 'BOMBER_LOBBY', 'BOMBER_MATCH',
        'SNAKE_LOBBY', 'SNAKE_MATCH', 'BLOCK_LOBBY', 'BLOCK_MATCH', 'TANK_LOBBY', 'TANK_MATCH',
      ]),
    )
  })
})
