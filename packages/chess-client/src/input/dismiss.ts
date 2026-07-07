// copied from packages/client/src/input/dismiss.ts (fragwait) — 2026-07-07
import type { KeyParser } from './parser.js'

// Resolves on the first REAL key press or mouse BUTTON press (M1 fix).
//
// The final scoreboard's "press any key" must not be dismissed by stdin noise:
// the terminal is still in any-motion mouse tracking (?1003h), focus reporting
// (?1004h), and kitty keyboard mode at that point, so raw-data waiting fired on
// mouse motion, cmd-tab focus changes, and the release of whatever key the
// player was holding when the match ended. Feeding the session's own KeyParser
// (split-chunk safe, shares any buffered partial sequence) lets us dismiss only
// on deliberate input: a key press or a mouse click.
export function waitForPress(stdin: NodeJS.ReadStream, parser: KeyParser): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stdin.off('data', onData)
      resolve()
    }
    const onData = (chunk: Buffer): void => {
      for (const e of parser.feed(chunk)) {
        if ('type' in e) {
          // mouse: only a real button press counts — motion and releases don't
          if (e.button !== 'none' && e.action === 'press') return done()
          continue
        }
        if (e.kind !== 'press') continue // key releases/repeats never dismiss
        // synthetic parser events are not keys
        if (e.key === 'kitty-ack' || e.key === 'focus-in' || e.key === 'focus-out') continue
        return done()
      }
    }
    stdin.on('data', onData)
  })
}
