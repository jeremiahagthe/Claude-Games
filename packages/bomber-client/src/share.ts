import type { Result } from 'boomwait-core'
import { TICK_RATE } from 'boomwait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to copy into a post. Plain
// box-drawing text (no ANSI colors): it must paste cleanly anywhere, and every
// share carries the install commands. Mirrors packages/chess-client/src/share.ts's
// box-drawing pattern; content rewritten for bomber (win/loss/draw + elapsed
// match time, instead of SAN move count).

function resultPhrase(result: Result, you: number): 'won' | 'lost' | 'drew' {
  if (result.kind === 'win') return result.winner === you ? 'won' : 'lost'
  return 'drew'
}

function fmtClock(tick: number): string {
  const totalSec = Math.max(0, Math.floor(tick / TICK_RATE))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function shareCard(result: Result, you: number, tick: number, opponentHandle: string): string {
  const time = fmtClock(tick)

  const lines = [
    'boomwait — terminal bomberman',
    '',
    `${resultPhrase(result, you)} in ${time} · vs ${opponentHandle}`,
    '',
    'play in your terminal:  npx -y boomwait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  const inner = Math.max(...lines.map((l) => l.length)) + 2
  const boxed = lines.map((l) => `│ ${l.padEnd(inner - 2)} │`)
  return [`┌${'─'.repeat(inner)}┐`, ...boxed, `└${'─'.repeat(inner)}┘`, ''].join('\n')
}
