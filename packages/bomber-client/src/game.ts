// game.ts — shared loop glue: terminal/session setup, raw-input → latch
// wiring, quit-confirm (q/Esc arm+confirm, Ctrl-C instant), the Claude status
// banner, resize handling (full clear + relayout + redraw — the chess-4
// residue lesson), and the shared finished-match teardown tail. offline.ts
// (Task 10) and online.ts (Task 11) each drive their own tick loop BODY
// (synchronous bot decisions vs. server relay) but share everything here —
// mirrors packages/chess-client/src/game.ts's split with online.ts, right
// down to teardownAndExit's contract (finale screen → waitForPress → close
// listener → restore → share card on the NORMAL screen).
import type { Input, Result } from 'boomwait-core'
import { TICK_RATE } from 'boomwait-core'
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
import { createLatch, drain, onKey, type LatchState } from './input-latch.js'

// The sim steps at TICK_RATE (20Hz); the client loop runs in lockstep with
// it (real wall-clock interval — the no-Date.now rule binds core, not this
// client I/O shell, same as fragwait/checkwait's loops).
export const REDRAW_MS = 1000 / TICK_RATE

export interface GameSession {
  term: TerminalSession
  parser: KeyParser
  colorMode: ColorMode
  listener: ClaudeListener
  layout(): Layout
  // Pulls this tick's Input off the latch (bomb one-shot, dir persists).
  drainInput(): Input
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

  let latch: LatchState = createLatch()
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
      if ('type' in e) continue // bomber has no mouse input
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
      latch = onKey(latch, e)
    }
  }
  process.stdin.on('data', onData)

  const onResize = (): void => {
    cols = process.stdout.columns ?? 80
    rows = process.stdout.rows ?? 24
    // Full clear before the next frame: redraw alone only overwrites the new
    // frame's footprint, leaving old-frame residue when the terminal grew or
    // the layout's r/sideHud/glyph choice changed shape (chess-4 lesson).
    term.write('\x1b[2J')
    resizeCb?.()
  }
  process.stdout.on('resize', onResize)

  return {
    term,
    parser,
    colorMode,
    listener,
    layout: () => chooseLayout(cols, rows, colorMode),
    drainInput: () => {
      const { input, next } = drain(latch)
      latch = next
      return input
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

// Exported for online.ts (Task 11) — same win/loss/draw phrasing offline and
// online.
export function resultLine(result: Result, you: number): string {
  if (result.kind === 'draw') return 'draw — no one survived'
  return result.winner === you ? 'you won!' : 'you lost'
}

// Shared tail for both loops: finished screen (if the match ended, not on a
// mid-match quit) → waitForPress → Claude-listener close → caller cleanup →
// terminal restore → share card on the NORMAL screen (post-restore, so it
// lands in scrollback ready to copy into a post) → exit. Never actually
// returns (process.exit on every path) — callers declared to return
// Promise<Result> can `return await teardownAndExit(...)` since `never` is
// assignable to any type.
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
