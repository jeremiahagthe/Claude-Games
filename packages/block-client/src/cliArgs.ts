import type { Difficulty } from 'blockwait-core'

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

// blockwait routes live on the same Cloudflare Worker host as
// fragwait/checkwait/boomwait/snakewait's — one deployment serves all games'
// Durable Objects (the real online routes land in Task 10; this default just
// points there ahead of time, unchanged from snakewait's cliArgs).
export const DEFAULT_SERVER = 'https://fragwait-server.agthe7.workers.dev'

export interface CliOpts {
  offline: boolean
  name?: string
  server: string
  seed?: number
  difficulty: Difficulty
}

export function parseArgs(argv: string[]): CliOpts {
  // Default difficulty is 'easy', mirroring snakewait/boomwait's cliArgs:
  // feel-gating found normal's bots near-hard in practice. Harder bots are an
  // explicit opt-in via --difficulty.
  const opts: CliOpts = { offline: false, difficulty: 'easy', server: DEFAULT_SERVER }
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
    } else if (a === '--difficulty') {
      const v = argv[++i]
      if (!DIFFICULTIES.includes(v as Difficulty)) {
        throw new Error(`invalid --difficulty: ${v} (expected one of ${DIFFICULTIES.join('|')})`)
      }
      opts.difficulty = v as Difficulty
    } else {
      throw new Error(`unknown flag: ${a} (usage: blockwait [--offline] [--name x] [--server url] [--seed n] [--difficulty easy|normal|hard])`)
    }
  }
  return opts
}
