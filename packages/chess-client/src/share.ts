import type { Color, Result } from 'checkwait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to copy into a post. Plain
// box-drawing text (no ANSI colors): it must paste cleanly anywhere, and every
// share carries the install commands. Mirrors packages/client/src/share.ts's
// box-drawing pattern; content rewritten for chess (win/loss/draw + reason +
// move count, instead of frags/rank/map).

// `won on time` / `lost on checkmate` / `drew by stalemate` style phrase.
function resultPhrase(result: Result, selfColor: Color): string {
  if ('winner' in result) {
    const verb = result.winner === selfColor ? 'won' : 'lost'
    const reason = result.kind === 'flag' ? 'on time' : result.kind === 'checkmate' ? 'on checkmate' : 'by resignation'
    return `${verb} ${reason}`
  }
  const REASONS: Record<Exclude<Result['kind'], 'checkmate' | 'resign' | 'flag'>, string> = {
    stalemate: 'stalemate',
    'fifty-move': 'the fifty-move rule',
    threefold: 'threefold repetition',
    insufficient: 'insufficient material',
  }
  return `drew by ${REASONS[result.kind as Exclude<Result['kind'], 'checkmate' | 'resign' | 'flag'>]}`
}

export function shareCard(result: Result, selfColor: Color, moveCount: number, opponentHandle: string): string {
  const moveWord = moveCount === 1 ? 'move' : 'moves'

  const lines = [
    'checkwait — terminal blitz chess',
    '',
    `${resultPhrase(result, selfColor)} · ${moveCount} ${moveWord} · vs ${opponentHandle}`,
    '',
    'play in your terminal:  npx -y checkwait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  const inner = Math.max(...lines.map((l) => l.length)) + 2
  const boxed = lines.map((l) => `│ ${l.padEnd(inner - 2)} │`)
  return [`┌${'─'.repeat(inner)}┐`, ...boxed, `└${'─'.repeat(inner)}┘`, ''].join('\n')
}
