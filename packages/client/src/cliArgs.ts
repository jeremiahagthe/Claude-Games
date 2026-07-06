import type { Difficulty } from 'fragwait-core'

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

export interface CliOpts {
  mode: 'play' | 'doctor'
  offline: boolean
  name?: string
  server?: string
  mute: boolean
  difficulty: Difficulty
}

export function parseArgs(argv: string[]): CliOpts {
  // Default difficulty is 'easy', matching the online backfill bots (72058a7):
  // feel-gating found normal's 0.3–0.4 skills near-hard in practice. Harder
  // bots are an explicit opt-in via --difficulty.
  const opts: CliOpts = { mode: 'play', offline: false, mute: false, difficulty: 'easy' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'doctor') opts.mode = 'doctor'
    else if (a === '--offline') opts.offline = true
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--server') opts.server = argv[++i]
    else if (a === '--mute') opts.mute = true
    else if (a === '--difficulty') {
      const v = argv[++i]
      if (!DIFFICULTIES.includes(v as Difficulty)) {
        throw new Error(`invalid --difficulty: ${v} (expected one of ${DIFFICULTIES.join('|')})`)
      }
      opts.difficulty = v as Difficulty
    }
  }
  return opts
}
