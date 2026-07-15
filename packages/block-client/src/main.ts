import { hostname } from 'node:os'
import { sanitizeHandle } from 'blockwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'

// Task 9 is the playable-OFFLINE milestone: online play (join + server relay)
// lands in Task 10. Until then BOTH paths run the offline duel — a non-offline
// invocation prints a one-line note explaining online isn't wired yet, then
// drops straight into the offline loop rather than failing. When runOnline
// arrives this becomes the snakewait-shaped join-with-offline-fallback.
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = opts.seed ?? Date.now() >>> 0

  if (!opts.offline) {
    console.log('blockwait: online play lands in a later release — playing offline\n')
  }

  await runOffline({ difficulty: opts.difficulty, name, seed })
}
