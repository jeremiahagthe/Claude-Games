import { doctorReport } from './doctor.js'
import { readOsKeyTimings } from './input/os-timings.js'
import { parseArgs } from './cliArgs.js'

// parseArgs/CliOpts live in cliArgs.js (pure, no side effects) so tests can
// import them directly — this module always runs its dispatch on import
// (mirrors bin/fragwait.js's unconditional `import('../dist/cli.js')`), so it
// must never be imported outside the real entry point.
export type { CliOpts } from './cliArgs.js'
export { parseArgs } from './cliArgs.js'

const opts = parseArgs(process.argv.slice(2))
if (opts.mode === 'doctor') {
  // Timings only exist as a measurement on darwin; elsewhere the report
  // omits the key-repeat line rather than printing the factory fallback.
  const keyTimings = process.platform === 'darwin' ? readOsKeyTimings() : undefined
  console.log(doctorReport(process.env, process.stdout.isTTY ?? false, process.stdout.columns ?? 0, process.stdout.rows ?? 0, keyTimings))
} else {
  const { main } = await import('./main.js')
  await main(opts)
}
