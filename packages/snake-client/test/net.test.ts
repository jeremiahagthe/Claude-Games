import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnakeNetClient, diffInputForWire, joinSnakeMatch, type WebSocketFactory } from '../src/net.js'

// A scriptable fake ws mirroring packages/bomber-client/test/net.test.ts's FakeWs: the test
// drives it by choosing what happens once the client sends its `hello`, and can emit further
// messages after that via `emit`.
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
  return JSON.stringify({
    t: 'start',
    you: 0,
    seed: 42,
    names: ['alice', 'bot·1', 'bot·2', 'bot·3'],
    bots: [false, true, true, true],
  })
}

function wireState(tick: number, result: unknown = null): unknown {
  return {
    tick,
    cd: 4,
    rng: 1,
    rings: 0,
    food: [],
    snakes: [[0, 'alice', 0, 1, 1, 0, 0, 7, 4, []]],
    result,
  }
}

const noopHandlers = { onSnap() {}, onEnd() {}, onClose() {} }

afterEach(() => vi.unstubAllGlobals())

describe('joinSnakeMatch', () => {
  it('POSTs /snake/join with {name} and returns joined on {matchId, token}', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body as string })
      return { ok: true, json: async () => ({ matchId: 'match42', token: '3' }) } as Response
    })
    const outcome = await joinSnakeMatch('http://127.0.0.1:8787/', 'alice')
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:8787/snake/join', method: 'POST', body: JSON.stringify({ name: 'alice' }) },
    ])
    expect(outcome).toEqual({ kind: 'joined', matchId: 'match42', token: '3' })
  })

  it('collapses a non-2xx response to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }) as Response)
    expect(await joinSnakeMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a network failure (fetch throws) to error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    expect(await joinSnakeMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a timeout to error', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')))
      })
    })
    expect(await joinSnakeMatch('http://s', 'alice', 5)).toEqual({ kind: 'error' })
  })

  it('collapses a malformed body to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }) as Response)
    expect(await joinSnakeMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })
})

describe('SnakeNetClient.connect', () => {
  it('opens the match ws with the token query param, sends hello, resolves on start', async () => {
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const ws = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    const { client, start } = await SnakeNetClient.connect(
      'http://127.0.0.1:8787/',
      'match42',
      '3',
      'alice',
      noopHandlers,
      4000,
      factory,
    )
    expect(created[0]!.url).toBe('ws://127.0.0.1:8787/snake/match/match42/ws?token=3') // http -> ws
    expect(created[0]!.sent[0]).toBe(JSON.stringify({ t: 'hello', name: 'alice' }))
    expect(start).toEqual({
      t: 'start',
      you: 0,
      seed: 42,
      names: ['alice', 'bot·1', 'bot·2', 'bot·3'],
      bots: [false, true, true, true],
    })
    expect(client).toBeInstanceOf(SnakeNetClient)
  })

  it('drives the state mirror: relays snap messages to onSnap in order', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const snaps: unknown[] = []
    await SnakeNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onSnap: (s) => snaps.push(s) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: wireState(1) })))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: wireState(2) })))
    expect(snaps).toEqual([wireState(1), wireState(2)])
  })

  it('relays an end message to onEnd, converted from the compact wire result', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: unknown[] = []
    await SnakeNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: [0, 2] })))
    expect(ends).toEqual([{ kind: 'win', winner: 2 }])
  })

  it('converts a draw end message correctly', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: unknown[] = []
    await SnakeNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: [1] })))
    expect(ends).toEqual([{ kind: 'draw' }])
  })

  it('ignores garbage server messages without corrupting the mirror', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const snaps: unknown[] = []
    const ends: unknown[] = []
    await SnakeNetClient.connect(
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
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'snap', state: wireState(5) })))
    expect(snaps).toEqual([wireState(5)])
    expect(ends).toEqual([])
  })

  it('fires onClose for a post-start close but rejects a pre-start close', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const closes: string[] = []
    await SnakeNetClient.connect('http://s', 'm1', '1', 'p', { ...noopHandlers, onClose: (reason) => closes.push(reason) }, 4000, factory)
    expect(closes).toEqual([])

    // Socket close mid-game (after start has already resolved connect()) must be a clean
    // handler callback, never a rejection — this is what lets online.ts's caller treat it as
    // an elimination result rather than routing back through the join-failure fallback path.
    fakeWs.emit('close', 1006, Buffer.from('connection lost'))
    expect(closes).toEqual(['connection lost'])
  })

  it('rejects when the socket closes before start', async () => {
    const factory: WebSocketFactory = (url) => new FakeWs(url, (w) => w.emit('close', 1011, Buffer.from('server error'))) as unknown as import('ws').WebSocket
    await expect(SnakeNetClient.connect('http://s', 'm1', '1', 'p', noopHandlers, 4000, factory)).rejects.toThrow()
  })

  it('sendInput writes an input msg verbatim', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const { client } = await SnakeNetClient.connect('http://s', 'm1', '1', 'p', noopHandlers, 4000, factory)
    client.sendInput({ t: 'input', dir: 'up' })
    expect(fakeWs.sent.at(-1)).toBe(JSON.stringify({ t: 'input', dir: 'up' }))
  })
})

describe('diffInputForWire (minimal-diff InputMsg logic)', () => {
  it('sends nothing on a quiet tick (dir still null)', () => {
    const { msg, nextDir } = diffInputForWire(null, { dir: null })
    expect(msg).toBeNull()
    expect(nextDir).toBeNull()
  })

  it('sends the new dir when the latch dir changes from null', () => {
    const { msg, nextDir } = diffInputForWire(null, { dir: 'up' })
    expect(msg).toEqual({ t: 'input', dir: 'up' })
    expect(nextDir).toBe('up')
  })

  it('sends the new dir when it changes from one heading to another', () => {
    const { msg, nextDir } = diffInputForWire('up', { dir: 'left' })
    expect(msg).toEqual({ t: 'input', dir: 'left' })
    expect(nextDir).toBe('left')
  })

  it('never sends null: a quiet tick after a change stays quiet', () => {
    const first = diffInputForWire(null, { dir: 'left' })
    const second = diffInputForWire(first.nextDir, { dir: null })
    expect(second.msg).toBeNull()
    expect(second.nextDir).toBe('left') // prevDir carried forward, never reset to null
  })

  it('repeated identical ticks after a change stay quiet', () => {
    const first = diffInputForWire(null, { dir: 'left' })
    const second = diffInputForWire(first.nextDir, { dir: 'left' })
    expect(second.msg).toBeNull()
  })
})
