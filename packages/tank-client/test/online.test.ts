import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMatch, resolveShot, stateHash, DEFAULT_ANGLE, DEFAULT_POWER, type MatchState, type ShotBcast } from 'tankwait-core'
import { applyShotBcast } from '../src/online.js'

const NAMES: [string, string] = ['you', 'opp']
const BOTS: [boolean, boolean] = [false, false]

// ---------------------------------------------------------------------------
// applyShotBcast — the server-authoritative-replay + desync-tripwire seam.
// ---------------------------------------------------------------------------

describe('applyShotBcast (local replay + stateHash compare)', () => {
  it('happy path: a matching stateHash resolves the shot with desync=false', () => {
    const local = createMatch(42, NAMES, BOTS)
    const shot = { angle: 55, power: 44 }
    const expected = resolveShot(local, shot)
    const msg: ShotBcast = { t: 'shot', by: local.turn, seq: 3, angle: shot.angle, power: shot.power, stateHash: stateHash(expected.state) }

    const { out, desync } = applyShotBcast(local, msg)
    expect(desync).toBe(false)
    expect(out.state).toEqual(expected.state) // the adopted post-shot state
    expect(stateHash(out.state)).toBe(msg.stateHash)
  })

  it('desync path: a tampered stateHash flags desync (but still resolves locally)', () => {
    const local = createMatch(42, NAMES, BOTS)
    const shot = { angle: 55, power: 44 }
    const msg: ShotBcast = { t: 'shot', by: local.turn, seq: 3, angle: shot.angle, power: shot.power, stateHash: 'deadbeef' }

    const { out, desync } = applyShotBcast(local, msg)
    expect(desync).toBe(true)
    // The local resolution is still the deterministic truth; only the server's claimed hash differs.
    expect(out.state).toEqual(resolveShot(local, shot).state)
  })
})

// ---------------------------------------------------------------------------
// Integration: runOnline under a faked transport (vi.mock('ws')) + faked session.
// ---------------------------------------------------------------------------

const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    // Per-test server script, run one macrotask after the client's join.
    static script: ((ws: FakeWs) => void) | null = null
    static instances: FakeWs[] = []
    static readonly OPEN = 1 // matches ws.WebSocket.OPEN — net.ts's sendShot guard reads it
    readyState = 1 // OPEN
    sent: string[] = []
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    constructor(public url: string) {
      FakeWs.instances.push(this)
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
      setTimeout(() => FakeWs.script?.(this), 0)
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

// A finished-frame capture: renderFrame is mocked to record the RenderView it is handed so the
// tests can inspect the loop's live state / countdown without a real terminal.
const renderCalls: { state: MatchState; clockMsLeft: number | null; phase: string; aim: { angle: number; power: number } }[] = []
vi.mock('../src/render.js', () => ({
  renderFrame: (view: { state: MatchState; clockMsLeft: number | null; phase: string; aim: { angle: number; power: number } }) => {
    renderCalls.push({ state: view.state, clockMsLeft: view.clockMsLeft, phase: view.phase, aim: view.aim })
    return 'FRAME'
  },
  tooSmallScreen: () => 'TOO-SMALL',
}))

function mockSetupGame(over: { drainInput?: () => string[]; quitRequested?: () => boolean }): unknown {
  return {
    term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
    parser: {},
    colorMode: 'truecolor',
    listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
    layout: () => ({ cols: 80, rows: 24 }),
    drainInput: over.drainInput ?? (() => []),
    statusLine: () => '',
    quitRequested: over.quitRequested ?? (() => true),
    onResize: () => {},
    dispose: vi.fn(),
  }
}

vi.mock('../src/game.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game.js')>()
  return {
    ...actual,
    setupGame: vi.fn(async () => mockSetupGame({ quitRequested: () => true })),
    teardownAndExit: vi.fn(async () => 'teardown-called'),
  }
})

// The seed/names/bots the server StartMsg carries — createMatch(42, NAMES, BOTS) must reproduce it.
function humanStart(ws: InstanceType<typeof FakeWs>): void {
  const firstTurn = createMatch(42, NAMES, BOTS).firstTurn
  ws.emitJson({ t: 'start', you: 0, seed: 42, names: NAMES, bots: BOTS, firstTurn })
}

// Replay a shot sequence through the real core, yielding valid ShotBcasts (correct stateHash per
// step). `by` is derived from the live turn, so the caller only supplies angle/power.
function replay(shots: { angle: number; power: number }[]): { bcasts: ShotBcast[]; final: MatchState } {
  let s = createMatch(42, NAMES, BOTS)
  const bcasts: ShotBcast[] = []
  for (const shot of shots) {
    if (s.result) break
    const by = s.turn
    const out = resolveShot(s, shot)
    s = out.state
    bcasts.push({ t: 'shot', by, seq: 0, angle: shot.angle, power: shot.power, stateHash: stateHash(s) })
  }
  return { bcasts, final: s }
}

