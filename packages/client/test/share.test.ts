import { describe, expect, it } from 'vitest'
import type { MatchState, PlayerState } from 'fragwait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: printed to the NORMAL screen after the alt screen is
// restored, so it lands in the player's scrollback ready to copy into a post.
// Every share carries the install command — that's the point.

function player(id: string, handle: string, frags: number): PlayerState {
  return {
    id,
    handle,
    frags,
    hp: 100,
    pos: { x: 1, y: 1 },
    dir: 0,
    weapon: 'blaster',
    fireCooldown: 0,
    spawnProtection: 0,
    deaths: 0,
    isBot: false,
    respawnAt: 0,
  } as unknown as PlayerState
}

function state(players: PlayerState[]): MatchState {
  return { players: Object.fromEntries(players.map((p) => [p.id, p])) } as unknown as MatchState
}

describe('shareCard', () => {
  it('shows handle, frags, competition-style placement, map, and the install commands', () => {
    const s = state([player('me', 'orphaned-stacktrace', 11), player('b1', 'bot-a', 4), player('b2', 'bot-b', 7)])
    const card = shareCard(s, 'me', 'legacy_monolith')
    expect(card).toContain('orphaned-stacktrace')
    expect(card).toContain('11 FRAGS')
    expect(card).toContain('#1 of 3')
    expect(card).toContain('legacy_monolith')
    expect(card).toContain('npx -y fragwait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('ties use competition ranking: equal frags share the better placement', () => {
    const s = state([player('me', 'me', 5), player('a', 'a', 5), player('b', 'b', 9)])
    expect(shareCard(s, 'me', 'legacy_monolith')).toContain('#2 of 3') // one player strictly ahead
  })

  it('last place is honest', () => {
    const s = state([player('me', 'me', 0), player('a', 'a', 3), player('b', 'b', 1)])
    expect(shareCard(s, 'me', 'legacy_monolith')).toContain('#3 of 3')
  })

  it('box edges are aligned (every line has equal display width)', () => {
    const s = state([player('me', 'a-very-long-handle-name·synth', 2), player('b', 'x', 0)])
    const lines = shareCard(s, 'me', 'legacy_monolith').split('\n').filter((l) => l.length > 0)
    const widths = new Set(lines.map((l) => l.length))
    expect(widths.size).toBe(1)
    expect(lines[0]!.startsWith('┌')).toBe(true)
    expect(lines[lines.length - 1]!.startsWith('└')).toBe(true)
  })

  it('returns empty string when self is not in the match (defensive)', () => {
    const s = state([player('a', 'a', 3)])
    expect(shareCard(s, 'ghost', 'legacy_monolith')).toBe('')
  })
})
