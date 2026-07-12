// Online flow: POST /bomber/join → always a room (bots backfill, never a noOpponent-style
// outcome) → ws connect → StartMsg seeds the local mirror via the SAME deterministic
// createMatch() offline.ts uses (identical seed/names/bots => identical tick-0 board) → every
// SnapMsg thereafter REPLACES the rendered state outright (fromWire — this client never calls
// step() itself, the server is the only simulation) → EndMsg → result screen → share card.
// Reuses game.ts's session glue (setupGame/teardownAndExit) exactly like offline.ts; the only
// thing genuinely different between the two loops is how a tick's Input becomes state: a
// synchronous local step() there, a minimal-diff InputMsg to the server here.
import type { Dir, Result } from 'boomwait-core'
import { createMatch, fromWire, MAX_PLAYERS, sanitizeHandle } from 'boomwait-core'
import { hostname } from 'node:os'
import { renderFrame } from './render.js'
import { REDRAW_MS, resultLine, setupGame, teardownAndExit } from './game.js'
import { diffInputForWire, joinBomberMatch, BomberNetClient } from './net.js'
import { shareCard } from './share.js'

export interface OnlineOpts {
  name?: string
  server: string
}

export async function runOnline(opts: OnlineOpts): Promise<Result | 'fallback'> {
  const name = sanitizeHandle(opts.name ?? hostname())

  const joined = await joinBomberMatch(opts.server, name)
  if (joined.kind !== 'joined') return 'fallback'

  let ended: Result | null = null
  let closedEarly = false // ws closed after start with no `end` ever arriving (dropped/kicked)

  let connected: Awaited<ReturnType<typeof BomberNetClient.connect>>
  try {
    connected = await BomberNetClient.connect(opts.server, joined.matchId, joined.token, name, {
      onSnap(wire) {
        state = fromWire(wire)
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
  const you = start.you
  // Seeds the local mirror deterministically from the SAME inputs the server used to create
  // its own tick-0 state — this is what's on screen for the handful of ticks before the
  // first `snap` arrives; every `snap` after that overwrites it outright.
  let state = createMatch(start.seed, start.names, start.bots)

  const session = await setupGame()
  let lastSentDir: Dir | null = null

  const redraw = (): void => {
    session.term.write(renderFrame(state, you, session.layout(), session.statusLine(), session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  // Quit-confirm during an online match sends nothing special: closing the socket IS
  // elimination (the server's GRACE_MS window in bomber-match.ts covers an accidental drop).
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
      if (session.quitRequested() || ended !== null || closedEarly || state.result) {
        clearInterval(timer)
        resolve()
      }
    }, REDRAW_MS)
  })

  session.dispose()
  if (session.quitRequested()) net.close()

  // Result precedence: an explicit `end` message wins; otherwise the last snap's own baked-in
  // result (the server always stamps the final snap's WireState.result before sending `end` —
  // see bomber-match.ts tick()); if NEITHER ever arrived but the socket still closed (an
  // abnormal disconnect pre-finish), synthesize "not you" won so the finale still reads
  // correctly (resultLine only ever distinguishes winner === you from everyone else) — a
  // dropped connection is the one thing we know for certain didn't end in our own win, even
  // though the actual survivor is unknowable from here. A player-initiated quit never shows a
  // finale at all (matches offline.ts's mid-match-quit behavior), so it's excluded first.
  const finalResult: Result | null = session.quitRequested()
    ? null
    : (ended ?? state.result ?? (closedEarly ? { kind: 'win', winner: (you + 1) % MAX_PLAYERS } : null))

  if (finalResult) state = { ...state, result: finalResult }

  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    beforeRestore: () => net.close(),
    finale: finalResult
      ? {
          screen: renderFrame(
            state,
            you,
            session.layout(),
            `${resultLine(finalResult, you)} — press any key`,
            session.colorMode,
          ),
          shareText: shareCard(finalResult, you, state.tick, start.names.filter((_, i) => i !== you).join(', ')),
        }
      : null,
  })
}
