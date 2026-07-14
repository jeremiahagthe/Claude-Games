// Online flow: POST /snake/join → always a room (bots backfill, never a noOpponent-style
// outcome) → ws connect → StartMsg seeds the local mirror via the SAME deterministic
// createMatch() offline.ts uses (identical seed/names/bots => identical tick-0 board) → every
// SnapMsg thereafter REPLACES the rendered state outright (fromWire — this client never calls
// step() itself, the server is the only simulation) → EndMsg → result screen → share card.
// Reuses game.ts's session glue (setupGame/teardownAndExit) exactly like offline.ts; the only
// thing genuinely different between the two loops is how a tick's Input becomes state: a
// synchronous local step() there, a minimal-diff InputMsg to the server here. Transcribed from
// packages/bomber-client/src/online.ts, including its hard-won TDZ-avoidance and result-
// precedence specifics (see the inline comments below, kept verbatim where they still apply).
import type { Dir, MatchState, Result } from 'snakewait-core'
import { createMatch, fromWire, MAX_PLAYERS, sanitizeHandle } from 'snakewait-core'
import { hostname } from 'node:os'
import { renderFrame, tooSmallScreen } from './render.js'
import { REDRAW_MS, resultLine, setupGame, teardownAndExit } from './game.js'
import { diffInputForWire, joinSnakeMatch, SnakeNetClient } from './net.js'
import { shareCard } from './share.js'

export interface OnlineOpts {
  name?: string
  server: string
}

export async function runOnline(opts: OnlineOpts): Promise<Result | 'fallback'> {
  const name = sanitizeHandle(opts.name ?? hostname())

  const joined = await joinSnakeMatch(opts.server, name)
  if (joined.kind !== 'joined') return 'fallback'

  let ended: Result | null = null
  let closedEarly = false // ws closed after start with no `end` ever arriving (dropped/kicked)

  // Hoisted above the connect() call and seeded null: onSnap below closes over `state`, and a
  // coalesced ws chunk can deliver `start` and the first `snap` in ONE macrotask, back to back
  // — the 'start' message resolves connect()'s internal promise, but that resolution's
  // continuation (back in this function, past the `await`) only runs on the NEXT microtask
  // turn, so a `snap` arriving synchronously right after it is still handled by onSnap while
  // this function is suspended mid-`await`. A `let state = ...` declared AFTER the `await`
  // leaves `state` in the temporal dead zone for that window — accessing it throws a bare
  // ReferenceError from inside a raw event-loop callback (an uncaught exception, since exit
  // guards aren't installed yet), not a rejected promise this function's own try/catch can
  // see. Declaring it here means onSnap always has a variable to assign into.
  let state: MatchState | null = null

  // Hoisted for the same TDZ reason as `state` above: onSnap closes over both `you` and
  // `lastLength` (Findings 2 & 3 — see below), and a coalesced start+snap chunk can reach
  // onSnap before this function's own `await` continuation has assigned them. `you` starts at
  // -1 (never a valid player id) so a pre-seed race snap's `.find` simply misses rather than
  // matching the wrong slot; `lastLength` starts at 0 as the only honest value before any
  // snap/mirror has told us anything about the player's snake.
  let you = -1
  let lastLength = 0

  let connected: Awaited<ReturnType<typeof SnakeNetClient.connect>>
  try {
    connected = await SnakeNetClient.connect(opts.server, joined.matchId, joined.token, name, {
      onSnap(wire) {
        state = fromWire(wire)
        // Finding 2: the sim clears a dead snake's `cells` to `[]`, and by the final snap of a
        // loss YOU are always dead (or, per Finding 3, possibly entirely absent from a
        // short/hostile snakes array) — track the last-known-alive length here, on every snap,
        // instead of reading it off the (possibly already-cleared) final state.
        // Finding 3: look the snake up BY ID, not by array position — the wire validator admits
        // `snakes.length` 0..4 with no id/slot guarantee, so `wire.snakes[you]` can be undefined
        // on a hostile or buggy server's snap.
        const mySnake = state.snakes.find((s) => s.id === you)
        if (mySnake && mySnake.alive) lastLength = mySnake.cells.length
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
  you = start.you
  // Seeds the local mirror deterministically from the SAME inputs the server used to create
  // its own tick-0 state — this is what's on screen for the handful of ticks before the
  // first `snap` arrives; every `snap` after that overwrites it outright. Also the point past
  // which `state` is guaranteed non-null: any pre-seed `snap` (the race above) already landed
  // in the `state` variable via onSnap, and this unconditionally overwrites it with the
  // server's own tick-0 board either way — same precedence a `snap` always has over the local
  // mirror.
  state = createMatch(start.seed, start.names, start.bots)
  {
    const mySnake = state.snakes.find((s) => s.id === you)
    if (mySnake && mySnake.alive) lastLength = mySnake.cells.length
  }

  const session = await setupGame()
  let lastSentDir: Dir | null = null

  const redraw = (): void => {
    const layout = session.layout()
    if (layout === null) {
      const cols = process.stdout.columns ?? 80
      const rows = process.stdout.rows ?? 24
      session.term.write(tooSmallScreen(cols, rows))
      return
    }
    session.term.write(renderFrame(state!, you, layout, session.statusLine(), session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  // Quit-confirm during an online match sends nothing special: closing the socket IS
  // elimination (the server's grace window covers an accidental drop).
  session.term.installExitGuards(() => net.close())
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const input = session.drainInput()
      const { msg, nextDir } = diffInputForWire(lastSentDir, input)
      if (msg) {
        net.sendInput(msg)
        lastSentDir = nextDir
      }
      redraw()
      if (session.quitRequested() || ended !== null || closedEarly || state!.result) {
        clearInterval(timer)
        resolve()
      }
    }, REDRAW_MS)
  })

  session.dispose()
  if (session.quitRequested()) net.close()

  // Result precedence: an explicit `end` message wins; otherwise the last snap's own baked-in
  // result (the server always stamps the final snap's WireState.result before sending `end`);
  // if NEITHER ever arrived but the socket still closed (an abnormal disconnect pre-finish),
  // synthesize "not you" won so the finale still reads correctly (resultLine only ever
  // distinguishes winner === you from everyone else) — a dropped connection is the one thing we
  // know for certain didn't end in our own win, even though the actual survivor is unknowable
  // from here. A player-initiated quit never shows a finale at all (matches offline.ts's
  // mid-match-quit behavior), so it's excluded first.
  const finalResult: Result | null = session.quitRequested()
    ? null
    : (ended ?? state!.result ?? (closedEarly ? { kind: 'win', winner: (you + 1) % MAX_PLAYERS } : null))

  if (finalResult) state = { ...state!, result: finalResult }

  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    beforeRestore: () => net.close(),
    finale: finalResult
      ? {
          screen: (() => {
            const layout = session.layout()
            // resultLine.ts:names carry-item — pass the real StartMsg names so an online
            // winner is labeled by their actual handle rather than offline's bot·<id> fallback.
            const line = `${resultLine(finalResult, you, start.names)} — press any key`
            return layout
              ? renderFrame(state!, you, layout, line, session.colorMode)
              : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${line}`
          })(),
          shareText: shareCard(
            finalResult,
            you,
            state!.tick,
            lastLength,
            start.names.filter((_, i) => i !== you).join(', '),
          ),
        }
      : null,
  })
}