// Replay mild alternating shots until the core stamps a result (sudden-death decay guarantees one).
function replayToResult(): { bcasts: ShotBcast[]; final: MatchState } {
  let s = createMatch(42, NAMES, BOTS)
  const bcasts: ShotBcast[] = []
  let guard = 0
  while (!s.result && guard++ < 200) {
    const shot = s.turn === 0 ? { angle: 80, power: 20 } : { angle: 100, power: 20 }
    const by = s.turn
    const out = resolveShot(s, shot)
    s = out.state
    bcasts.push({ t: 'shot', by, seq: 0, angle: shot.angle, power: shot.power, stateHash: stateHash(s) })
  }
  return { bcasts, final: s }
}

afterEach(() => {
  FakeWs.script = null
  FakeWs.instances = []
  renderCalls.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- join failure → offline fallback --------------------------------------------------------

describe('runOnline join failure', () => {
  it("returns 'fallback' when the lobby join fails (non-2xx)", async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }))
    const { runOnline } = await import('../src/online.js')
    expect(await runOnline({ server: 'http://s', name: 'you' })).toBe('fallback')
  })

  it("returns 'fallback' when the lobby join throws (network error)", async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    const { runOnline } = await import('../src/online.js')
    expect(await runOnline({ server: 'http://s', name: 'you' })).toBe('fallback')
  })
})

// --- start-race safety: a turn msg coalesced with start must not crash on an unseeded mirror ----

describe('runOnline start seeding (coalesced start+turn)', () => {
  it('does not crash when start and the first turn arrive in one macrotask', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 }) // same macrotask as start
    }
    const caught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      caught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const { runOnline } = await import('../src/online.js')
      const outcome = await runOnline({ server: 'http://s', name: 'you' })
      expect(caught).toEqual([])
      expect(outcome).toBe('teardown-called')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})

// --- firing: sends a ShotMsg with the current aim + monotonic seq; own shot NOT applied until echo

describe('runOnline firing (send-then-wait-for-echo, monotonic seq, current aim)', () => {
  it('sends the aim with seq 0/1 across two of your turns and does not mutate local state before the echo', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))

    // A short match: you fire (turn 0), opp fires (turn 1), you fire again (turn 0), then end.
    const { bcasts } = replay([
      { angle: 70, power: 30 }, // your first shot (echo params are server-authoritative)
      { angle: 110, power: 30 }, // opp's shot
    ])
    const initialHash = stateHash(createMatch(42, NAMES, BOTS))

    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 }) // your turn
      setTimeout(() => {
        ws.emitJson(bcasts[0]) // echo of your first shot
        ws.emitJson({ t: 'turn', who: 1, deadlineMs: 20000 })
      }, 400)
      setTimeout(() => {
        ws.emitJson(bcasts[1]) // opp's shot
        ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 }) // your turn again
      }, 2000)
      // Give the second aim phase room to fire before the match ends (each shot's anim eats a beat).
      setTimeout(() => ws.emitJson({ t: 'end', result: [0, 0] }), 5000)
    }

    // Space held every tick — the loop fires only while it's actually your aim phase.
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ drainInput: () => [' '], quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })

    // Before any echo, the client has fired at least once but must NOT have advanced local state.
    await vi.advanceTimersByTimeAsync(200)
    const ws = FakeWs.instances.at(-1)!
    const preEcho = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'shot')
    expect(preEcho.length).toBeGreaterThanOrEqual(1)
    // Local state untouched pre-echo (stateHash equals the freshly-seeded match).
    const preFrames = renderCalls.filter((c) => c.phase !== 'anim')
    expect(stateHash(preFrames.at(-1)!.state)).toBe(initialHash)

    await vi.advanceTimersByTimeAsync(6000)
    await p

    const shots = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'shot')
    // Two of your turns → two sends with strictly monotonic seq, each carrying your current aim.
    expect(shots).toHaveLength(2)
    expect(shots[0]).toEqual({ t: 'shot', seq: 0, angle: DEFAULT_ANGLE, power: DEFAULT_POWER })
    expect(shots[1].seq).toBe(1)
  })
})

// --- full scripted match reaches the finale with the server's result (EndMsg precedence) --------

describe('runOnline full match reaches the finale with the server result', () => {
  it("adopts each echoed shot and shows the EndMsg's result", async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    const { bcasts } = replay([{ angle: 70, power: 25 }, { angle: 110, power: 25 }])

    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 })
      setTimeout(() => {
        ws.emitJson(bcasts[0])
        ws.emitJson({ t: 'turn', who: 1, deadlineMs: 20000 })
        ws.emitJson(bcasts[1])
        ws.emitJson({ t: 'end', result: [0, 0] }) // you (slot 0) win
      }, 200)
    }

    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).not.toBeNull()
    expect(finale!.shareText).toContain('won')
    expect(finale!.shareText).toContain('vs opp')
  })
})

// --- result precedence: state.result (a lethal echo, no EndMsg) and closedEarly synth-loss -------

