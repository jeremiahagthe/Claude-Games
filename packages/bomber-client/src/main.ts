import { hostname } from 'node:os'
import { sanitizeHandle } from 'boomwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'

// Task 10 scope: the offline loop (vs 3 synchronous bots) is real. Online
// matchmaking is Task 11 — TODO(task-11): once the server/lobby lands, route
// the (opts.offline === false) branch through runOnline instead; for now
// every invocation (with or without --offline) plays offline so the CLI is
// usable today.
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = Date.now() >>> 0
  await runOffline({ difficulty: opts.difficulty, name, seed })
}
