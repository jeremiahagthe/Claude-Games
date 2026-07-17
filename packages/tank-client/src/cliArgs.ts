// block/snakewait's parseArgs surface, verbatim MINUS --difficulty: tankwait's
// offline duel picks a fixed bot skill, so there is no difficulty flag. The
// online routes land in Task 9; DEFAULT_SERVER already points at the shared
// fragwait workers.dev host (one deployment serves every game's Durable
// Objects), unchanged from block.
export const DEFAULT_SERVER = 'https://fragwait-server.agthe7.workers.dev'

export interface CliOpts {
  offline: boolean
  name?: string
  server: string
  seed?: number
}

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { offline: false, server: DEFAULT_SERVER }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--offline') opts.offline = true
    else if (a === '--name') {
      const v = argv[++i]
      if (v === undefined) throw new Error('invalid --name: expected a value')
      opts.name = v
    } else if (a === '--server') {
      const v = argv[++i]
      if (v === undefined) throw new Error('invalid --server: expected a URL')
      opts.server = v
    } else if (a === '--seed') {
      const v = argv[++i]
      if (v === undefined || Number.isNaN(Number(v))) throw new Error('invalid --seed: expected a number')
      opts.seed = Number(v)
    } else {
      throw new Error(`unknown flag: ${a} (usage: tankwait [--offline] [--name x] [--server url] [--seed n])`)
    }
  }
  return opts
}
