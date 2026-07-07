import type { CliOpts } from './cliArgs.js'
import { runGame } from './game.js'

// Thin shell: wires cliArgs' difficulty (and nothing else — offline has no
// opponent handle, server, or name to plumb through) into the shared game
// loop, vs a synchronous bot. The player is always White offline (Task 9's
// call — colour choice/online handles arrive with Task 10's real opponent).
export async function runOffline(opts: CliOpts): Promise<void> {
  await runGame({
    selfColor: 'w',
    difficulty: opts.difficulty,
    opponentHandle: `bot·${opts.difficulty}`,
  })
}
