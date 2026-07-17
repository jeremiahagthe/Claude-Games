import type { Result } from 'tankwait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to paste into a post. Plain text
// (no ANSI, no box-drawing): it must paste cleanly anywhere AND fit in a single
// social post (≤ 280 chars, the X/Twitter budget). tankwait's bragging stats
// are rounds survived + total damage dealt, alongside win/loss/draw + the
// opponent handle — mirrors block/snakewait's plain-text card shape.

function resultPhrase(result: Result, you: number): 'won' | 'lost' | 'drew' {
  if (result.kind === 'draw') return 'drew'
  return result.winner === you ? 'won' : 'lost'
}

export function shareCard(
  result: Result,
  you: number,
  rounds: number,
  damageDealt: number,
  opponentHandle: string,
): string {
  const roundWord = rounds === 1 ? 'round' : 'rounds'

  const card = [
    `tankwait — ${resultPhrase(result, you)} in ${rounds} ${roundWord} · dealt ${damageDealt} dmg · vs ${opponentHandle}`,
    '',
    'play in your terminal:  npx -y tankwait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  return card.join('\n')
}
