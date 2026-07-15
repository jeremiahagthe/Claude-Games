import type { Result } from 'blockwait-core'
import { TICK_RATE } from 'blockwait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to paste into a post. Plain
// text (no ANSI, no box-drawing): it must paste cleanly anywhere AND fit in a
// single social post (≤280 chars, the X/Twitter budget) — mirrors snakewait's
// share.ts shape rather than boomwait's box-drawn card (which pads every line
// to the box width and blows past that budget). blockwait's bragging stats are
// lines cleared + lines sent (garbage attack), alongside win/loss/draw + the
// elapsed match time.

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
  lines: number,
  sent: number,
  opponentHandle: string,
): string {
  const time = fmtClock(tick)

  const card = [
    `blockwait — ${resultPhrase(result, you)} in ${time} · lines ${lines} · sent ${sent} · vs ${opponentHandle}`,
    '',
    'play in your terminal:  npx -y blockwait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  return card.join('\n')
}
