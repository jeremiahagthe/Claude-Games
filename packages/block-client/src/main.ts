import { hostname } from 'node:os'
import { sanitizeHandle } from 'blockwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

// Default (no --offline) is the online duel; --offline forces the local bot game. The online
// path falls back to offline on any join/connect failure, printing a one-line note first so the
// player understands why they're suddenly against a bot — the snakewait-shaped
// join-with-offline-fallback. teardownAndExit never returns (process.exit on every path), so
// runOnline only resolves back here on the 'fallback' outcome.
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = opts.seed ?? Date.now() >>> 0

  if (!opts.offline) {
    const outcome = await runOnline({ name, server: opts.server })
    if (outcome !== 'fallback') return
    console.log('blockwait: could not reach the server — playing offline\n')
  }

  await runOffline({ difficulty: opts.difficulty, name, seed })
}
