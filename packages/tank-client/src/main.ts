import { hostname } from 'node:os'
import { sanitizeHandle } from 'tankwait-core'
import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

// Entry dispatch. Default = online: POST /tank/join then a server duel. --offline
// forces the local bot duel. A join/connect FAILURE (or a lobby that never yields
// a room) collapses to 'fallback' inside runOnline — the block-shaped
// join-with-offline-fallback — so we print a one-line note and run the local bot
// duel instead of leaving the player staring at a dead prompt. A successful
// online match never returns (teardownAndExit process.exits on every path).
export async function main(opts: CliOpts): Promise<void> {
  const name = sanitizeHandle(opts.name ?? hostname())
  const seed = opts.seed ?? (Date.now() >>> 0)

  if (!opts.offline) {
    const outcome = await runOnline({ name, server: opts.server })
    if (outcome !== 'fallback') return // online match ran (and already exited on teardown)
    console.log('tankwait: could not reach the online lobby — playing offline\n')
  }

  await runOffline({ name, seed })
}
