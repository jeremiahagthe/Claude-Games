import { afterEach, describe, expect, it, vi } from 'vitest'

// Regression test for the mirror-seeding TDZ crash (final review Fix 2): `let state` in
// online.ts was declared AFTER `await BomberNetClient.connect(...)`, but the `onSnap` handler
// closes over it. A coalesced ws chunk that delivers `start` and the first `snap` in ONE
// macrotask (real sockets can do this) fires onSnap synchronously, inside connect()'s own
// message handler, BEFORE runOnline()'s `await` continuation has run far enough to declare
// `state` -- a bare ReferenceError thrown from inside a raw event-loop callback, which is an
// uncaught exception (not a rejected promise) since exit guards aren't installed yet.
//
// FakeWs mirrors net.test.ts's fake (same shape BomberNetClient.connect expects from `ws`),
// but is wired here via `vi.mock('ws')` so the REAL net.ts/online.ts code runs unmodified --
// only the transport is faked, exactly reproducing the two-messages-in-one-macrotask race.
const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    readyState = 1 // OPEN
    sent: string[] = []
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    constructor(public url: string) {
      setTimeout(() => this.emit('open'), 0)
    }
    on(ev: string, cb: (...a: unknown[]) => void): this {
      ;(this.handlers[ev] ??= []).push(cb)
      return this
    }
    send(data: string): void {
      this.sent.push(data)
      const msg = JSON.parse(data)
      if (msg.t !== 'hello') return
      setTimeout(() => {
        // The coalesced chunk: start, then immediately (same macrotask, no yield back to the
        // microtask queue in between) the first snap.
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              t: 'start',
              you: 0,
              seed: 42,
              names: ['you', 'b', 'c', 'd'],
              bots: [false, true, true, true],
              startTick: 0,
            }),
          ),
        )
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              t: 'snap',
              state: {
                tick: 1,
                g: '0'.repeat(13 * 11),
                players: [[0, 'you', 0, 1, 1, 1, 1, 1, 0, 0, 0, 0]],
                bombs: [],
                flames: [],
                drops: [],
                shrinkIndex: -1,
                result: null,
              },
            }),
          ),
        )
      }, 0)
    }
    emit(ev: string, ...args: unknown[]): void {
      for (const cb of this.handlers[ev] ?? []) cb(...args)
    }
    close(): void {
      this.emit('close', 1000, Buffer.from('bye'))
    }
  }
  return { FakeWs }
})

vi.mock('ws', () => ({ WebSocket: FakeWs }))

// setupGame() drives real stdin/stdout/terminal state -- irrelevant to this bug (which fires
// during the join/connect phase, before setupGame() is even called) and unsafe to run for
// real inside a test process, so it's faked with a session that ends the redraw loop on its
// very first check.
vi.mock('../src/game.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game.js')>()
  return {
    ...actual,
    setupGame: vi.fn(async () => ({
      term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
      parser: {},
      colorMode: 'truecolor',
      listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
      layout: () => ({ r: 2, sideHud: true, glyph: false }),
      drainInput: () => ({ dir: null, bomb: false }),
      statusLine: () => '',
      quitRequested: () => true, // no finale to render; ends the loop immediately
      onResize: () => {},
      dispose: vi.fn(),
    })),
    teardownAndExit: vi.fn(async () => 'teardown-called'),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runOnline mirror seeding (Fix 2: TDZ regression)', () => {
  it('does not crash when start+snap coalesce into one macrotask, and the mirror still seeds correctly', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: 't1' }) }))

    const caught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      caught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const { runOnline } = await import('../src/online.js')
      const resultPromise = runOnline({ server: 'http://s', name: 'you' })
      // Let the coalesced start+snap macrotask (and any resulting uncaught exception) fire
      // before asserting, and let the mocked loop/teardown settle.
      const outcome = await resultPromise
      expect(caught).toEqual([]) // no ReferenceError from an uninitialized `state` closure
      expect(outcome).toBe('teardown-called') // the loop ran to completion, not a hard crash
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
