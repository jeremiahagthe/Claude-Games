import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMatch, queueGarbage, stepPlayer, toWire, type GarbageMsg, type PlayerState } from 'blockwait-core'
import { applyDueGarbage, applyGarbageMsg, batchDue, classifyGarbage, composeMatchState, shouldAdoptSnap } from '../src/online.js'

// ---------------------------------------------------------------------------
// Pure exported helpers — the resync/garbage/batch semantics pinned in the plan.
// ---------------------------------------------------------------------------

// A live PlayerState at an arbitrary own-clock tick, cloned from a real match so every field is
// valid (hand-built PlayerStates are easy to get subtly wrong).
function playerAt(tick: number, alive = true): PlayerState {
  const p = createMatch(42, ['you', 'opp'], [false, false]).players[0]
  return { ...p, tick, alive }
}

describe('batchDue', () => {
  it('is true only on multiples of BATCH_TICKS (5)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9, 10, 15].map(batchDue)).toEqual([
      true, false, false, false, false, true, false, false, true, true,
    ])
  })
})

describe('shouldAdoptSnap (the three adoption triggers + local-wins default)', () => {
  it('trigger 1: resyncFlag set forces adoption even when local is ahead and alive', () => {
    expect(shouldAdoptSnap(playerAt(20), playerAt(10), true)).toBe(true)
  })

  it('trigger 2: snapYou.tick >= local.tick (server force-advanced us)', () => {
    expect(shouldAdoptSnap(playerAt(10), playerAt(10), false)).toBe(true) // equal counts
    expect(shouldAdoptSnap(playerAt(10), playerAt(11), false)).toBe(true) // ahead
  })

  it('trigger 3: snapYou.alive === false (server says we died)', () => {
    expect(shouldAdoptSnap(playerAt(20), playerAt(10, false), false)).toBe(true)
  })

  it('local wins by default: a stale, alive snap behind our own clock is NOT adopted', () => {
    expect(shouldAdoptSnap(playerAt(20), playerAt(10, true), false)).toBe(false)
  })
})

// The spec's governing promise: "garbage events let the local sim schedule incoming garbage
// exactly; resync rare by construction". The server stamps atTick = our server-side tick at queue
// time, which is ALWAYS ≤ our local tick (at best it equals lastSentUpTo) — so past-atTick must be
// the normal case, not a resync. Only an intervening LOCAL LOCK after atTick is genuine
// divergence: that lock already consumed/deferred pending garbage the server will replay
// differently.
describe('classifyGarbage', () => {
  it('a future atTick schedules', () => {
    expect(classifyGarbage(10, 5, -1)).toBe('schedule')
  })

  it('a past atTick with NO local lock after it queues immediately (resync rare by construction)', () => {
    expect(classifyGarbage(5, 5, -1)).toBe('queue') // no lock at all
    expect(classifyGarbage(3, 5, 3)).toBe('queue') // lock AT atTick is not after it
    expect(classifyGarbage(3, 5, 2)).toBe('queue') // lock before atTick
  })

  it('a past atTick with a local lock after it is genuine divergence → resync', () => {
    expect(classifyGarbage(3, 5, 4)).toBe('resync')
    expect(classifyGarbage(3, 5, 5)).toBe('resync')
  })
})

describe('applyGarbageMsg (mid-match attack handling seam)', () => {
  const msg = (atTick: number): GarbageMsg => ({ t: 'garbage', rows: 2, holeCol: 3, atTick })

  it('future atTick → handed back for scheduling, state untouched', () => {
    const you = playerAt(5)
    const r = applyGarbageMsg(you, msg(9), -1)
    expect(r.schedule).toEqual(msg(9))
    expect(r.you).toBe(you)
    expect(r.resync).toBe(false)
  })

  it('past atTick, no intervening local lock → pendingGarbage gains the entry, NO resync', () => {
    const r = applyGarbageMsg(playerAt(10), msg(7), 5) // last lock at 5 ≤ atTick 7
    expect(r.you.pendingGarbage).toEqual([{ rows: 2, holeCol: 3 }])
    expect(r.resync).toBe(false) // and thus no adoption on the next snap (shouldAdoptSnap default)
    expect(r.schedule).toBeNull()
  })

  it('past atTick with a local lock after it → resync, state untouched', () => {
    const you = playerAt(10)
    const r = applyGarbageMsg(you, msg(7), 9) // lock at 9 > atTick 7: divergence
    expect(r.resync).toBe(true)
    expect(r.you).toBe(you)
    expect(r.schedule).toBeNull()
  })
})

