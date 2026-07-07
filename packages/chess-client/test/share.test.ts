import { describe, expect, it } from 'vitest'
import type { Result } from 'checkwait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: printed to the NORMAL screen after the alt screen is
// restored, so it lands in the player's scrollback ready to copy into a post.
// Every share carries the install command — that's the point. Mirrors
// packages/client/test/share.test.ts's shape (box-drawing + install lines),
// content adapted for chess (result phrase, not frags/rank).

describe('shareCard', () => {
  it('shows the result phrase (win on time), move count, opponent, and the install commands', () => {
    const result: Result = { kind: 'flag', winner: 'w' }
    const card = shareCard(result, 'w', 23, 'async-pointer')
    expect(card).toContain('won on time · 23 moves · vs async-pointer')
    expect(card).toContain('npx -y checkwait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('a single move uses the singular "move"', () => {
    const result: Result = { kind: 'flag', winner: 'w' }
    expect(shareCard(result, 'w', 1, 'async-pointer')).toContain('· 1 move ·')
  })

  it('reports a loss when the winner is not selfColor', () => {
    const result: Result = { kind: 'checkmate', winner: 'b' }
    expect(shareCard(result, 'w', 40, 'async-pointer')).toContain('lost on checkmate')
  })

  it('reports a win by checkmate', () => {
    const result: Result = { kind: 'checkmate', winner: 'w' }
    expect(shareCard(result, 'w', 40, 'async-pointer')).toContain('won on checkmate')
  })

  it('reports resignation losses/wins', () => {
    expect(shareCard({ kind: 'resign', winner: 'b' }, 'w', 12, 'x')).toContain('lost by resignation')
    expect(shareCard({ kind: 'resign', winner: 'w' }, 'w', 12, 'x')).toContain('won by resignation')
  })

  it('reports draws by reason', () => {
    expect(shareCard({ kind: 'stalemate' }, 'w', 30, 'x')).toContain('drew by stalemate')
    expect(shareCard({ kind: 'fifty-move' }, 'w', 30, 'x')).toContain('drew by the fifty-move rule')
    expect(shareCard({ kind: 'threefold' }, 'w', 30, 'x')).toContain('drew by threefold repetition')
    expect(shareCard({ kind: 'insufficient' }, 'w', 30, 'x')).toContain('drew by insufficient material')
  })

  it('box edges are aligned (every line has equal display width)', () => {
    const result: Result = { kind: 'flag', winner: 'w' }
    const lines = shareCard(result, 'w', 23, 'a-very-long-opponent-handle·synth').split('\n').filter((l) => l.length > 0)
    const widths = new Set(lines.map((l) => l.length))
    expect(widths.size).toBe(1)
    expect(lines[0]!.startsWith('┌')).toBe(true)
    expect(lines[lines.length - 1]!.startsWith('└')).toBe(true)
  })
})
