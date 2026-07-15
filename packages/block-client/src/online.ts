// Online duel loop: POST /block/join → always a room (a bot backfills, never a noOpponent-style
// outcome) → ws connect → StartMsg seeds the local mirror via the SAME deterministic createMatch()
// offline.ts uses (identical seed/names/bots ⇒ identical tick-0 boards) → then the two boards
// diverge on purpose, because blockwait uses the per-player-clock AUTHORITY model, NOT snake's
// render-only "every snap replaces the state" model:
//
//   • YOUR board is stepped LOCALLY every tick with your drained events (zero uplink latency on
//     your own feel), and your inputs are batched to the server every BATCH_TICKS.
//   • The OPPONENT board is rendered from the latest snap's other WirePlayer (you never simulate
//     the opponent — the server does, and relays it).
//   • Snaps of YOUR OWN board normally LAG behind local by the uplink round-trip, so local WINS by
//     default; a snap only REPLACES local you-state on one of three pinned resync triggers
//     (shouldAdoptSnap): a past-garbage divergence, a server force-advance, or death.
//   • Garbage arrives per-attack stamped on YOUR own clock: future → scheduled and queued exactly
//     when the local clock reaches atTick; already-reached → a resync (our board diverged).
//
// Reuses game.ts's session glue (setupGame/teardownAndExit) exactly like offline.ts, and keeps
// snake's hard-won TDZ-avoidance and result-precedence specifics (see the inline comments).
import type { GarbageMsg, MatchState, PlayerState, Result } from 'blockwait-core'
import { BATCH_TICKS, createMatch, EVENT_CODES, fromWirePlayer, MAX_EVENTS_PER_TICK, queueGarbage, sanitizeHandle, stepPlayer } from 'blockwait-core'
import { hostname } from 'node:os'
import { renderFrame, tooSmallScreen } from './render.js'
import { REDRAW_MS, resultLine, setupGame, teardownAndExit } from './game.js'
import { BlockNetClient, joinBlockMatch } from './net.js'
import { shareCard } from './share.js'

export interface OnlineOpts {
  name?: string
  server: string
}

// A batch is due at every BATCH_TICKS boundary of the local clock (0,5,10,…). Exported for tests.
export function batchDue(tick: number): boolean {
  return tick % BATCH_TICKS === 0
}

// The THREE pinned snap-adoption triggers. A snap of our OWN board normally lags local (uplink
// round-trip), so the default is to KEEP local (local wins) — adopting a stale own-board snap
// would rubber-band our feel. We hard-replace local you-state from the snap only when:
//   (1) resyncFlag is set   — a past-garbage divergence told us our board is already wrong;
//   (2) snapYou.tick >= local.tick — the server ran our board AHEAD of us (LAG force-advance);
//   (3) snapYou.alive === false    — the server says we died (topped out / grace-forfeit).
// Exported for tests.
export function shouldAdoptSnap(local: PlayerState, snapYou: PlayerState, resyncFlag: boolean): boolean {
  return resyncFlag || snapYou.tick >= local.tick || snapYou.alive === false
}

// Classify an inbound garbage message by its atTick (stamped on OUR own clock) against where our
// local clock is right now: still in the future → schedule it; already reached/passed → our board
// diverged from the server's (it applied garbage at a tick we've already run past clean), so
// resync. Exported for tests.
export function classifyGarbage(atTick: number, localTick: number): 'schedule' | 'resync' {
  return atTick > localTick ? 'schedule' : 'resync'
}

// Materialize every scheduled garbage entry whose atTick the local clock has now reached (<=),
// queueing it onto the player's pending garbage (it lands on the board at the next lock, exactly
// like offline attack routing). A tick jump (adopting a force-advance snap) can leap past several
// atTicks at once, so this applies ALL due entries, never just the exact match. Pure; exported for
// tests.
export function applyDueGarbage(you: PlayerState, scheduled: GarbageMsg[]): { you: PlayerState; remaining: GarbageMsg[] } {
  let p = you
  const remaining: GarbageMsg[] = []
  for (const g of scheduled) {
    if (g.atTick <= p.tick) p = queueGarbage(p, g.rows, g.holeCol)
    else remaining.push(g)
  }
  return { you: p, remaining }
}

