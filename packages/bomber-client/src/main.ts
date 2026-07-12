import { hostname } from 'node:os'
import { sanitizeHandle } from 'boomwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

// Online is the default. --offline skips the join entirely (no network at all — useful when
// offline is explicitly wanted, e.g. no server reachable). Any join/connect failure while
// going online (join HTTP error, timeout, ws error, or a pre-start ws close) falls back to the
// same offline loop exactly once — runOnline only ever returns 'fallback' from a pre-match
// failure; once a match has actually started it always finishes and exits the process itself
// (teardownAndExit), so this branch can never run a second game on top of an online one.
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = Date.now() >>> 0

  if (!opts.offline) {
    const result = await runOnline({ name, server: opts.server })
    if (result !== 'fallback') return // unreachable in practice: runOnline exits the process itself once matched
    console.log('boomwait: could not reach an online match — playing offline\n')
  }

  await runOffline({ difficulty: opts.difficulty, name, seed })
}
