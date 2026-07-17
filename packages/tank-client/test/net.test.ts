import { afterEach, describe, expect, it, vi } from 'vitest'
import { TankNetClient, joinTankMatch, type WebSocketFactory } from '../src/net.js'

// A scriptable fake ws mirroring block-client/test/net.test.ts's FakeWs: the test drives it by
// choosing what happens once the client sends its `join`, and can emit further messages after that
// via `emit`.
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
    this.emit('close', 1000, Buffer.from('game over'))
  }
}

function startMsg(): string {
  return JSON.stringify({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, false], firstTurn: 0 })
}

const noopHandlers = { onShot() {}, onTurn() {}, onEnd() {}, onClose() {} }

afterEach(() => vi.unstubAllGlobals())

describe('joinTankMatch', () => {
  it('POSTs /tank/join with {name} and returns joined on {matchId, token}', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body as string })
      return { ok: true, json: async () => ({ matchId: 'match42', token: '2' }) } as Response
    })
    const outcome = await joinTankMatch('http://127.0.0.1:8787/', 'alice')
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:8787/tank/join', method: 'POST', body: JSON.stringify({ name: 'alice' }) },
    ])
    expect(outcome).toEqual({ kind: 'joined', matchId: 'match42', token: '2' })
  })

  it('collapses a non-2xx response to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }) as Response)
    expect(await joinTankMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a network failure (fetch throws) to error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom')
    })
    expect(await joinTankMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })

  it('collapses a timeout to error', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')))
      })
    })
    expect(await joinTankMatch('http://s', 'alice', 5)).toEqual({ kind: 'error' })
  })

  it('collapses a malformed body to error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }) as Response)
    expect(await joinTankMatch('http://s', 'alice')).toEqual({ kind: 'error' })
  })
})

describe('TankNetClient.connect', () => {
  it('opens the match ws with the token query param, sends join, resolves on start', async () => {
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const ws = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    const { client, start } = await TankNetClient.connect(
      'http://127.0.0.1:8787/',
      'match42',
      '2',
      'alice',
      noopHandlers,
      4000,
      factory,
    )
    expect(created[0]!.url).toBe('ws://127.0.0.1:8787/tank/match/match42/ws?token=2') // http -> ws
    expect(created[0]!.sent[0]).toBe(JSON.stringify({ t: 'join', name: 'alice' }))
    expect(start).toEqual({ t: 'start', you: 0, seed: 42, names: ['alice', 'bob'], bots: [false, false], firstTurn: 0 })
    expect(client).toBeInstanceOf(TankNetClient)
  })

  it('relays shot broadcasts to onShot in order', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const shots: unknown[] = []
    await TankNetClient.connect('http://s', 'm1', '2', 'p', { ...noopHandlers, onShot: (s) => shots.push(s) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'shot', by: 0, seq: 1, angle: 45, power: 60, stateHash: 'abc123' })))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'shot', by: 1, seq: 0, angle: 135, power: 50, stateHash: 'def456' })))
    expect(shots).toEqual([
      { t: 'shot', by: 0, seq: 1, angle: 45, power: 60, stateHash: 'abc123' },
      { t: 'shot', by: 1, seq: 0, angle: 135, power: 50, stateHash: 'def456' },
    ])
  })

  it('relays a turn message to onTurn', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const turns: unknown[] = []
    await TankNetClient.connect('http://s', 'm1', '2', 'p', { ...noopHandlers, onTurn: (t) => turns.push(t) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'turn', who: 1, deadlineMs: 20000 })))
    expect(turns).toEqual([{ t: 'turn', who: 1, deadlineMs: 20000 }])
  })

  it('relays an end message to onEnd, converted from the compact wire result', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const ends: unknown[] = []
    await TankNetClient.connect('http://s', 'm1', '2', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

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
    await TankNetClient.connect('http://s', 'm1', '2', 'p', { ...noopHandlers, onEnd: (r) => ends.push(r) }, 4000, factory)

    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'end', result: [1] })))
    expect(ends).toEqual([{ kind: 'draw' }])
  })

  it('ignores garbage server messages without corrupting anything', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const shots: unknown[] = []
    const ends: unknown[] = []
    await TankNetClient.connect(
      'http://s',
      'm1',
      '2',
      'p',
      { ...noopHandlers, onShot: (s) => shots.push(s), onEnd: (r) => ends.push(r) },
      4000,
      factory,
    )

    fakeWs.emit('message', Buffer.from('not json'))
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'shot', by: 5, seq: -1 }))) // invalid
    fakeWs.emit('message', Buffer.from(JSON.stringify({ t: 'nonsense', whatever: 1 })))
    expect(shots).toEqual([])
    expect(ends).toEqual([])
  })

  it('fires onClose for a post-start close but rejects a pre-start close', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const closes: string[] = []
    await TankNetClient.connect('http://s', 'm1', '2', 'p', { ...noopHandlers, onClose: (reason) => closes.push(reason) }, 4000, factory)
    expect(closes).toEqual([])

    // Socket close mid-game (after start already resolved connect()) must be a clean handler
    // callback, never a rejection — this is what lets online.ts treat it as a forfeit rather than
    // routing back through the join-failure fallback path.
    fakeWs.emit('close', 1006, Buffer.from('connection lost'))
    expect(closes).toEqual(['connection lost'])
  })

  it('rejects when the socket closes before start', async () => {
    const factory: WebSocketFactory = (url) =>
      new FakeWs(url, (w) => w.emit('close', 1011, Buffer.from('server error'))) as unknown as import('ws').WebSocket
    await expect(TankNetClient.connect('http://s', 'm1', '2', 'p', noopHandlers, 4000, factory)).rejects.toThrow()
  })

  it('sendShot writes a shot msg verbatim', async () => {
    let fakeWs!: FakeWs
    const factory: WebSocketFactory = (url) => {
      fakeWs = new FakeWs(url, (w) => w.emit('message', Buffer.from(startMsg())))
      return fakeWs as unknown as import('ws').WebSocket
    }
    const { client } = await TankNetClient.connect('http://s', 'm1', '2', 'p', noopHandlers, 4000, factory)
    const msg = { t: 'shot' as const, seq: 3, angle: 42, power: 70 }
    client.sendShot(msg)
    expect(fakeWs.sent.at(-1)).toBe(JSON.stringify(msg))
  })
})
