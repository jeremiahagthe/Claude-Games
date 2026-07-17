import { hostname } from 'node:os'
import { sanitizeHandle } from 'tankwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'

// Entry dispatch. Online play (the server duel) lands in Task 9 — until then
// BOTH paths run the local bot duel; a non-offline invocation prints a one-line
// note so the player understands why they're against a bot, then falls through
// to runOffline (the block-shaped join-with-offline-fallback, minus the net).
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = opts.seed ?? (Date.now() >>> 0)

  if (!opts.offline) {
    console.log('tankwait: online play is not available yet — playing offline\n')
  }

  await runOffline({ name, seed })
}
