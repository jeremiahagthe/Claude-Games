import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MatchState, PlayerState } from 'fragwait-core'
import { NetClient, type WebSocketFactory } from '../src/net/client.js'

// Minimal MatchState the server would send in `welcome`. mapId must be a real
// map so onWelcome's mapById() call resolves.
function player(id: string): PlayerState {
  return { id, handle: id, bot: false, pos: { x: 2, y: 2 }, dir: 0, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}
function welcomeState(): MatchState {
  return { tick: 0, timeLeftTicks: 100, mapId: 'node_modules', players: { me: player('me') }, rail: { pos: { x: 1, y: 1 }, present: true, respawnTimer: 0 }, kills: [] }
}

// A scriptable fake ws: the test drives it by choosing what happens after the
// client sends its `join`. Listeners are attached synchronously by connect(),
// so scheduling emits on a macrotask guarantees they're registered first.
type Behavior = 'welcome' | 'closeFull'
class FakeWs {
  readyState = 1 // OPEN
  sent: string[] = []
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  constructor(public url: string, private behavior: Behavior) {
    setTimeout(() => this.emit('open'), 0)
  }
  on(ev: string, cb: (...a: unknown[]) => void): this {
    ;(this.handlers[ev] ??= []).push(cb)
    return this
  }
  send(data: string): void {
    this.sent.push(data)
    const msg = JSON.parse(data)
    if (msg.t !== 'join') return
    setTimeout(() => {
      if (this.behavior === 'welcome') {
        this.emit('message', Buffer.from(JSON.stringify({ t: 'welcome', id: 'me', state: welcomeState() })))
      } else {
        this.emit('close', 1013, Buffer.from('full'))
      }
    }, 0)
  }
  close(): void { this.emit('close', 1000, Buffer.from('')) }
  // Lets a test simulate the server closing an already-established session.
  triggerClose(code: number, reason: string): void { this.emit('close', code, Buffer.from(reason)) }
  private emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers[ev] ?? []) cb(...args)
  }
}

const noopHandlers = {
  onWelcome() {}, onSnap() {}, onEnd() {}, onClose() {},
}

afterEach(() => vi.unstubAllGlobals())

describe('NetClient.connect', () => {
  it('POSTs /api/join, opens the ws at the ws:// match url, resolves on welcome', async () => {
    const joins: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      joins.push({ url, body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ matchId: 'abc123' }) } as Response
    })
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const ws = new FakeWs(url, 'welcome')
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    let welcomedId = ''
    const client = await NetClient.connect('http://127.0.0.1:8787/', 'PlayerOne', {
      ...noopHandlers,
      onWelcome(id) { welcomedId = id },
    }, 4000, factory)

    expect(joins).toHaveLength(1)
    expect(joins[0]!.url).toBe('http://127.0.0.1:8787/api/join') // trailing slash stripped
    expect(joins[0]!.body).toEqual({}) // no exclude on first attempt
    expect(created[0]!.url).toBe('ws://127.0.0.1:8787/match/abc123/ws') // http -> ws
    expect(created[0]!.sent[0]).toBe(JSON.stringify({ t: 'join', handle: 'PlayerOne' }))
    expect(welcomedId).toBe('me')
    expect(client).toBeInstanceOf(NetClient)
  })

  it('retries once with exclude when the first match closes 1013 "full", without firing onClose for that retry close', async () => {
    const bodies: unknown[] = []
    let call = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return { ok: true, json: async () => ({ matchId: call++ === 0 ? 'full1' : 'open2' }) } as Response
    })
    const created: FakeWs[] = []
    const factory: WebSocketFactory = (url) => {
      const id = url.includes('full1') ? 'closeFull' : 'welcome'
      const ws = new FakeWs(url, id)
      created.push(ws)
      return ws as unknown as import('ws').WebSocket
    }
    const closes: string[] = []
    const client = await NetClient.connect('http://s', 'p', {
      ...noopHandlers,
      onClose(reason) { closes.push(reason) },
    }, 4000, factory)
    expect(bodies).toEqual([{}, { exclude: 'full1' }]) // second join excludes the full match
    expect(client).toBeInstanceOf(NetClient)
    // The pre-welcome "full" close that drove the retry must not poison a
    // caller's `closed` state before the game loop even starts.
    expect(closes).toEqual([])

    created[1]!.triggerClose(1000, 'bye')
    expect(closes).toEqual(['bye']) // fires exactly once, for the established session's close
  })

  it('throws when /api/join is not ok', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }) as Response)
    await expect(NetClient.connect('http://s', 'p', noopHandlers, 4000, () => new FakeWs('x', 'welcome') as unknown as import('ws').WebSocket))
      .rejects.toThrow('join failed: 503')
  })
})
