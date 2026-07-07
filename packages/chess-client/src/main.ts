import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

// Online by default (Task 10); --offline skips the lobby entirely and goes
// straight to the local bot loop.
export async function main(opts: CliOpts): Promise<void> {
  if (opts.offline) {
    await runOffline(opts)
    return
  }
  await runOnline({ name: opts.name, server: opts.server, difficulty: opts.difficulty })
}
