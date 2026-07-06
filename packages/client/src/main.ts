import type { CliOpts } from './cli.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

export const DEFAULT_SERVER = 'http://127.0.0.1:8787' // replaced with the deployed URL in Step 6

export async function main(opts: CliOpts): Promise<void> {
  if (!opts.offline) {
    const server = opts.server ?? process.env['FRAGWAIT_SERVER'] ?? DEFAULT_SERVER
    const result = await runOnline({ name: opts.name, mute: opts.mute, server })
    if (result === 'played') return
    console.log('fragwait: server unreachable — offline match vs bots\n')
  }
  await runOffline({ name: opts.name, mute: opts.mute, difficulty: opts.difficulty })
}
