// Offline game loop: 20Hz local sim, all 3 opponents synchronous bots.
// drain latch → your Input, botDecide → the other 3, step, renderFrame —
// mirrors packages/chess-client/src/offline.ts's shape (thin wrapper over
// the shared session glue in game.ts), except bomber's loop body lives here
// directly rather than inside a shared runGame: bomber's "how a tick is
// applied" (local synchronous step vs. Task 11's server relay) IS the loop
// body, so offline.ts and online.ts each own their own interval, sharing
// only session setup/teardown (game.ts).
import type { Difficulty, Result } from 'boomwait-core'
import { botDecide, createBotMind, createMatch, step } from 'boomwait-core'
import { renderFrame } from './render.js'
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
    session.term.write(renderFrame(state, YOU, session.layout(), session.statusLine(), session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  session.term.installExitGuards(() => {
    /* no extra resources to release offline */
  })
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
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

  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    finale: state.result
      ? {
          screen: renderFrame(
            state,
            YOU,
            session.layout(),
            `${resultLine(state.result, YOU)} — press any key`,
            session.colorMode,
          ),
          shareText: shareCard(state.result, YOU, state.tick, `bot·${opts.difficulty}`),
        }
      : null,
  })
}
