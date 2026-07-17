// game.ts — shared loop glue: terminal/session setup, raw-input → key-batch
// wiring, quit-confirm (q/Esc arm+confirm, Ctrl-C instant), the Claude status
// banner, resize handling (full clear + relayout + redraw — the chess-4 residue
// lesson), and the shared finished-match teardown tail. offline.ts (this task)
// and online.ts (Task 9) each drive their own phase-machine loop BODY
// (synchronous bot decisions vs. server relay) but share everything here —
// transcribed from block-client's game.ts, with block's tetromino event QUEUE
// swapped for a raw KEY batch: drainInput() returns this tick's ordered
// lowercased key names, which offline.ts folds through applyKey (below).
// teardownAndExit's contract is unchanged (finale screen → waitForPress → close
// listener → restore → share card on the NORMAL screen).
import type { Result, Shot } from 'tankwait-core'
import { ANGLE_MAX, ANGLE_MIN, POWER_MAX, POWER_MIN } from 'tankwait-core'
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

// The offline loop's phase machine steps at 20Hz (a real wall-clock interval —
// the no-Date.now rule binds core, not this client I/O shell). 3 trajectory
// steps per 50ms frame is the client-side twin of the server's ANIM allowance.
export const REDRAW_MS = 50

// --- aim input reducer -------------------------------------------------------
// Pure aim reducer. left/right angle ∓/± 1 · a/d angle ∓/± 5 · up/down power ±
// 1 · w/s power ± 5, all clamped. OS key auto-repeat delivers hold-to-sweep as
// repeated keys (every press AND repeat is one discrete step). Fire (space /
// enter) is NOT an aim mutation — the loop checks isFireKey separately, so
// applyKey leaves the aim unchanged for it and any other unmapped key.
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

const ANGLE_KEYS: Record<string, number> = { left: -1, right: 1, a: -5, d: 5 }
const POWER_KEYS: Record<string, number> = { up: 1, down: -1, w: 5, s: -5 }

export function applyKey(aim: Shot, key: string): Shot {
  const k = key.toLowerCase()
  if (k in ANGLE_KEYS) return { angle: clamp(aim.angle + ANGLE_KEYS[k]!, ANGLE_MIN, ANGLE_MAX), power: aim.power }
  if (k in POWER_KEYS) return { angle: aim.angle, power: clamp(aim.power + POWER_KEYS[k]!, POWER_MIN, POWER_MAX) }
  return aim
}

export function isFireKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === ' ' || k === 'space' || k === 'enter'
}

export interface GameSession {
  term: TerminalSession
  parser: KeyParser
  colorMode: ColorMode
  listener: ClaudeListener
  // null below tankwait's 80x24 minimum fit — caller renders tooSmallScreen
  // instead of a frame and keeps polling for a resize back above it.
  layout(): Layout | null
  // Pulls this tick's ordered key batch (lowercased names; press + repeat, no
  // release) and empties the buffer.
  drainInput(): string[]
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

  let keys: string[] = []
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
      if ('type' in e) continue // tankwait has no mouse input
      // Quit-intent keys only act on a genuine press — never a repeat/release —
      // so holding q/esc can't fast-forward past the confirm window (a single
      // keystroke, held or tapped, must never instantly quit).
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
      // Off-turn keys are ignored by the loop (it only folds them through
      // applyKey during your aim phase); esc is already handled above.
      if (e.kind === 'release') continue
      keys.push(e.key.toLowerCase())
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
      const out = keys
      keys = []
      return out
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
// `names` is optional: offline.ts never passes it (its single opponent is the
// bot, labelled from the winner's id); online.ts passes the server's names so a
// real human winner keeps their handle rather than a bot·<id> fallback.
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
    // the release of a key held when the match ended.
    await waitForPress(process.stdin, o.parser)
  }
  await o.listener.close()
  o.beforeRestore?.()
  o.term.restore()
  if (o.finale) process.stdout.write('\n' + o.finale.shareText)
  process.exit(0)
}
