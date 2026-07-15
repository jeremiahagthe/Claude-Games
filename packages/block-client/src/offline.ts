// Offline game loop: 20Hz local sim, YOU (id 0) vs ONE synchronous bot (id 1).
// drain queue → your ordered events, botDecide → the bot's events, step, render
// — mirrors snakewait's offline.ts shape (thin wrapper over the shared session
// glue in game.ts): offline.ts and online.ts (Task 10) each own their tick loop
// BODY (local synchronous step vs. server relay), sharing only session
// setup/teardown (game.ts). Differences from snake's four-snake loop: blockwait
// is strictly 1v1, botDecide THREADS its mind (returns a fresh mind each tick
// that must be fed back in), and step() takes the two players' event batches.
import type { Difficulty, Result } from 'blockwait-core'
import { botDecide, createBotMind, createMatch, step } from 'blockwait-core'
import { renderFrame, tooSmallScreen } from './render.js'
import { resultLine, setupGame, teardownAndExit, REDRAW_MS } from './game.js'
import { shareCard } from './share.js'

const YOU = 0
const BOT = 1

export async function runOffline(opts: { difficulty: Difficulty; name: string; seed: number }): Promise<Result> {
  const session = await setupGame()
  const seed = opts.seed >>> 0
  const oppHandle = `bot·${opts.difficulty}`

  let state = createMatch(seed, [opts.name, oppHandle], [false, true])
  // Deterministic bot mind, seeded off the match seed (never wall-clock — the
  // same seed always reproduces the same match, bot included). One normal bot
  // for the offline duel; its skill is set by opts.difficulty in botDecide.
  let botMind = createBotMind((seed + 1) >>> 0)

  // The share card reports YOUR stats. A dead player's state is FROZEN by
  // stepPlayer (not cleared, unlike snake) — but per the b985dc8 lesson we
  // never read post-death state for the card: track your own tick/lines/sent
  // here every tick WHILE ALIVE, and hand THOSE to shareCard so a lost game
  // reports its real pre-death numbers.
  let lastTick = state.players[YOU]!.tick
  let lastLines = state.players[YOU]!.linesCleared
  let lastSent = state.players[YOU]!.linesSent

  const redraw = (): void => {
    const layout = session.layout()
    if (layout === null) {
      const cols = process.stdout.columns ?? 80
      const rows = process.stdout.rows ?? 24
      session.term.write(tooSmallScreen(cols, rows))
      return
    }
    session.term.write(renderFrame(state, YOU, layout, session.statusLine(), session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  session.term.installExitGuards(() => {
    /* no extra resources to release offline */
  })
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const yourEvents = session.drainInput()
      const decided = botDecide(state.players[BOT]!, botMind, opts.difficulty)
      botMind = decided.mind
      state = step(state, [yourEvents, decided.events])
      if (state.players[YOU]!.alive) {
        lastTick = state.players[YOU]!.tick
        lastLines = state.players[YOU]!.linesCleared
        lastSent = state.players[YOU]!.linesSent
      }
      redraw()
      if (session.quitRequested() || state.result) {
        clearInterval(timer)
        resolve()
      }
    }, REDRAW_MS)
  })

  session.dispose()

  const layout = session.layout()
  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    finale: state.result
      ? {
          // Below the 80x24 minimum there's no frame to draw, but the match
          // still ended and the share card is still worth showing — fall back
          // to the too-small message rather than losing the finale.
          screen: layout
            ? renderFrame(state, YOU, layout, `${resultLine(state.result, YOU)} — press any key`, session.colorMode)
            : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${resultLine(state.result, YOU)} — press any key`,
          shareText: shareCard(state.result, YOU, lastTick, lastLines, lastSent, oppHandle),
        }
      : null,
  })
}
