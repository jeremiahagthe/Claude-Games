import type { CliOpts } from './cliArgs.js'

// Scaffold-only stub (Task 8 scope): the offline game loop lands in Task 9
// and the online flow in Task 10. This proves the scaffold wires end-to-end
// (cliArgs -> main -> exit) without pretending to play a game yet.
export async function main(opts: CliOpts): Promise<void> {
  console.log(`checkwait: scaffold ready (offline=${opts.offline}, difficulty=${opts.difficulty})`)
}
