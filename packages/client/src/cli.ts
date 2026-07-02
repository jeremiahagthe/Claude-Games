import { doctorReport } from './doctor.js'

export interface CliOpts { mode: 'play' | 'doctor'; offline: boolean; name?: string; server?: string }

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { mode: 'play', offline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'doctor') opts.mode = 'doctor'
    else if (a === '--offline') opts.offline = true
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--server') opts.server = argv[++i]
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.mode === 'doctor') {
  console.log(doctorReport(process.env, process.stdout.isTTY ?? false, process.stdout.columns ?? 0, process.stdout.rows ?? 0))
} else {
  const { main } = await import('./main.js')
  await main(opts)
}
