import { afterEach, describe, expect, it, vi } from 'vitest'

// Regression test for the mirror-seeding TDZ crash, transcribed from
// packages/bomber-client/test/online.test.ts's Fix 2 regression: `let state` in online.ts must
// be declared BEFORE `await SnakeNetClient.connect(...)`, since the `onSnap` handler closes over
// it. A coalesced ws chunk that delivers `start` and the first `snap` in ONE macrotask (real
// sockets can do this) fires onSnap synchronously, inside connect()'s own message handler,
// BEFORE runOnline()'s `await` continuation has run far enough to declare `state` -- a bare
// ReferenceError thrown from inside a raw event-loop callback, which is an uncaught exception
// (not a rejected promise) since exit guards aren't installed yet.
//
// FakeWs mirrors net.test.ts's fake (same shape SnakeNetClient.connect expects from `ws`), but
// is wired here via `vi.mock('ws')` so the REAL net.ts/online.ts code runs unmodified -- only
// the transport is faked, exactly reproducing the two-messages-in-one-macrotask race.
const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    // Per-test server script, run one macrotask after the client's hello. null = the default
    // coalesced start+snap chunk below (the TDZ regression's exact trigger). The finale tests
    // install their own scripts (start now, then snap/end/close in a LATER macrotask — a
    // post-seed snap must arrive after runOnline's createMatch seeding to survive it).
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
          names: ['you', 'bot·1', 'bot·2', 'bot·3'],
          bots: [false, true, true, true],
        })
        this.emitJson({
          t: 'snap',
          state: {
            tick: 1,
            cd: 4,
            rng: 1,
            rings: 0,
            food: [],
            snakes: [[0, 'you', 0, 1, 1, 0, 0, 7, 4, []]],
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
// during the join/connect phase, before setupGame() is even called) and unsafe to run for real
// inside a test process, so it's faked with a session that ends the redraw loop on its very
// first check.
vi.mock('../src/game.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game.js')>()
  return {
    ...actual,
    setupGame: vi.fn(async () => ({
      term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
      parser: {},
      colorMode: 'truecolor',
      listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
      layout: () => ({ k: 1, cols: 80, rows: 24 }),
      drainInput: () => ({ dir: null }),
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

describe('runOnline mirror seeding (TDZ regression)', () => {
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

// --- finale construction (result precedence, names carry-item, closedEarly) -----------------
//
// The TDZ test above quits on the loop's first check, so it never reaches the finale block.
// These tests run the loop for real (quitRequested false) under FAKE timers — no wall-clock
// sleeping — with a per-test FakeWs.script driving the server side: `start` immediately, then
// snap/end/close one macrotask LATER (10ms), because runOnline's createMatch seeding
// unconditionally overwrites any snap that lands before it. teardownAndExit stays mocked; each
// test asserts on the `finale` object runOnline passes it (screen text + shareText).

const HUMAN_NAMES = ['you', 'alice', 'bob', 'carol']

function humanStart(ws: InstanceType<typeof FakeWs>): void {
  ws.emitJson({ t: 'start', you: 0, seed: 42, names: HUMAN_NAMES, bots: [false, false, false, true] })
}

function snapWith(result: [0, number] | [1] | null, tick = 3): unknown {
  return {
    t: 'snap',
    state: {
      tick,
      cd: 4,
      rng: 1,
      rings: 0,
      food: [],
      snakes: [[0, 'you', 0, 1, 1, 0, 0, 7, 4, []]],
      result,
    },
  }
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

async function runFinale(script: (ws: InstanceType<typeof FakeWs>) => void): Promise<{ screen: string; shareText: string }> {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: 't1' }) }))
  FakeWs.script = script

  const game = await import('../src/game.js')
  vi.mocked(game.setupGame).mockImplementation(async () => ({
    term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
    parser: {},
    colorMode: 'truecolor',
    listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
    layout: () => ({ k: 1, cols: 80, rows: 24 }),
    drainInput: () => ({ dir: null }),
    statusLine: () => '',
    quitRequested: () => false, // the match itself must end the loop, not a quit
    onResize: () => {},
    dispose: vi.fn(),
  }) as never)

  const { runOnline } = await import('../src/online.js')
  const resultPromise = runOnline({ server: 'http://s', name: 'you' })
  // Fires (in order, with microtask flushes between): ws open → hello → start (t=0) →
  // scripted snap/end/close (t=10) → the loop's first interval tick (t≈50) → teardown.
  await vi.advanceTimersByTimeAsync(200)
  const outcome = await resultPromise
  expect(outcome).toBe('teardown-called')

  const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
  expect(finale).not.toBeNull()
  return { screen: stripAnsi(finale!.screen), shareText: finale!.shareText }
}

describe('runOnline finale (result precedence + names carry-item)', () => {
  it('EndMsg wins the precedence chain over state.result', async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => {
        ws.emitJson(snapWith([0, 1])) // state.result: alice won
        ws.emitJson({ t: 'end', result: [0, 2] }) // EndMsg: bob won — this must win
      }, 10)
    })
    expect(screen).toContain('bob won — press any key') // EndMsg's winner, by StartMsg name
    expect(screen).not.toContain('alice won')
    expect(shareText).toContain('lost')
  })

  it("falls back to the snap's baked-in state.result when no EndMsg ever arrives", async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emitJson(snapWith([0, 1])), 10) // alice won, no end
    })
    expect(screen).toContain('alice won — press any key')
    expect(shareText).toContain('lost')
  })

  it('synthesizes a not-you loss on an abnormal post-start close with no EndMsg', async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emit('close', 1006, Buffer.from('connection lost')), 10)
    })
    // (you + 1) % MAX_PLAYERS = 1 → alice; labeled by her real handle, and the whole
    // finale (resultLine + renderFrame + shareCard) renders without crashing.
    expect(screen).toContain('alice won — press any key')
    expect(shareText).toContain('lost')
    expect(shareText).toContain('alice, bob, carol') // opponents list from StartMsg names
  })

  it('a winning EndMsg for you renders "you won!"', async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emitJson({ t: 'end', result: [0, 0] }), 10)
    })
    expect(screen).toContain('you won! — press any key')
    expect(shareText).toContain('won')
  })
})

