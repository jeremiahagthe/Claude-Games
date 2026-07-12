import type { Difficulty } from 'boomwait-core'

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

// Bomber routes live on the same Cloudflare Worker host as fragwait/checkwait's
// — one deployment serves all three games' Durable Objects (Task 11 stands up
// the actual routes; this default just points there ahead of time).
export const DEFAULT_SERVER = 'https://fragwait-server.agthe7.workers.dev'

export interface CliOpts {
  offline: boolean
  name?: string
  server: string
  difficulty: Difficulty
}

export function parseArgs(argv: string[]): CliOpts {
  // Default difficulty is 'easy', mirroring fragwait/checkwait's cliArgs
  // (72058a7): feel-gating found normal's 0.3-0.4 skills near-hard in
  // practice. Harder bots are an explicit opt-in via --difficulty.
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
    } else if (a === '--difficulty') {
      const v = argv[++i]
      if (!DIFFICULTIES.includes(v as Difficulty)) {
        throw new Error(`invalid --difficulty: ${v} (expected one of ${DIFFICULTIES.join('|')})`)
      }
      opts.difficulty = v as Difficulty
    }
  }
  return opts
}
