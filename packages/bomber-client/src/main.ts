import type { CliOpts } from './cliArgs.js'

// Placeholder entry point (Task 9 scope: scaffold + renderer only). The
// interactive game loop is Task 10 and online matchmaking is Task 11 — main
// just wires cliArgs through for now so bin/boomwait.js -> dist/cli.js has a
// real module to import, mirroring checkwait's scaffold shape.
export async function main(opts: CliOpts): Promise<void> {
  void opts
  throw new Error('boomwait: game loop not implemented yet (see Task 10)')
}
