import { parseArgs } from './cliArgs.js'

// parseArgs/CliOpts live in cliArgs.js (pure, no side effects) so tests can
// import them directly — this module always runs its dispatch on import
// (mirrors fragwait's bin/fragwait.js unconditional `import('../dist/cli.js')`),
// so it must never be imported outside the real entry point.
export type { CliOpts } from './cliArgs.js'
export { parseArgs } from './cliArgs.js'

const opts = parseArgs(process.argv.slice(2))
const { main } = await import('./main.js')
await main(opts)
