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
    // Per-test server script, run one macrotask after the client's hello. null = the default
    // coalesced start+snap chunk below (the TDZ regression's exact trigger). The finale test
    // installs its own script (start now, then close in a LATER macrotask — a post-seed
    // message must arrive after runOnline's createMatch seeding to survive it).
    static script: ((ws: FakeWs) => void) | null = null
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
        if (FakeWs.script) {
          FakeWs.script(this)
          return
        }
        // The coalesced chunk: start, then immediately (same macrotask, no yield back to the
        // microtask queue in between) the first snap.
        this.emitJson({
          t: 'start',
          you: 0,
          seed: 42,
          names: ['you', 'b', 'c', 'd'],
          bots: [false, true, true, true],
          startTick: 0,
        })
        this.emitJson({
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
        })
      }, 0)
    }
    emitJson(msg: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(msg)))
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
  FakeWs.script = null
  vi.useRealTimers()
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

// --- finale construction (closedEarly) -------------------------------------------------------
//
// Backported from snakewait's online.test.ts closedEarly case. The TDZ test above quits on the
// loop's first check, so it never reaches the finale block. This test runs the loop for real
// (quitRequested false) under FAKE timers — no wall-clock sleeping — with a per-test FakeWs.script
// driving the server side: `start` immediately, then `close` one macrotask LATER (10ms), because
// runOnline's createMatch seeding unconditionally overwrites any message that lands before it.
// teardownAndExit stays mocked; the test asserts on the `finale` object runOnline passes it.
// (bomber's chooseLayout never returns null — it falls back to glyph mode — so snake's layout-null
// finale half does not apply here; only the abnormal-close / closedEarly path is backported.)

const HUMAN_NAMES = ['you', 'b', 'c', 'd']

function humanStart(ws: InstanceType<typeof FakeWs>): void {
  ws.emitJson({ t: 'start', you: 0, seed: 42, names: HUMAN_NAMES, bots: [false, false, false, true], startTick: 0 })
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

async function runFinale(
  script: (ws: InstanceType<typeof FakeWs>) => void,
): Promise<{ screen: string; shareText: string }> {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: 't1' }) }))
  FakeWs.script = script

  const game = await import('../src/game.js')
  vi.mocked(game.setupGame).mockImplementation(async () => ({
    term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
    parser: {},
    colorMode: 'truecolor',
    listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
    layout: () => ({ r: 2, sideHud: true, glyph: false }),
    drainInput: () => ({ dir: null, bomb: false }),
    statusLine: () => '',
    quitRequested: () => false, // the match itself must end the loop, not a quit
    onResize: () => {},
    dispose: vi.fn(),
  }) as never)

  const { runOnline } = await import('../src/online.js')
  const resultPromise = runOnline({ server: 'http://s', name: 'you' })
  await vi.advanceTimersByTimeAsync(200)
  const outcome = await resultPromise
  expect(outcome).toBe('teardown-called')

  const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
  expect(finale).not.toBeNull()
  return { screen: stripAnsi(finale!.screen), shareText: finale!.shareText }
}

describe('runOnline finale (closedEarly)', () => {
  it('synthesizes a not-you loss on an abnormal post-start close with no EndMsg', async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emit('close', 1006, Buffer.from('connection lost')), 10)
    })
    // closedEarly synthesizes winner = (you + 1) % MAX_PLAYERS = 1 (not you), so the finale
    // reads as a loss; the whole finale (resultLine + renderFrame + shareCard) renders without
    // crashing.
    expect(screen).toContain('you lost — press any key')
    expect(shareText).toContain('lost')
    expect(shareText).toContain('b, c, d') // opponents list from StartMsg names
  })
})
