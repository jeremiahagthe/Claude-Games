import type { CliOpts } from './cli.js'
import { runOffline } from './offline.js'

export async function main(opts: CliOpts): Promise<void> {
  // Milestone C (Task 22) adds: try online first unless --offline
  await runOffline({ name: opts.name })
}