describe('runOnline result precedence (state.result and closedEarly)', () => {
  it('falls back to the adopted state.result when the match ends on a shot with no EndMsg', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    const { bcasts, final } = replayToResult()
    expect(final.result).not.toBeNull()

    FakeWs.script = (ws) => {
      humanStart(ws)
      // Queue every echo up front; the loop plays them one anim at a time. No turn / end msgs.
      setTimeout(() => {
        for (const b of bcasts) ws.emitJson(b)
      }, 100)
    }

    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await p).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).not.toBeNull()
    // final.result is the core's stamped winner; the finale must reflect it (won/lost from slot 0).
    const youWon = final.result!.kind === 'win' && final.result!.winner === 0
    expect(finale!.shareText).toContain(youWon ? 'won' : 'lost')
  })

  it('end-race: the killing shot + EndMsg arriving together still plays the final shot into state', async () => {
    // The server sends the killing `shot` bcast together with `end`. A bare ended-triggered exit
    // would drop that final shot unplayed. Here EndMsg lands in the SAME macrotask as every echo
    // (the killing shot last); the loop MUST drain + finish playback so `state` adopts the final
    // result — no stale pre-shot board, and the final shot goes through the hash check.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    const { bcasts, final } = replayToResult()
    expect(final.result).not.toBeNull()
    expect(final.tanks.some((t) => t.hp === 0)).toBe(true) // a loser/decayed tank at hp 0

    FakeWs.script = (ws) => {
      humanStart(ws)
      setTimeout(() => {
        for (const b of bcasts) ws.emitJson(b) // killing shot is the last echo
        ws.emitJson({ t: 'end', result: [0, 0] }) // …and `end` in the SAME macrotask
      }, 100)
    }

    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(300_000) // advance through EVERY shot's anim frames
    expect(await p).toBe('teardown-called')

    // Playback actually ran (anim frames were rendered), not skipped on the ended flag.
    expect(renderCalls.some((c) => c.phase === 'anim')).toBe(true)
    // The finale state is the fully-drained final shot: result stamped, loser at hp 0 —
    // impossible unless the last shot was replayed AND its playback completed to adopt state.
    const finaleState = renderCalls.at(-1)!.state
    expect(finaleState.result).toEqual(final.result)
    expect(finaleState.tanks.some((t) => t.hp === 0)).toBe(true)
  })

  it('synthesizes a not-you loss on an abnormal post-start close with no EndMsg', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 })
      setTimeout(() => ws.emit('close', 1006, Buffer.from('connection lost')), 200)
    }

    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).not.toBeNull()
    expect(finale!.shareText).toContain('lost')
    expect(finale!.shareText).toContain('vs opp')
  })
})

// --- countdown derives from TurnMsg deadlineMs ------------------------------------------------

describe('runOnline countdown (derives from TurnMsg deadlineMs, floored, display-only)', () => {
  it('shows a your-turn clock that starts at ≤ deadlineMs and counts down', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    const DEADLINE = 12345
    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: DEADLINE }) // your turn
    }

    let quit = false
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => quit }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(3000)
    quit = true
    await vi.advanceTimersByTimeAsync(100)
    await p

    const clocks = renderCalls.filter((c) => c.phase === 'aim' && c.clockMsLeft !== null).map((c) => c.clockMsLeft!)
    expect(clocks.length).toBeGreaterThan(2)
    // Derived from deadlineMs: never above it, close to it at the start, floored at 0.
    expect(Math.max(...clocks)).toBeLessThanOrEqual(DEADLINE)
    expect(Math.max(...clocks)).toBeGreaterThan(DEADLINE - 500)
    for (const c of clocks) expect(c).toBeGreaterThanOrEqual(0)
    // Counts down: the last observed clock is strictly below the first.
    expect(clocks.at(-1)!).toBeLessThan(clocks[0]!)
  })
})

// --- desync tripwire: a tampered echo tears down fatally with a nonzero exit --------------------

describe('runOnline desync tripwire (dedicated)', () => {
  it('tears down with an error text and a nonzero exit when an echo stateHash mismatches', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 })
      // A well-formed echo with a WRONG stateHash — the client's local replay must catch it.
      setTimeout(() => ws.emitJson({ t: 'shot', by: 0, seq: 0, angle: 60, power: 50, stateHash: 'deadbeef' }), 300)
    }

    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ drainInput: () => [' '], quitRequested: () => false }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toBe('teardown-called')

    const call = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0]
    expect(call.finale).toBeNull() // no share card on a fatal desync
    expect(call.exitCode).toBe(1) // nonzero exit
    expect(call.errorText).toMatch(/desync/i)
  })
})

// --- finale NON-VACUITY (the house lesson): invert quitRequested, the finale must vanish --------

describe('runOnline finale non-vacuity (chain inversion of quitRequested)', () => {
  it('the SAME winning-end script yields a null finale when quitRequested()=>true', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '2' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      ws.emitJson({ t: 'turn', who: 0, deadlineMs: 20000 })
      setTimeout(() => ws.emitJson({ t: 'end', result: [0, 0] }), 10)
    }
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => true }) as never)

    const { runOnline } = await import('../src/online.js')
    const p = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(300)
    expect(await p).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).toBeNull() // quit mid-match → no finale (the branch the false-tests skip)
  })
})
