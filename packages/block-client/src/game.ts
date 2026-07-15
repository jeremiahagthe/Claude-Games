// game.ts — shared loop glue: terminal/session setup, raw-input → event-queue
// wiring, quit-confirm (q/Esc arm+confirm, Ctrl-C instant), the Claude status
// banner, resize handling (full clear + relayout + redraw — the chess-4
// residue lesson), and the shared finished-match teardown tail. offline.ts
// (this task) and online.ts (Task 10) each drive their own tick loop BODY
// (synchronous bot decisions vs. server relay) but share everything here —
// transcribed from snakewait's game.ts, with snake's one-shot dir LATCH swapped
// for blockwait's ordered event QUEUE: drainInput() returns this tick's ordered
// GameEvent[] (taps are discrete, order matters) instead of a single {dir}.
// teardownAndExit's contract is unchanged (finale screen → waitForPress → close
// listener → restore → share card on the NORMAL screen).
import type { GameEvent, Result } from 'blockwait-core'
import { TICK_RATE } from 'blockwait-core'
import {
  detectColorMode,
  KeyParser,
  QuitConfirm,
  startClaudeListener,
  TerminalSession,
  waitForPress,
} from 'termwait'
import type { ClaudeListener, ColorMode } from 'termwait'
import { chooseLayout, type Layout } from './render.js'
import { createQueue, drain, onKey, type QueueState } from './input-queue.js'

// The sim steps at TICK_RATE (20Hz); the client loop runs in lockstep with it
// (real wall-clock interval — the no-Date.now rule binds core, not this client
// I/O shell, same as snakewait/fragwait's loops).
export const REDRAW_MS = 1000 / TICK_RATE

export interface GameSession {
  term: TerminalSession
  parser: KeyParser
  colorMode: ColorMode
  listener: ClaudeListener
  // null below blockwait's 80x24 minimum fit — caller renders tooSmallScreen
  // instead of a frame and keeps polling for a resize back above it.
  layout(): Layout | null
  // Pulls this tick's ordered event batch off the queue (empties it).
  drainInput(): GameEvent[]
  // Quit-confirm hint takes priority over the Claude banner (matches chess).
  statusLine(): string
  quitRequested(): boolean
  // Fires after every resize's full-clear — caller re-renders into it.
  onResize(cb: () => void): void
  // Removes stdin/resize listeners. Call before teardownAndExit.
  dispose(): void
}

export async function setupGame(): Promise<GameSession> {
  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const quitConfirm = new QuitConfirm(() => performance.now())
  const colorMode = detectColorMode(process.env)

  let queue: QueueState = createQueue()
  let banner: string | null = null
  let quit = false
  let cols = process.stdout.columns ?? 80
  let rows = process.stdout.rows ?? 24
  let resizeCb: (() => void) | null = null

  const listener = await startClaudeListener()
  listener.onEvent((event) => {
    banner = event === 'done' ? '✔ Claude is done' : '⚠ Claude needs your input'
  })

  const onData = (chunk: Buffer): void => {
    for (const e of parser.feed(chunk)) {
      if ('type' in e) continue // blockwait has no mouse input
      // Quit-intent keys only act on a genuine press — never a repeat/release —
      // so holding q can't fast-forward past the confirm window (FEEL-12: a
      // single keystroke, held or tapped, must never instantly quit).
      if (e.kind === 'press') {
        const lower = e.key.toLowerCase()
        if (lower === 'ctrl-c') {
          quit = true
          continue
        }
        if (lower === 'q' || lower === 'esc') {
          quit = quitConfirm.request()
          continue
        }
      }
      queue = onKey(queue, e)
    }
  }
  process.stdin.on('data', onData)

  const onResize = (): void => {
    cols = process.stdout.columns ?? 80
    rows = process.stdout.rows ?? 24
    // Full clear before the next frame: redraw alone only overwrites the new
    // frame's footprint, leaving old-frame residue when the terminal grew or
    // the layout's HUD shape changed (chess-4 lesson).
    term.write('\x1b[2J')
    resizeCb?.()
  }
  process.stdout.on('resize', onResize)

  return {
    term,
    parser,
    colorMode,
    listener,
    layout: () => chooseLayout(cols, rows),
    drainInput: () => {
      const { events, next } = drain(queue)
      queue = next
      return events
    },
    statusLine: () => (quitConfirm.armed ? 'press again to quit' : banner ?? ''),
    quitRequested: () => quit,
    onResize: (cb) => {
      resizeCb = cb
    },
    dispose: () => {
      process.stdin.off('data', onData)
      process.stdout.off('resize', onResize)
    },
  }
}

// Exported for online.ts — same win/loss/draw phrasing offline and online.
// `names` is optional: offline.ts never passes it, since its single opponent is
// the bot and that label is derived from the winner's id. online.ts DOES pass
// the server's names (an online winner can be a real human with an actual
// handle, so falling back to the offline bot·<id> label there would mislabel
// them). When `names` is omitted the bot·<id> fallback is kept, preserving
// offline's behavior exactly.
export function resultLine(result: Result, you: number, names?: string[]): string {
  if (result.kind === 'draw') return 'draw'
  if (result.winner === you) return 'you won!'
  const label = names?.[result.winner] ?? `bot·${result.winner}`
  return `${label} won`
}

// Shared tail for both loops: finished screen (if the match ended, not on a
// mid-match quit) → waitForPress → Claude-listener close → caller cleanup →
// terminal restore → share card on the NORMAL screen (post-restore, so it lands
// in scrollback ready to copy into a post) → exit. Never actually returns
// (process.exit on every path) — callers declared to return Promise<Result> can
// `return await teardownAndExit(...)` since `never` is assignable to any type.
export async function teardownAndExit(o: {
  term: TerminalSession
  parser: KeyParser
  listener: { close(): Promise<void> }
  finale: { screen: string; shareText: string } | null // null = quit mid-match, nothing worth showing
  beforeRestore?: () => void
}): Promise<never> {
  if (o.finale) {
    o.term.write(o.finale.screen)
    // Only a real key press dismisses — never mouse motion, focus changes, or
    // the release of a key held when the match ended (M1 lesson).
    await waitForPress(process.stdin, o.parser)
  }
  await o.listener.close()
  o.beforeRestore?.()
  o.term.restore()
  if (o.finale) process.stdout.write('\n' + o.finale.shareText)
  process.exit(0)
}
