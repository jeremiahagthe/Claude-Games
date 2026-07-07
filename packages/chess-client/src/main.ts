import type { CliOpts } from './cliArgs.js'
import { runOffline } from './offline.js'

// Task 9 wires --offline to the real game loop. Online play lands in Task
// 10 — until then, running without --offline falls back to offline play
// (with a heads-up) rather than leaving main a dead end.
export async function main(opts: CliOpts): Promise<void> {
  if (!opts.offline) {
    console.log('checkwait: online play is not available yet (Task 10) — starting an offline game instead.\n')
  }
  await runOffline(opts)
}
