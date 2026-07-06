import type { MatchState } from 'fragwait-core'

// Post-match share card, printed to the NORMAL screen after term.restore() so
// it survives in the player's scrollback ready to copy into a post. Plain
// box-drawing text (no ANSI colors): it must paste cleanly anywhere, and every
// share carries the install commands.
export function shareCard(state: MatchState, selfId: string, mapName: string): string {
  const self = state.players[selfId]
  if (!self) return ''
  const all = Object.values(state.players)
  // competition ranking: 1 + players strictly ahead (ties share the better rank)
  const rank = 1 + all.filter((p) => p.frags > self.frags).length

  const lines = [
    'fragwait — terminal FPS deathmatch',
    '',
    `${self.handle}`,
    `${self.frags} FRAGS · #${rank} of ${all.length} · ${mapName}`,
    '',
    'play in your terminal:  npx -y fragwait',
    'Claude Code arcade:     /plugin marketplace add jeremiahagthe/Claude-Games',
    '                        /plugin install games@games',
  ]

  const inner = Math.max(...lines.map((l) => l.length)) + 2
  const boxed = lines.map((l) => `│ ${l.padEnd(inner - 2)} │`)
  return [`┌${'─'.repeat(inner)}┐`, ...boxed, `└${'─'.repeat(inner)}┘`, ''].join('\n')
}