describe('applyDueGarbage (future garbage lands exactly when the local clock reaches atTick)', () => {
  it('holds a future entry, then queues it onto pendingGarbage at atTick', () => {
    const scheduled: GarbageMsg[] = [{ t: 'garbage', rows: 3, holeCol: 4, atTick: 5 }]

    // At tick 3 the entry is in the future: nothing queued, entry retained.
    const early = applyDueGarbage(playerAt(3), scheduled)
    expect(early.you.pendingGarbage).toEqual([])
    expect(early.remaining).toEqual(scheduled)

    // At tick 5 (clock reached atTick) the entry materializes onto pendingGarbage and clears.
    const due = applyDueGarbage(playerAt(5), scheduled)
    expect(due.you.pendingGarbage).toEqual([{ rows: 3, holeCol: 4 }])
    expect(due.remaining).toEqual([])
  })

  it('applies a past-due entry too (a tick jump must never strand scheduled garbage)', () => {
    const scheduled: GarbageMsg[] = [{ t: 'garbage', rows: 2, holeCol: 1, atTick: 5 }]
    const due = applyDueGarbage(playerAt(9), scheduled)
    expect(due.you.pendingGarbage).toEqual([{ rows: 2, holeCol: 1 }])
    expect(due.remaining).toEqual([])
  })
})

describe('composeMatchState (opponent from snap, local you untouched, slot order preserved)', () => {
  it('places the local you-state in its own slot and the opponent in the other', () => {
    const you = playerAt(30)
    const opp = { ...playerAt(12), id: 1 }

    const asSlot0 = composeMatchState(you, opp, 0, null)
    expect(asSlot0.players[0]).toBe(you) // local you, by reference — never replaced by the snap
    expect(asSlot0.players[1]).toBe(opp)
    expect(asSlot0.result).toBeNull()
    expect(asSlot0.garbageRng).toBe(0)

    const asSlot1 = composeMatchState(you, opp, 1, { kind: 'win', winner: 0 })
    expect(asSlot1.players[1]).toBe(you)
    expect(asSlot1.players[0]).toBe(opp)
    expect(asSlot1.result).toEqual({ kind: 'win', winner: 0 })
  })
})

// ---------------------------------------------------------------------------
// Integration: runOnline under a faked transport (vi.mock('ws')) + faked session.
// ---------------------------------------------------------------------------

