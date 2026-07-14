import type { Result } from 'snakewait-core'
import { TICK_RATE } from 'snakewait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to copy into a post. Plain
// text (no ANSI, no box-drawing): it must paste cleanly anywhere AND fit in a
// single social post (≤280 chars, the X/Twitter budget) — boomwait's
// box-drawn card pads every line out to the box's full width and blows past
// that budget once the install-command lines are included, so this diverges
// from that shape rather than copying it verbatim. Adds your final snake
// length alongside the win/loss/draw + elapsed match time (a snake's length
// at death/finish is the natural bragging stat, the way SAN move count is
// for chess).

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

export function shareCard(
  result: Result,
  you: number,
  tick: number,
  finalLength: number,
  opponentHandle: string,
): string {
  const time = fmtClock(tick)

  const lines = [
    `snakewait — ${resultPhrase(result, you)} in ${time} · length ${finalLength} · vs ${opponentHandle}`,
    '',
    'play in your terminal:  npx -y snakewait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  return lines.join('\n')
}
