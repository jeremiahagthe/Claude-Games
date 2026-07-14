// Offline game loop: 20Hz local sim, all 3 opponents synchronous bots.
// drain latch → your Input, botDecide → the other 3, step, renderFrame —
// mirrors packages/bomber-client/src/offline.ts's shape (thin wrapper over
// the shared session glue in game.ts): offline.ts and online.ts (next task)
// each own their tick loop BODY (local synchronous step vs. server relay),
// sharing only session setup/teardown (game.ts).
import type { Difficulty, Result } from 'snakewait-core'
import { botDecide, createBotMind, createMatch, step } from 'snakewait-core'
import { renderFrame, tooSmallScreen } from './render.js'
import { resultLine, setupGame, teardownAndExit, REDRAW_MS } from './game.js'
import { shareCard } from './share.js'

const YOU = 0
const BOT_NAMES = ['bot·1', 'bot·2', 'bot·3']

export async function runOffline(opts: { difficulty: Difficulty; name: string; seed: number }): Promise<Result> {
  const session = await setupGame()
  const seed = opts.seed >>> 0

  let state = createMatch(seed, [opts.name, ...BOT_NAMES], [false, true, true, true])
  // Deterministic per-bot minds, seeded off the match seed (never wall-clock —
  // the same seed always reproduces the same match, bots included).
  const minds = [1, 2, 3].map((id) => createBotMind((seed + id) >>> 0))

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
      // A quiet tick (no dir key since the last drain) passes {dir: null},
      // which step()'s movement phase reads as "keep whatever pendingDir is
      // already buffered" — snake never stops, so there is no absent-input
      // distinction to preserve here (unlike bomber's tap-to-step latch).
      const yourInput = session.drainInput()
      const inputs = [
        yourInput,
        botDecide(state, 1, minds[0]!, opts.difficulty),
        botDecide(state, 2, minds[1]!, opts.difficulty),
        botDecide(state, 3, minds[2]!, opts.difficulty),
      ]
      state = step(state, inputs)
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
          // still ended and the share card is still worth showing — fall
          // back to the too-small message rather than losing the finale.
          screen: layout
            ? renderFrame(state, YOU, layout, `${resultLine(state.result, YOU)} — press any key`, session.colorMode)
            : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${resultLine(state.result, YOU)} — press any key`,
          shareText: shareCard(state.result, YOU, state.tick, state.snakes[YOU]!.cells.length, `bot·${opts.difficulty}`),
        }
      : null,
  })
}
