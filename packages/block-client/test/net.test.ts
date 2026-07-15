import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMatch, toWire } from 'blockwait-core'
import { BlockNetClient, joinBlockMatch, type WebSocketFactory } from '../src/net.js'

// A scriptable fake ws mirroring snake-client/test/net.test.ts's FakeWs: the test drives it by
// choosing what happens once the client sends its `hello`, and can emit further messages after
// that via `emit`.
class FakeWs {
  readyState = 1 // OPEN
  sent: string[] = []
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  constructor(public url: string, private onHello?: (ws: FakeWs) => void) {
    setTimeout(() => this.emit('open'), 0)
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    ;(this.handlers[ev] ??= []).push(cb)
    return this
  }
  send(data: string): void {
    this.sent.push(data)
    const msg = JSON.parse(data)
    if (msg.t === 'hello') setTimeout(() => this.onHello?.(this), 0)
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers[ev] ?? []) cb(...args)
  }
  close(): void {
    this.emit('close', 1000, Buffer.from('game over'))
  }
}

function startMsg(): string {
  return JSON.stringify({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, false] })
}

// A valid on-wire state built from a real match (guarantees the strict protocol validator admits
// it — hand-rolled boards/pieces are easy to get subtly wrong).
function wireStateJson(tick = 1): unknown {
  const m = createMatch(42, ['alice', 'bob'], [false, false])
  const w = toWire(m)
  w.players[0][4] = tick // player 0's own clock
  return w
}

const noopHandlers = { onSnap() {}, onGarbage() {}, onEnd() {}, onClose() {} }

afterEach(() => vi.unstubAllGlobals())

describe('joinBlockMatch', () => {
  it('POSTs /block/join with {name} and returns joined on {matchId, token}', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body as string })
      return { ok: true, json: async () => ({ matchId: 'match42', token: '1' }) } as Response
    })
    const outcome = await joinBlockMatch('http://127.0.0.1:8787/', 'alice')
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:8787/block/join', method: 'POST', body: JSON.stringify({ name: 'alice' }) },
    ])
    expect(outcome).toEqual({ kind: 'joined', matchId: 'match42', token: '1' })
  })

  it('collapses a non-2xx response to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }) as Response)
    expect(await joinBlockMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a network failure (fetch throws) to error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    expect(await joinBlockMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a timeout to error', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')))
      })
    })
    expect(await joinBlockMatch('http://s', 'alice', 5)).toEqual({ kind: 'error' })
  })

  it('collapses a malformed body to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }) as Response)
    expect(await joinBlockMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })
})

describe('BlockNetClient.connect', () => {
  it('opens the match ws with the token query param, sends hello, resolves on start', async () => {
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const ws = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    const { client, start } = await BlockNetClient.connect(
      'http://127.0.0.1:8787/',
      'match42',
      '1',
      'alice',
      noopHandlers,
      4000,
      factory,
    )
    expect(created[0]!.url).toBe('ws://127.0.0.1:8787/block/match/match42/ws?token=1') // http -> ws
    expect(created[0]!.sent[0]).toBe(JSON.stringify({ t: 'hello', name: 'alice' }))
    expect(start).toEqual({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, false] })
    expect(client).toBeInstanceOf(BlockNetClient)
  })

  it('relays snap messages to onSnap in order', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const snaps: unknown[] = []
    await BlockNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onSnap: (s) => snaps.push(s) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: wireStateJson(1) })))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: wireStateJson(2) })))
    expect((snaps[0] as { players: unknown[][] }).players[0]![4]).toBe(1)
    expect((snaps[1] as { players: unknown[][] }).players[0]![4]).toBe(2)
  })

  it('relays a garbage message to onGarbage', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const garbage: unknown[] = []
    await BlockNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onGarbage: (g) => garbage.push(g) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'garbage', rows: 3, holeCol: 4, atTick: 42 })))
    expect(garbage).toEqual([{ t: 'garbage', rows: 3, holeCol: 4, atTick: 42 }])
  })

  it('relays an end message to onEnd, converted from the compact wire result', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: unknown[] = []
    await BlockNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: [0, 1] })))
    expect(ends).toEqual([{ kind: 'win', winner: 1 }])
  })

  it('converts a draw end message correctly', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: unknown[] = []
    await BlockNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: [1] })))
    expect(ends).toEqual([{ kind: 'draw' }])
  })

  it('ignores garbage server messages without corrupting anything', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const snaps: unknown[] = []
    const ends: unknown[] = []
    await BlockNetClient.connect(
      'http://s',
      'm1',
      '1',
      'p',
      { ...noopHandlers, onSnap: (s) => snaps.push(s), onEnd: (r) => ends.push(r) },
      4000,
      factory,
    )

    fakeWs.emit('message', Buffer.from('not json'))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: { bogus: true } })))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'nonsense', whatever: 1 })))
    expect(snaps).toEqual([])
    expect(ends).toEqual([])
  })

  it('fires onClose for a post-start close but rejects a pre-start close', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const closes: string[] = []
    await BlockNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onClose: (reason) => closes.push(reason) }, 4000, factory)
    expect(closes).toEqual([])

    // Socket close mid-game (after start already resolved connect()) must be a clean handler
    // callback, never a rejection — this is what lets online.ts treat it as elimination rather
    // than routing back through the join-failure fallback path.
    fakeWs.emit('close', 1006, Buffer.from('connection lost'))
    expect(closes).toEqual(['connection lost'])
  })

  it('rejects when the socket closes before start', async () => {
    const factory: WebSocketFactory = (url) =>
      new FakeWs(url, (w) => w.emit('close', 1011, Buffer.from('server error'))) as unknown as import('ws').WebSocket
    await expect(BlockNetClient.connect('http://s', 'm1', '1', 'p', noopHandlers, 4000, factory)).rejects.toThrow()
  })

  it('sendInput writes an input msg verbatim', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const { client } = await BlockNetClient.connect('http://s', 'm1', '1', 'p', noopHandlers, 4000, factory)
    const msg = { t: 'input' as const, seq: 3, upTo: 20, events: [[18, 5]] as [number, number][] }
    client.sendInput(msg)
    expect(fakeWs.sent.at(-1)).toBe(JSON.stringify(msg))
  })
})
