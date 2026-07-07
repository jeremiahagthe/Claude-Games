import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialState, toFEN } from 'checkwait-core'
import { ChessNetClient, joinChessLobby, type WebSocketFactory } from '../src/net.js'

// A scriptable fake ws mirroring packages/client/test/netclient.test.ts's
// FakeWs: the test drives it by choosing what happens once the client sends
// its `join`, and can emit further messages after that via `emit`.
class FakeWs {
  readyState = 1 // OPEN
  sent: string[] = []
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  constructor(public url: string, private onJoin?: (ws: FakeWs) => void) {
    setTimeout(() => this.emit('open'), 0)
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    ;(this.handlers[ev] ??= []).push(cb)
    return this
  }
  send(data: string): void {
    this.sent.push(data)
    const msg = JSON.parse(data)
    if (msg.t === 'join') setTimeout(() => this.onJoin?.(this), 0)
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers[ev] ?? []) cb(...args)
  }
  close(): void {
    this.emit('close', 1000, Buffer.from(''))
  }
}

function welcomeMsg(): string {
  return JSON.stringify({
    t: 'welcome',
    color: 'w',
    opponent: 'opp1',
    state: toFEN(initialState()),
    clocksMs: { w: 180_000, b: 180_000 },
  })
}

const noopHandlers = { onMove() {}, onEnd() {}, onClose() {} }

afterEach(() => vi.unstubAllGlobals())

describe('joinChessLobby', () => {
  it('POSTs /chess/join and returns matched on {matchId}', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method! })
      return { ok: true, json: async () => ({ matchId: 'abc123' }) } as Response
    })
    const outcome = await joinChessLobby('http://127.0.0.1:8787/')
    expect(calls).toEqual([{ url: 'http://127.0.0.1:8787/chess/join', method: 'POST' }])
    expect(outcome).toEqual({ kind: 'matched', matchId: 'abc123' })
  })

  it('returns noOpponent on {noOpponent:true}', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ noOpponent: true }) }) as Response)
    expect(await joinChessLobby('http://s')).toEqual({ kind: 'noOpponent' })
  })

  it('collapses a non-2xx response to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }) as Response)
    expect(await joinChessLobby('http://s')).toEqual({ kind: 'error' })
  })

  it('collapses a network failure (fetch throws) to error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    expect(await joinChessLobby('http://s')).toEqual({ kind: 'error' })
  })

  it('collapses a malformed body to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }) as Response)
    expect(await joinChessLobby('http://s')).toEqual({ kind: 'error' })
  })
})

describe('ChessNetClient.connect', () => {
  it('opens the match ws, sends join, resolves on welcome', async () => {
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const ws = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    const { client, welcome } = await ChessNetClient.connect(
      'http://127.0.0.1:8787/',
      'match42',
      'PlayerOne',
      noopHandlers,
      4000,
      factory,
    )
    expect(created[0]!.url).toBe('ws://127.0.0.1:8787/chess/match/match42/ws') // http -> ws
    expect(created[0]!.sent[0]).toBe(JSON.stringify({ t: 'join', handle: 'PlayerOne' }))
    expect(welcome).toEqual({
      color: 'w',
      opponent: 'opp1',
      state: toFEN(initialState()),
      clocksMs: { w: 180_000, b: 180_000 },
    })
    expect(client).toBeInstanceOf(ChessNetClient)
  })

  it('relays a move message to onMove', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const moves: Array<{ move: string; clocksMs: { w: number; b: number }; seq: number }> = []
    await ChessNetClient.connect('http://s', 'm1', 'p', { ...noopHandlers, onMove: (move, clocksMs, seq) => moves.push({ move, clocksMs, seq }) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'move', move: 'e2e4', clocksMs: { w: 178_000, b: 180_000 }, seq: 0 })))
    expect(moves).toEqual([{ move: 'e2e4', clocksMs: { w: 178_000, b: 180_000 }, seq: 0 }])
  })

  it('relays an end message to onEnd', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: Array<{ result: unknown; state: string }> = []
    await ChessNetClient.connect('http://s', 'm1', 'p', { ...noopHandlers, onEnd: (result, state) => ends.push({ result, state }) }, 4000, factory)

    const endFen = toFEN(initialState())
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: { kind: 'resign', winner: 'w' }, state: endFen })))
    expect(ends).toEqual([{ result: { kind: 'resign', winner: 'w' }, state: endFen }])
  })

  it('fires onClose for a post-welcome close but not a pre-welcome one', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const closes: string[] = []
    await ChessNetClient.connect('http://s', 'm1', 'p', { ...noopHandlers, onClose: (reason) => closes.push(reason) }, 4000, factory)
    expect(closes).toEqual([])

    fakeWs.emit('close', 1000, Buffer.from('bye'))
    expect(closes).toEqual(['bye'])
  })

  it('rejects when the socket closes before welcome', async () => {
    const factory: WebSocketFactory = (url) => new FakeWs(url, (w) => w.emit('close', 1011, Buffer.from('server error'))) as unknown as import('ws').WebSocket
    await expect(ChessNetClient.connect('http://s', 'm1', 'p', noopHandlers, 4000, factory)).rejects.toThrow()
  })

  it('sendMove writes a move msg with coordinate notation and seq', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const { client } = await ChessNetClient.connect('http://s', 'm1', 'p', noopHandlers, 4000, factory)
    client.sendMove('e2e4', 0)
    expect(fakeWs.sent.at(-1)).toBe(JSON.stringify({ t: 'move', move: 'e2e4', seq: 0 }))
  })

  it('resign() sends a resign msg', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(welcomeMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const { client } = await ChessNetClient.connect('http://s', 'm1', 'p', noopHandlers, 4000, factory)
    client.resign()
    expect(fakeWs.sent.at(-1)).toBe(JSON.stringify({ t: 'resign' }))
  })
})