const { FakeWs } = vi.hoisted(() => {
  class FakeWs {
    // Per-test server script, run one macrotask after the client's hello. null = the default
    // coalesced start+snap chunk (the TDZ regression's exact trigger).
    static script: ((ws: FakeWs) => void) | null = null
    static instances: FakeWs[] = []
    static readonly OPEN = 1 // matches ws.WebSocket.OPEN — net.ts's sendInput guard reads it
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
      if (msg.t !== 'hello') return
      setTimeout(() => {
        if (FakeWs.script) {
          FakeWs.script(this)
          return
        }
        // The coalesced chunk: start, then immediately (same macrotask) the first snap — the TDZ
        // regression trigger. onSnap fires before runOnline's own `await` continuation seeds the
        // local mirror.
        this.emitJson({ t: 'start', you: 0, seed: 42, names: ['you', 'opp'], bots: [false, false] })
        this.emitJson({ t: 'snap', state: seededWire(1) })
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

// A valid on-wire state from a real match, with player 0's own clock set to `tick`.
function seededWire(tick: number, result: [0, number] | [1] | null = null): unknown {
  const w = toWire(createMatch(42, ['you', 'opp'], [false, false]))
  w.players[0][4] = tick
  w.result = result
  return w
}

function snapWith(result: [0, number] | [1] | null, tick = 3): unknown {
  return { t: 'snap', state: seededWire(tick, result) }
}

// setupGame() drives real stdin/stdout/terminal state — faked here. Each test supplies its own
// drainInput/quitRequested behavior.
function mockSetupGame(over: { drainInput?: () => unknown[]; quitRequested?: () => boolean }): unknown {
  return {
    term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
    parser: {},
    colorMode: 'truecolor',
    listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
    layout: () => ({ kind: 'k1', boardW: 10, boardRows: 20, cellW: 2 }),
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

// The mocked layout above is a stand-in; renderFrame must tolerate it. Stub render so integration
// tests exercise the loop/finale wiring, not the (separately-tested) renderer's layout contract.
vi.mock('../src/render.js', () => ({
  renderFrame: () => 'FRAME',
  tooSmallScreen: () => 'TOO-SMALL',
}))

afterEach(() => {
  FakeWs.script = null
  FakeWs.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runOnline mirror seeding (TDZ regression)', () => {
  it('does not crash when start+snap coalesce into one macrotask', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))

    const caught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      caught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const { runOnline } = await import('../src/online.js')
      const outcome = await runOnline({ server: 'http://s', name: 'you' })
      expect(caught).toEqual([]) // no ReferenceError from an uninitialized closed-over `you`
      expect(outcome).toBe('teardown-called')
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})

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

// --- finale construction (result precedence, names carry-item, non-vacuity) -----------------
//
// These run the loop for real (quitRequested false) under FAKE timers, with a per-test
// FakeWs.script driving the server: `start` immediately, then snap/end/close one macrotask LATER
// (10ms), because runOnline's createMatch seeding overwrites any snap that lands before it.

async function runFinale(script: (ws: InstanceType<typeof FakeWs>) => void): Promise<{ screen: string; shareText: string }> {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
  FakeWs.script = script

  const game = await import('../src/game.js')
  vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => false }) as never)

  const { runOnline } = await import('../src/online.js')
  const resultPromise = runOnline({ server: 'http://s', name: 'you' })
  await vi.advanceTimersByTimeAsync(300)
  const outcome = await resultPromise
  expect(outcome).toBe('teardown-called')

  const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
  expect(finale).not.toBeNull()
  return { screen: finale!.screen, shareText: finale!.shareText }
}

function humanStart(ws: InstanceType<typeof FakeWs>): void {
  ws.emitJson({ t: 'start', you: 0, seed: 42, names: ['you', 'opp'], bots: [false, false] })
}

describe('runOnline finale (result precedence + names carry-item)', () => {
  it('EndMsg wins the precedence chain over the snap-baked state.result', async () => {
    const { shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => {
        ws.emitJson(snapWith([0, 0])) // snap says you (slot 0) won
        ws.emitJson({ t: 'end', result: [0, 1] }) // EndMsg says opp won — must win precedence
      }, 10)
    })
    // resultLine renders from EndMsg's winner (opp), so the share card reads a loss.
    expect(shareText).toContain('lost')
    expect(shareText).toContain('vs opp')
  })

  it("falls back to the snap's baked-in state.result when no EndMsg arrives", async () => {
    const { shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emitJson(snapWith([0, 1])), 10) // opp won, no end
    })
    expect(shareText).toContain('lost')
  })

  it('synthesizes a not-you loss on an abnormal post-start close with no EndMsg', async () => {
    const { shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emit('close', 1006, Buffer.from('connection lost')), 10)
    })
    expect(shareText).toContain('lost')
    expect(shareText).toContain('vs opp')
  })

  it('a winning EndMsg for you reads as a win', async () => {
    const { shareText } = await runFinale((ws) => {
      humanStart(ws)
      setTimeout(() => ws.emitJson({ t: 'end', result: [0, 0] }), 10)
    })
    expect(shareText).toContain('won')
    expect(shareText).not.toContain('lost')
  })
})

