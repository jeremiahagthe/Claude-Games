// Offline artillery duel: YOU (id 0) vs ONE synchronous bot (id 1), driven by a
// PHASE MACHINE on a 50ms interval (block/snake ran a tick reducer; a turn-based
// duel runs aim → anim → wait → anim… instead). Shares session setup/teardown
// with online.ts (game.ts); owns its own loop body here.
//
//   aim  — YOUR turn: fold this tick's keys through applyKey; a fire key OR the
//          20s local shot clock expiring resolves the shot → anim.
//   anim — advancePlayback per frame; done → adopt out.state, pick the next phase.
//   wait — the bot's turn: after a seeded ~1.5s think, botDecide → resolveShot →
//          botObserve (record the outcome for the bot's next bracket) → anim.
//
// Your aim persists between turns, pre-loaded from your tank's lastAngle/
// lastPower (matching the server's expiry rule — resolveShot stamps those). The
// share card reports YOUR stats, tracked WHILE ALIVE (never post-death state).
import type { Result, Shot } from 'tankwait-core'
import {
  botDecide,
  botObserve,
  createBotMind,
  createMatch,
  resolveShot,
  SHOT_CLOCK_MS,
} from 'tankwait-core'
import type { Difficulty } from 'tankwait-core'
import { renderFrame, tooSmallScreen } from './render.js'
import type { RenderView } from './render.js'
import { advancePlayback, createPlayback, playbackView, type Playback } from './anim.js'
import { applyKey, isFireKey, REDRAW_MS, resultLine, setupGame, teardownAndExit } from './game.js'
import { shareCard } from './share.js'

const YOU = 0
const BOT = 1
// The offline bot's fixed skill (there is no --difficulty flag; the family
// defaults to easy, feel-gated as the friendliest bracket).
const DIFFICULTY: Difficulty = 'easy'
const OPP_HANDLE = 'bot'
const BOT_THINK_MS = 1500

type Phase = 'aim' | 'anim' | 'wait'

export async function runOffline(opts: { name: string; seed: number }): Promise<Result> {
  const session = await setupGame()
  const seed = opts.seed >>> 0

  let state = createMatch(seed, [opts.name, OPP_HANDLE], [false, true])
  // Deterministic bot mind, seeded off the match seed (never wall-clock — the
  // same seed always reproduces the same match, bot included).
  let botMind = createBotMind((seed + 1) >>> 0)

  // Aim persists between turns, pre-loaded from your last shot.
  let aim: Shot = { angle: state.tanks[YOU]!.lastAngle, power: state.tanks[YOU]!.lastPower }

  let phase: Phase = state.turn === YOU ? 'aim' : 'wait'
  let playback: Playback | null = null
  let clockDeadline = performance.now() + SHOT_CLOCK_MS // valid during aim
  let waitDeadline = performance.now() + BOT_THINK_MS // valid during wait

  // Share-card stats, captured every tick WHILE ALIVE so a lost game reports its
  // real pre-death numbers (never the frozen post-death state).
  let lastRounds = state.round
  let lastDamageDealt = state.tanks[YOU]!.damageDealt

  const enterAim = (): void => {
    phase = 'aim'
    aim = { angle: state.tanks[YOU]!.lastAngle, power: state.tanks[YOU]!.lastPower }
    clockDeadline = performance.now() + SHOT_CLOCK_MS
  }
  const enterWait = (): void => {
    phase = 'wait'
    waitDeadline = performance.now() + BOT_THINK_MS
  }
  const beginAnim = (shot: Shot, byBot: boolean): void => {
    const out = resolveShot(state, shot)
    if (byBot) botMind = botObserve(botMind, shot, out.impact ? out.impact.x : null)
    playback = createPlayback(out)
    phase = 'anim'
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
      you: YOU,
      aim,
      phase,
      shell: pv.shell,
      trail: pv.trail,
      explosion: pv.explosion,
      clockMsLeft: phase === 'aim' ? Math.max(0, clockDeadline - performance.now()) : null,
      statusLine: session.statusLine(),
    }
    session.term.write(renderFrame(view, layout, session.colorMode))
  }
  session.onResize(redraw)

  session.term.enter()
  session.term.installExitGuards(() => {
    /* no extra resources to release offline */
  })
  redraw()

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = performance.now()
      const keys = session.drainInput()

      if (phase === 'aim') {
        let fire = false
        for (const key of keys) {
          if (isFireKey(key)) fire = true
          else aim = applyKey(aim, key)
        }
        if (fire || now >= clockDeadline) beginAnim(aim, false)
      } else if (phase === 'wait') {
        if (now >= waitDeadline) {
          const decided = botDecide(state, BOT, botMind, DIFFICULTY)
          botMind = decided.mind
          beginAnim(decided.shot, true)
        }
      }
      // (anim advance happens AFTER redraw so frame 0 — the muzzle — is shown.)

      redraw()

      if (phase === 'anim' && playback) {
        playback = advancePlayback(playback)
        if (playback.done) {
          state = playback.out.state
          playback = null
          if (state.tanks[YOU]!.alive) {
            lastRounds = state.round
            lastDamageDealt = state.tanks[YOU]!.damageDealt
          }
          if (!state.result) {
            if (state.turn === YOU) enterAim()
            else enterWait()
          }
        }
      }

      if (session.quitRequested() || state.result) {
        clearInterval(timer)
        resolve()
      }
    }, REDRAW_MS)
  })

  session.dispose()

  const layout = session.layout()
  const resultMsg = state.result ? `${resultLine(state.result, YOU)} — press any key` : ''
  const finaleView: RenderView = {
    state,
    you: YOU,
    aim,
    phase: 'aim',
    shell: null,
    trail: [],
    explosion: null,
    clockMsLeft: null,
    statusLine: resultMsg,
  }
  return teardownAndExit({
    term: session.term,
    parser: session.parser,
    listener: session.listener,
    finale: state.result
      ? {
          // Below 80x24 there's no frame to draw, but the match still ended and
          // the share card is still worth showing — fall back to the too-small
          // message rather than losing the finale.
          screen: layout
            ? renderFrame(finaleView, layout, session.colorMode)
            : `${tooSmallScreen(process.stdout.columns ?? 80, process.stdout.rows ?? 24)}\n${resultMsg}`,
          shareText: shareCard(state.result, YOU, lastRounds, lastDamageDealt, OPP_HANDLE),
        }
      : null,
  })
}
