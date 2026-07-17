// Online artillery duel: POST /tank/join → always a room (a bot backfills, never a noOpponent-style
// outcome) → ws connect → StartMsg seeds the local mirror via the SAME deterministic createMatch()
// offline.ts uses (identical seed/names/bots ⇒ identical tick-0 state). Unlike snake's render-only
// "every snap replaces the state" model and block's per-player-clock authority model, tankwait is
// turn-based and SERVER-AUTHORITATIVE-BY-REPLAY: the server relays every fire as a `shot` broadcast
// carrying a stateHash, and the client replays that shot LOCALLY (resolveShot) and compares hashes.
//
//   • ALL shots — including YOUR OWN — apply only when the server's ShotBcast echo arrives. Firing
//     sends {t:'shot', seq, angle, power} upstream and drops straight into a brief wait; the local
//     board is untouched until the echo. The echo drives applyShotBcast → local resolveShot →
//     stateHash compare. A mismatch is a FATAL desync (teardown + nonzero exit) — the tripwire that
//     guarantees the two sides never silently diverge.
//   • `turn` notices set whose-turn and the display-only countdown base (deadlineMs − elapsed since
//     receipt, floored at 0). Off-turn keys are ignored (only your aim phase folds them through
//     applyKey); esc quit-confirm sends nothing — closing the socket IS the forfeit.
//
// Reuses game.ts's session glue (setupGame/teardownAndExit) exactly like offline.ts, and keeps the
// family's hard-won TDZ-avoidance and result-precedence specifics (see the inline comments).
import type { MatchState, Result, ResolveOut, Shot, ShotBcast } from 'tankwait-core'
import { createMatch, resolveShot, sanitizeHandle, stateHash } from 'tankwait-core'
import { hostname } from 'node:os'
import { renderFrame, tooSmallScreen, type RenderView } from './render.js'
import { applyKey, isFireKey, REDRAW_MS, resultLine, setupGame, teardownAndExit } from './game.js'
import { advancePlayback, createPlayback, playbackView, type Playback } from './anim.js'
import { TankNetClient, joinTankMatch } from './net.js'
import { shareCard } from './share.js'

export interface OnlineOpts {
  name?: string
  server: string
}

// Replay a server ShotBcast against the local mirror and check the result against the server's
// claimed hash. resolveShot uses local.turn as the shooter, so a well-ordered match has
// local.turn === msg.by; a divergence would surface here as a hash mismatch. `out` is handed back so
// the caller can drive the playback and adopt out.state; `desync` true = fatal. Pure; exported for
// tests — this is THE server-authoritative-replay + tripwire seam.
export function applyShotBcast(local: MatchState, msg: ShotBcast): { out: ResolveOut; desync: boolean } {
  const out = resolveShot(local, { angle: msg.angle, power: msg.power })
  return { out, desync: stateHash(out.state) !== msg.stateHash }
}

type Phase = 'aim' | 'anim' | 'wait'