// --- finale NON-VACUITY (the d187fe5 lesson) ------------------------------------------------
//
// The finale tests above assert `finale !== null` under quitRequested()=>false. If that mock
// silently made the WHOLE finale block unreachable, those assertions would be vacuous. Prove the
// block is genuinely gated on quitRequested by INVERTING it: the identical winning-end script with
// quitRequested()=>true must produce a NULL finale (a mid-match quit shows nothing). Flipping the
// one variable flips the outcome — so the false-branch tests are exercising the real code path.

describe('runOnline finale non-vacuity (chain inversion of quitRequested)', () => {
  it('the SAME winning-end script yields a null finale when quitRequested()=>true', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      setTimeout(() => ws.emitJson({ t: 'end', result: [0, 0] }), 10)
    }
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(async () => mockSetupGame({ quitRequested: () => true }) as never)

    const { runOnline } = await import('../src/online.js')
    const resultPromise = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(300)
    expect(await resultPromise).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).toBeNull() // quit mid-match → no finale (the branch the false-tests skip)
  })
})

// --- input batching (every BATCH_TICKS, correct seq/upTo/stamps, cleared after send) ---------

describe('runOnline input batching', () => {
  it('sends a batch every BATCH_TICKS with monotonic seq, upTo=localTick, stamped events, cleared after send', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
    // start only — no snap/end/close, so the loop runs purely on the local sim until we quit.
    FakeWs.script = (ws) => humanStart(ws)

    // Scripted per-tick input: 'left' on the first loop tick, 'right'+'rotCW' on the second, then
    // quiet. quitRequested flips true after 12 loop ticks so batches at localTick 5 and 10 fire.
    let tick = 0
    const inputs: string[][] = [['left'], ['right', 'rotCW']]
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(
      async () =>
        mockSetupGame({
          drainInput: () => (inputs[tick++] ?? []) as unknown[],
          quitRequested: () => tick > 12,
        }) as never,
    )

    const { runOnline } = await import('../src/online.js')
    const resultPromise = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(800)
    await resultPromise

    const ws = FakeWs.instances.at(-1)!
    const batches = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'input')
    // Event codes: left=0, right=1, rotCW=2. Stamped at the post-step local tick (1 and 2).
    expect(batches[0]).toEqual({ t: 'input', seq: 0, upTo: 5, events: [[1, 0], [2, 1], [2, 2]] })
    // Second batch: seq incremented, upTo advanced, events CLEARED (empty since inputs went quiet).
    expect(batches[1]).toEqual({ t: 'input', seq: 1, upTo: 10, events: [] })
  })
})

// --- resync adoption vs the server's accepted floor (reviewer finding, fix round) ------------
//
// resyncFlag adoption can move the local clock BACKWARD (snapYou.tick < local.tick), but the
// server's lastUpTo only ever climbs — any post-adoption event stamped at a tick ≤ our last
// accepted upTo lands outside the server's (lastUpTo, upTo] window and drops the WHOLE batch
// (block-match.ts applyOneBatch). This drives runOnline through exactly that sequence: batches at
// upTo 5 and 10 (floor = 10) → past garbage (resyncFlag) → an older snap (adoption, clock rewind)
// → more inputs → the next batch must stay server-acceptable: monotonic seq/upTo AND every event
// tick strictly above the pre-adoption floor, with the inputs actually delivered (not dropped).