// Compose the MatchState renderFrame wants: local you-state in ITS OWN slot (authoritative, never
// replaced by a snap) and the opponent in the other, in slot order. garbageRng is irrelevant to
// rendering (0). Exported for tests. This is where "opponent from snap, local you untouched"
// becomes concrete.
export function composeMatchState(you: PlayerState, opp: PlayerState, youId: number, result: Result | null): MatchState {
  const players: [PlayerState, PlayerState] = youId === 0 ? [you, opp] : [opp, you]
  return { players, garbageRng: 0, result }
}

export async function runOnline(opts: OnlineOpts): Promise<Result | 'fallback'> {
  const name = sanitizeHandle(opts.name ?? hostname())

  const joined = await joinBlockMatch(opts.server, name)
  if (joined.kind !== 'joined') return 'fallback'

  let ended: Result | null = null
  let closedEarly = false // ws closed after start with no `end` ever arriving (dropped/kicked)

  // Everything the connection handlers close over is hoisted ABOVE connect() and seeded to a
  // pre-start value, for the SAME TDZ reason snake's online.ts hoists `state`: a coalesced ws
  // chunk can deliver `start` and the first `snap` in ONE macrotask, firing onSnap synchronously
  // inside connect()'s message handler BEFORE this function's `await` continuation runs. A `let`
  // declared AFTER the await would be in the temporal dead zone for that window — a bare
  // ReferenceError thrown from a raw event-loop callback (uncaught, since exit guards aren't
  // installed yet), not a rejected promise this try/catch could see.
  //   youId starts at -1 (never a valid slot) so a pre-seed race snap's slot lookup simply MISSES
  // — and because youId and `you`/`opp` are seeded together synchronously after the await (no
  // interleaving await between them), youId !== -1 always implies `you`/`opp` are non-null.
  let youId = -1
  let you: PlayerState | null = null
  let opp: PlayerState | null = null
  let resyncFlag = false
  const scheduled: GarbageMsg[] = []
  // Latest snap-baked result (the server always stamps the final snap's WireState.result before
  // the formal `end`); ends the loop and feeds the result-precedence chain.
  let snapResult: Result | null = null
  // Pending, not-yet-batched input events, stamped [localTick, eventCode].
  let pendingEvents: [number, number][] = []

  let connected: Awaited<ReturnType<typeof BlockNetClient.connect>>
  try {
    connected = await BlockNetClient.connect(opts.server, joined.matchId, joined.token, name, {
      onSnap(wire) {
        if (wire.result) snapResult = wire.result[0] === 0 ? { kind: 'win', winner: wire.result[1] } : { kind: 'draw' }
        // Slot lookup by id, not array position: youId === -1 (pre-seed race) matches neither
        // wire player, so we bail before touching the not-yet-seeded `you`.
        const youWire = wire.players.find((p) => p[0] === youId)
        const oppWire = wire.players.find((p) => p[0] !== youId)
        if (!youWire || !oppWire || you === null) return
        // Opponent is always taken straight from the snap — we never simulate it locally.
        opp = fromWirePlayer(oppWire)
        const snapYou = fromWirePlayer(youWire)
        if (shouldAdoptSnap(you, snapYou, resyncFlag)) {
          // Hard-replace local you-state from the authoritative snap; clear the resync latch and
          // drop unsent events already covered by the snap's tick (the server has them or ran past
          // them).
          you = snapYou
          resyncFlag = false
          pendingEvents = pendingEvents.filter(([t]) => t > snapYou.tick)
        }
      },
      onGarbage(msg) {
        if (you === null) return
        if (classifyGarbage(msg.atTick, you.tick) === 'resync') resyncFlag = true
        else scheduled.push(msg)
      },
      onEnd(result) {
        ended = result
      },
      onClose() {
        closedEarly = true
      },
    })
  } catch {
    return 'fallback'
  }

  const { client: net, start } = connected
  youId = start.you
  // Seed both boards deterministically from the SAME inputs the server used for its own tick-0
  // state — this is what's on screen for the handful of ticks before the first snap. youId and the
  // seeds are assigned back-to-back with no await between, so any pre-seed race snap (handled in
  // onSnap) already bailed on the youId === -1 miss.
  const seed = createMatch(start.seed, start.names, start.bots)
  you = seed.players[youId]!
  opp = seed.players[youId === 0 ? 1 : 0]!

  const session = await setupGame()

  // The share card reports YOUR stats. Track your own tick/lines/sent every tick WHILE ALIVE and
  // hand THOSE to shareCard, so a lost game reports its real pre-death numbers rather than the
  // frozen/adopted post-death state (the b985dc8 rule offline.ts follows).
  let lastTick = you.tick
  let lastLines = you.linesCleared
  let lastSent = you.linesSent
  // Batch bookkeeping: strictly-monotonic seq, and the last upTo we sent (so a frozen clock after
  // death never re-sends a stale, non-monotonic batch the server would just drop).
  let seq = 0
  let lastSentUpTo = 0

  const redraw = (): void => {
    const layout = session.layout()
    if (layout === null) {
      const cols = process.stdout.columns ?? 80
      const rows = process.stdout.rows ?? 24
      session.term.write(tooSmallScreen(cols, rows))
      return
    }
    session.term.write(renderFrame(composeMatchState(you!, opp!, youId, snapResult), youId, layout, session.statusLine(), session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  // Quit-confirm during an online match sends nothing special: closing the socket IS elimination
  // (the server's grace window covers an accidental drop).
  session.term.installExitGuards(() => net.close())
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      // Step YOUR board locally with this tick's events (capped to what stepPlayer applies), then
      // stamp those applied events at the new local tick for the next batch.
      const events = session.drainInput().slice(0, MAX_EVENTS_PER_TICK)
      const out = stepPlayer(you!, events)
      you = out.player
      const localTick = you.tick
      for (const ev of events) pendingEvents.push([localTick, EVENT_CODES.indexOf(ev)])

      // Materialize any scheduled garbage the local clock has now reached.
      const due = applyDueGarbage(you, scheduled)
      you = due.you
      scheduled.length = 0
      scheduled.push(...due.remaining)

      if (you.alive) {
        lastTick = you.tick
        lastLines = you.linesCleared
        lastSent = you.linesSent
      }

      // Batch cadence: flush accumulated events every BATCH_TICKS. The lastSentUpTo guard keeps
      // upTo strictly monotonic (a dead player's frozen clock must never re-send the same upTo).
      if (batchDue(localTick) && localTick > lastSentUpTo) {
        net.sendInput({ t: 'input', seq: seq++, upTo: localTick, events: pendingEvents })
        pendingEvents = []
        lastSentUpTo = localTick
      }

      redraw()
      if (session.quitRequested() || ended !== null || closedEarly || snapResult !== null) {
        clearInterval(timer)
        resolve()
      }
    }, REDRAW_MS)
  })

  session.dispose()
  if (session.quitRequested()) net.close()

  // Result precedence: an explicit `end` wins; else the last snap's own baked-in result (the
  // server stamps the final snap's WireState.result before sending `end`); else, if NEITHER
  // arrived but the socket still closed (abnormal disconnect pre-finish), synthesize a loss to the
  // OTHER player — a dropped connection is the one thing we know didn't end in our own win. A
  // player-initiated quit shows no finale at all (matches offline's mid-match-quit), so it's
  // excluded first.
  const finalResult: Result | null = session.quitRequested()
    ? null
    : (ended ?? snapResult ?? (closedEarly ? { kind: 'win', winner: youId === 0 ? 1 : 0 } : null))

  const oppHandle = start.names[youId === 0 ? 1 : 0] ?? 'opponent'

  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    beforeRestore: () => net.close(),
    finale: finalResult
      ? {
          screen: (() => {
            const layout = session.layout()
            // Pass the real StartMsg names so an online winner is labeled by their actual handle
            // rather than offline's bot·<id> fallback.
            const line = `${resultLine(finalResult, youId, start.names)} — press any key`
            const rendered = composeMatchState(you!, opp!, youId, finalResult)
            return layout
              ? renderFrame(rendered, youId, layout, line, session.colorMode)
              : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${line}`
          })(),
          shareText: shareCard(finalResult, youId, lastTick, lastLines, lastSent, oppHandle),
        }
      : null,
  })
}