export async function runOnline(opts: OnlineOpts): Promise<Result | 'fallback'> {
  const name = sanitizeHandle(opts.name ?? hostname())

  const joined = await joinTankMatch(opts.server, name)
  if (joined.kind !== 'joined') return 'fallback'

  let ended: Result | null = null
  let closedEarly = false // ws closed after start with no `end` ever arriving (dropped/kicked)

  // Everything the connection handlers close over is hoisted ABOVE connect() and seeded to a
  // pre-start value, for the SAME TDZ reason the rest of the family hoists its mirror: a coalesced ws
  // chunk can deliver `start` and the first `turn` in ONE macrotask, firing onTurn synchronously
  // inside connect()'s message handler BEFORE this function's `await` continuation runs. A `let`
  // declared AFTER the await would be in the temporal dead zone for that window — a bare
  // ReferenceError from a raw event-loop callback (uncaught, since exit guards aren't installed yet),
  // not a rejected promise this try/catch could see. Nothing here touches the not-yet-seeded mirror.
  const pendingShots: ShotBcast[] = [] // echoes awaiting replay (played one anim at a time)
  let turnWho: 0 | 1 | -1 = -1 // whose turn, per the latest TurnMsg
  let turnDeadlineMs = 0 // the latest TurnMsg's countdown duration
  let turnReceivedAt = 0 // Date.now() at that TurnMsg's receipt (countdown anchor)

  let connected: Awaited<ReturnType<typeof TankNetClient.connect>>
  try {
    connected = await TankNetClient.connect(opts.server, joined.matchId, joined.token, name, {
      onShot(msg) {
        pendingShots.push(msg)
      },
      onTurn(msg) {
        turnWho = msg.who
        turnDeadlineMs = msg.deadlineMs
        turnReceivedAt = Date.now()
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
  const youId = start.you
  // Seed the mirror deterministically from the SAME inputs the server used — identical seed/names/
  // bots ⇒ an identical tick-0 board, the substrate every replayed shot is applied to.
  let state = createMatch(start.seed, start.names, start.bots)
  // Cheap tripwire on the wire's redundant firstTurn field: createMatch is deterministic, so a
  // disagreement means the server and client disagree on the seed's meaning — a desync before a
  // single shot. Fold it into the same fatal path an echo mismatch takes.
  let desyncReason: string | null = state.firstTurn === start.firstTurn ? null : 'firstTurn mismatch'

  // Aim persists between turns, pre-loaded from your last shot (matches the server's expiry rule —
  // resolveShot stamps lastAngle/lastPower).
  let aim: Shot = { angle: state.tanks[youId]!.lastAngle, power: state.tanks[youId]!.lastPower }
  // Initial phase: whoever the (possibly already-coalesced) first turn belongs to; fall back to the
  // StartMsg's firstTurn if the turn notice has not landed yet.
  const initialTurn = turnWho === -1 ? start.firstTurn : turnWho
  let phase: Phase = initialTurn === youId ? 'aim' : 'wait'
  let playback: Playback | null = null
  let seq = 0 // strictly-monotonic client shot seq

  const session = await setupGame()

  // The share card reports YOUR stats, captured every anim-settle WHILE ALIVE so a lost game reports
  // its real pre-death numbers rather than the frozen post-death state (the family's b985dc8 rule).
  let lastRounds = state.round
  let lastDamageDealt = state.tanks[youId]!.damageDealt

  const clockMsLeft = (): number | null => {
    if (phase !== 'aim' || turnWho !== youId || turnReceivedAt === 0) return null
    return Math.max(0, turnDeadlineMs - (Date.now() - turnReceivedAt))
  }

  const redraw = (): void => {
    const layout = session.layout()
    if (layout === null) {
      const cols = process.stdout.columns ?? 80
      const rows = process.stdout.rows ?? 24
      session.term.write(tooSmallScreen(cols, rows))
      return
    }
    const pv =
      phase === 'anim' && playback
        ? playbackView(playback)
        : { shell: null, trail: [] as [number, number][], explosion: null }
    const view: RenderView = {
      state,
      you: youId,
      aim,
      phase,
      shell: pv.shell,
      trail: pv.trail,
      explosion: pv.explosion,
      clockMsLeft: clockMsLeft(),
      statusLine: session.statusLine(),
    }
    session.term.write(renderFrame(view, layout, session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  // Quit-confirm during an online match sends nothing special: closing the socket IS the forfeit
  // (the server's grace window covers an accidental drop).
  session.term.installExitGuards(() => net.close())
  redraw()

  if (!desyncReason) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (desyncReason) {
          clearInterval(timer)
          resolve()
          return
        }

        // 1. Consume the next echo when idle (in aim OR wait — a queued shot always eventually
        //    plays, never blocked on the phase). This is the ONLY path that mutates `state`.
        if (phase !== 'anim' && pendingShots.length > 0) {
          const msg = pendingShots.shift()!
          const { out, desync } = applyShotBcast(state, msg)
          if (desync) {
            desyncReason = `shot #${msg.seq} from slot ${msg.by}`
            clearInterval(timer)
            resolve()
            return
          }
          playback = createPlayback(out)
          phase = 'anim'
        }

        // 2. Your aim phase: fold this tick's keys; a fire key SENDS the shot (no local resolve —
        //    the board waits for the echo) and drops to wait. Off-turn keys are drained and ignored.
        if (phase === 'aim') {
          let fire = false
          for (const key of session.drainInput()) {
            if (isFireKey(key)) fire = true
            else aim = applyKey(aim, key)
          }
          if (fire) {
            net.sendShot({ t: 'shot', seq: seq++, angle: aim.angle, power: aim.power })
            phase = 'wait' // awaiting our own echo; the local board is untouched until it lands
          }
        } else {
          session.drainInput() // off-turn / mid-anim: discard so keys do not pile up
        }

        // (anim advance happens AFTER redraw so frame 0 — the muzzle — is shown.)
        redraw()

        if (phase === 'anim' && playback) {
          playback = advancePlayback(playback)
          if (playback.done) {
            state = playback.out.state // adopt the replayed post-shot state
            playback = null
            if (state.tanks[youId]!.alive) {
              lastRounds = state.round
              lastDamageDealt = state.tanks[youId]!.damageDealt
            }
            if (!state.result) {
              if (turnWho === youId) {
                phase = 'aim'
                aim = { angle: state.tanks[youId]!.lastAngle, power: state.tanks[youId]!.lastPower }
              } else {
                phase = 'wait'
              }
            }
          }
        }

        // Exit gate. A user quit leaves immediately. Otherwise, once the match is over —
        // `end`/close arrived, or the last replayed shot stamped a result — we MUST keep ticking
        // until every echoed shot has been drained AND its playback has finished. The server sends
        // the killing `shot` bcast together with `end`, so a bare `ended`-triggered exit would drop
        // that final shot unplayed: no final explosion, a stale pre-shot finale board, share stats
        // missing the final blow, and the desync tripwire never checking the last shot. Draining
        // guarantees the final shot goes through applyShotBcast (hash check) and its anim completes
        // so `state` adopts the final result. NB: a killing shot leaves `phase` stuck at 'anim'
        // (phase is only re-set when !state.result), so `playback === null` — not `phase` — is the
        // "no active playback" signal.
        const matchOver = ended !== null || closedEarly || state.result !== null
        const drained = pendingShots.length === 0 && playback === null
        if (session.quitRequested() || (matchOver && drained)) {
          clearInterval(timer)
          resolve()
        }
      }, REDRAW_MS)
    })
  }

  session.dispose()
  if (session.quitRequested()) net.close()

  const oppHandle = start.names[youId === 0 ? 1 : 0] ?? 'opponent'

  // Fatal desync: never a share card, always a nonzero exit and a stderr note. The two boards
  // provably diverged; continuing would show the player a fiction.
  if (desyncReason) {
    return teardownAndExit({
      term: session.term,
      parser: session.parser,
      listener: session.listener,
      beforeRestore: () => net.close(),
      finale: null,
      errorText: `tankwait: desync detected (${desyncReason}) — disconnected`,
      exitCode: 1,
    })
  }

  // Result precedence: an explicit `end` wins; else the last replayed shot's own stamped result
  // (a killing blow the server may not have followed with a formal `end` yet); else, if NEITHER
  // arrived but the socket still closed (abnormal disconnect pre-finish), synthesize a loss to the
  // OTHER player — a dropped connection is the one thing we know did not end in our own win. A
  // player-initiated quit shows no finale at all (matches offline's mid-match quit), excluded first.
  const finalResult: Result | null = session.quitRequested()
    ? null
    : (ended ?? state.result ?? (closedEarly ? { kind: 'win', winner: youId === 0 ? 1 : 0 } : null))

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
            const view: RenderView = {
              state,
              you: youId,
              aim,
              phase: 'aim',
              shell: null,
              trail: [],
              explosion: null,
              clockMsLeft: null,
              statusLine: line,
            }
            return layout
              ? renderFrame(view, layout, session.colorMode)
              : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${line}`
          })(),
          shareText: shareCard(finalResult, youId, lastRounds, lastDamageDealt, oppHandle),
        }
      : null,
  })
}