describe('runOnline resync adoption (backward clock) keeps batches server-acceptable', () => {
  it('post-adoption batches stamp every event above the pre-adoption sent floor, with stale pending events dropped', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      // At ~560ms the local clock is at tick 11 (loop ticks every 50ms) and batches for upTo 5
      // and 10 have been sent. A LOCAL LOCK happened at tick 9 (the scripted hardDrop below), so
      // past garbage with atTick 8 < 9 is genuine divergence → resyncFlag; the tick-3 snap
      // (< 11) then triggers adoption — the backward-clock path under test.
      setTimeout(() => {
        ws.emitJson({ t: 'garbage', rows: 2, holeCol: 3, atTick: 8 })
        ws.emitJson({ t: 'snap', state: seededWire(3) })
      }, 560)
    }

    // 'left' on loop tick 2 (sent in the upTo-5 batch), 'hardDrop' on tick 9 (the intervening
    // lock), 'left' on tick 11 (UNSENT pre-adoption — must be dropped wholesale on adoption, not
    // retained: retained events were never re-applied to the adopted local state and can merge
    // with re-issued ticks past MAX_EVENTS_PER_TICK), 'right' on ticks 13/14 (post-adoption).
    let tick = 0
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(
      async () =>
        mockSetupGame({
          drainInput: () => {
            const t = ++tick
            if (t === 2 || t === 11) return ['left']
            if (t === 9) return ['hardDrop']
            if (t === 13 || t === 14) return ['right']
            return []
          },
          quitRequested: () => tick > 30,
        }) as never,
    )

    const { runOnline } = await import('../src/online.js')
    const resultPromise = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(2000)
    await resultPromise

    const ws = FakeWs.instances.at(-1)!
    const batches = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'input')
    // Anchor the pre-adoption floor: first two batches are upTo 5 (carrying the 'left' at tick 2)
    // and upTo 10 (carrying the hardDrop lock at tick 9).
    expect(batches[0]).toMatchObject({ seq: 0, upTo: 5, events: [[2, 0]] })
    expect(batches[1]).toMatchObject({ seq: 1, upTo: 10, events: [[9, 5]] })
    const floor = 10

    // Strictly monotonic seq and upTo across ALL batches (the server drops violations silently).
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].seq).toBeGreaterThan(batches[i - 1].seq)
      expect(batches[i].upTo).toBeGreaterThan(batches[i - 1].upTo)
    }

    // Every post-adoption batch: all event ticks strictly above the floor AND within (floor, upTo]
    // — i.e. the server's applyOneBatch would accept it, no silent whole-batch loss.
    const post = batches.filter((b) => b.seq >= 2)
    expect(post.length).toBeGreaterThan(0)
    for (const b of post) {
      for (const [t] of b.events) {
        expect(t).toBeGreaterThan(floor)
        expect(t).toBeLessThanOrEqual(b.upTo)
      }
    }
    const postCodes = post.flatMap((b) => b.events.map(([, c]: [number, number]) => c))
    // The tick-11 'left' (code 0) was pending-unsent at adoption: dropped, never on the wire.
    expect(postCodes).not.toContain(0)
    // The post-adoption 'right' inputs (code 1) did make it to the wire.
    expect(postCodes).toContain(1)
  })
})

// --- past-atTick garbage WITHOUT an intervening lock: no resync, no adoption (finding #1) -----
//
// The server stamps atTick = our server-side tick at queue time, always ≤ our local tick — if that
// alone forced a resync, EVERY received attack would rubber-band the board (the 'schedule' branch
// would be dead code). With no local lock after atTick, queueing the garbage immediately is
// semantically identical to queueing at atTick (pendingGarbage only materializes at locks), so the
// local sim stays authoritative and the next older-tick snap must NOT be adopted.

