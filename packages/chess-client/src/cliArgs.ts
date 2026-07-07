import type { ChessDifficulty } from 'checkwait-core'

const DIFFICULTIES: readonly ChessDifficulty[] = ['easy', 'normal', 'hard']

// Chess routes live on the same Cloudflare Worker host as fragwait's — one
// deployment serves both games' Durable Objects.
export const DEFAULT_SERVER = 'https://fragwait-server.agthe7.workers.dev'

export interface CliOpts {
  offline: boolean
  name?: string
  server: string
  mute: boolean
  difficulty: ChessDifficulty
}

export function parseArgs(argv: string[]): CliOpts {
  // Default difficulty is 'easy', mirroring fragwait's cliArgs.ts (72058a7):
  // feel-gating found normal's 0.3–0.4 skills near-hard in practice. Harder
  // bots are an explicit opt-in via --difficulty.
  const opts: CliOpts = { offline: false, mute: false, difficulty: 'easy', server: DEFAULT_SERVER }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--offline') opts.offline = true
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--server') opts.server = argv[++i]!
    else if (a === '--mute') opts.mute = true
    else if (a === '--difficulty') {
      const v = argv[++i]
      if (!DIFFICULTIES.includes(v as ChessDifficulty)) {
        throw new Error(`invalid --difficulty: ${v} (expected one of ${DIFFICULTIES.join('|')})`)
      }
      opts.difficulty = v as ChessDifficulty
    }
  }
  return opts
}