// --- share-card length + short-snakes-array safety (Findings 2 & 3) -------------------------
//
// Finding 2: the sim clears a dead snake's `cells` to `[]`, and in online play you're always
// dead-or-missing by the final snap when you lose — passing state.snakes[you].cells.length
// straight to shareCard reported "length 0" on every loss. online.ts must track the player's
// own length client-side (looked up by id, updated on every snap while alive) and pass THAT.
//
// Finding 3: the wire validator admits a `snakes` array of length 0..4 with no id/slot
// guarantee, so `state.snakes[you]` (array-position indexing) can be undefined on a
// hostile/buggy server's final snap. The fix must look the snake up by id with a safe fallback
// instead of indexing positionally, so a short/empty snakes array never throws.
function snapWithYouSnake(
  opts: { alive?: 0 | 1; segments?: [number, number][]; result?: [0, number] | [1] | null },
  tick = 3,
): unknown {
  const { alive = 1, segments = [], result = null } = opts
  return {
    t: 'snap',
    state: {
      tick,
      cd: 4,
      rng: 1,
      rings: 0,
      food: [],
      snakes: [[0, 'you', 0, alive, 1, 0, 0, 7, 4, segments]],
      result,
    },
  }
}

function snapWithNoSnakes(result: [0, number] | [1] | null, tick = 3): unknown {
  return {
    t: 'snap',
    state: { tick, cd: 4, rng: 1, rings: 0, food: [], snakes: [], result },
  }
}

describe('runOnline share card length + short snakes array (Findings 2 & 3)', () => {
  it('carries the pre-death length into the share card when you lose, not 0', async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => {
        // Alive, grown to 5 cells (1 head + a 4-long RLE segment run down).
        ws.emitJson(snapWithYouSnake({ alive: 1, segments: [[2, 4]] }))
        // Then dead, cells cleared by the sim, someone else's win baked into the snap.
        ws.emitJson(snapWithYouSnake({ alive: 0, segments: [], result: [0, 1] }))
      }, 10)
    })
    expect(screen).toContain('alice won — press any key')
    expect(shareText).toContain('length 5')
    expect(shareText).not.toContain('length 0')
  })

  it("a final snap with an empty snakes array doesn't throw and still produces a finale", async () => {
    const { screen, shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => {
        ws.emitJson(snapWithYouSnake({ alive: 1, segments: [[2, 2]] })) // length 3, then vanish
        ws.emitJson(snapWithNoSnakes([0, 1]))
      }, 10)
    })
    expect(screen).toContain('alice won — press any key')
    // Falls back to the last known pre-vanish length rather than crashing or reporting 0.
    expect(shareText).toContain('length 3')
    expect(shareText).not.toContain('length 0')
  })
})

describe('resultLine names carry-item (unit)', () => {
  it('labels a non-you online winner by their StartMsg name when names are passed', async () => {
    const { resultLine } = await import('../src/game.js') // mock spreads importOriginal — real fn
    expect(resultLine({ kind: 'win', winner: 2 }, 0, HUMAN_NAMES)).toBe('bob won')
  })

  it('keeps the offline bot·<id> fallback when names are omitted', async () => {
    const { resultLine } = await import('../src/game.js')
    expect(resultLine({ kind: 'win', winner: 2 }, 0)).toBe('bot·2 won')
    expect(resultLine({ kind: 'win', winner: 0 }, 0)).toBe('you won!')
    expect(resultLine({ kind: 'draw' }, 0)).toBe('draw')
  })
})

describe('runOnline join failure', () => {
  it("returns 'fallback' when the lobby join fails (non-2xx)", async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }))
    const { runOnline } = await import('../src/online.js')
    const outcome = await runOnline({ server: 'http://s', name: 'you' })
    expect(outcome).toBe('fallback')
  })

  it("returns 'fallback' when the lobby join throws (network error)", async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const { runOnline } = await import('../src/online.js')
    const outcome = await runOnline({ server: 'http://s', name: 'you' })
    expect(outcome).toBe('fallback')
  })
})
