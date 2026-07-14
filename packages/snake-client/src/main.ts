import { hostname } from 'node:os'
import { sanitizeHandle } from 'snakewait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'

// Online arrives in the next task. Until then this package must still be
// runnable end-to-end (Task 9's "playable offline" milestone): --offline
// runs the local loop directly, and any non-offline invocation ALSO runs
// offline for now, with a printed note so it's clear that's a temporary
// stand-in rather than a real online join.
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = opts.seed ?? Date.now() >>> 0

  if (!opts.offline) {
    console.log('snakewait: online play is not wired up yet — playing offline\n')
  }

  await runOffline({ difficulty: opts.difficulty, name, seed })
}