describe('runOnline past-atTick garbage without an intervening lock', () => {
  it('does not resync: an older snap after the attack is NOT adopted (local clock never rewinds)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
    FakeWs.script = (ws) => {
      humanStart(ws)
      // Local tick ~11, NO local lock has happened (no hardDrop; gravity is 20 ticks/cell so
      // nothing locked by tick 11). atTick 8 ≤ 11 → must queue immediately, NOT resync; the
      // tick-3 snap right behind it must then be ignored (local wins).
      setTimeout(() => {
        ws.emitJson({ t: 'garbage', rows: 2, holeCol: 3, atTick: 8 })
        ws.emitJson({ t: 'snap', state: seededWire(3) })
      }, 560)
    }

    let tick = 0
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(
      async () =>
        mockSetupGame({
          drainInput: () => (++tick === 13 ? ['right'] : []),
          quitRequested: () => tick > 20,
        }) as never,
    )

    const { runOnline } = await import('../src/online.js')
    const resultPromise = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync(1500)
    await resultPromise

    const ws = FakeWs.instances.at(-1)!
    const batches = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'input')
    // The tick-13 'right' stamps at LOCAL tick 13: no adoption ever rewound the clock (an adoption
    // to the tick-3 snap fast-forwarded to 10 would restamp this same loop iteration at tick 12).
    const withEvents = batches.filter((b) => b.events.length > 0)
    expect(withEvents).toHaveLength(1)
    expect(withEvents[0].events).toEqual([[13, 1]])
  })
})

// --- final batch flush on death (finding #2) --------------------------------------------------
//
// Death freezes the local clock, so batchDue (tick % BATCH_TICKS === 0) never fires again — if
// death lands off a batch boundary, the fatal hardDrop (and the attack a same-lock clear routed)
// would never reach the server. The loop must flush the partial batch the instant alive flips.

describe('runOnline flushes the final batch when death lands off a batch boundary', () => {
  it('sends a last batch with upTo = death tick containing the fatal event', async () => {
    // Deterministic local death: hardDrop every tick from tick 1 on the seed-42 board tops out at
    // a known tick. Computed with the REAL core sim so the test tracks any core rebalance.
    let sim = createMatch(42, ['you', 'opp'], [false, false]).players[0]
    while (sim.alive) sim = stepPlayer(sim, ['hardDrop']).player
    const deathTick = sim.tick
    expect(deathTick % 5).not.toBe(0) // precondition: death lands OFF the batch boundary

    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ matchId: 'm1', token: '1' }) }))
    FakeWs.script = (ws) => humanStart(ws) // start only; no snap/end — local death drives the test

    let tick = 0
    const game = await import('../src/game.js')
    vi.mocked(game.setupGame).mockImplementation(
      async () =>
        mockSetupGame({
          drainInput: () => {
            tick++
            return ['hardDrop'] // post-death drains are discarded by the loop
          },
          quitRequested: () => tick > deathTick + 8,
        }) as never,
    )

    const { runOnline } = await import('../src/online.js')
    const resultPromise = runOnline({ server: 'http://s', name: 'you' })
    await vi.advanceTimersByTimeAsync((deathTick + 12) * 50)
    await resultPromise

    const ws = FakeWs.instances.at(-1)!
    const batches = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'input')
    const last = batches.at(-1)!
    expect(last.upTo).toBe(deathTick) // flushed AT death, not at the never-reached next boundary
    expect(last.events).toContainEqual([deathTick, 5]) // the fatal hardDrop reached the server
    // And nothing after it: the frozen clock never re-sends.
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].seq).toBeGreaterThan(batches[i - 1].seq)
      expect(batches[i].upTo).toBeGreaterThan(batches[i - 1].upTo)
    }
  })
})

// A tiny sanity check that queueGarbage/stepPlayer are the real core fns applyDueGarbage builds on
// (guards against a future refactor stubbing them out).
describe('applyDueGarbage integrates the real core queueGarbage', () => {
  it('produces the same pendingGarbage a direct queueGarbage call would', () => {
    const you = stepPlayer(playerAt(4), []).player // tick 5, alive
    const viaHelper = applyDueGarbage(you, [{ t: 'garbage', rows: 1, holeCol: 2, atTick: 5 }]).you
    const direct = queueGarbage(you, 1, 2)
    expect(viaHelper.pendingGarbage).toEqual(direct.pendingGarbage)
  })
})
