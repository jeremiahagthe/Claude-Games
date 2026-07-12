import { describe, expect, it } from 'vitest'
import type { Result } from 'boomwait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: printed to the NORMAL screen after the alt screen is
// restored, so it lands in the player's scrollback ready to copy into a post.
// Every share carries the install command — that's the point. Mirrors
// packages/chess-client/test/share.test.ts's shape (box-drawing + install
// lines), content adapted for bomber (win/loss/draw + match time, not SAN).

describe('shareCard', () => {
  it('shows a win phrase, elapsed time, opponent, and the install commands', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 95, 'bot·easy')
    expect(card).toContain('won in 1:35 · vs bot·easy')
    expect(card).toContain('npx -y boomwait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('reports a loss when the winner is not you', () => {
    const result: Result = { kind: 'win', winner: 1 }
    expect(shareCard(result, 0, 20 * 10, 'bot·easy')).toContain('lost in 0:10')
  })

  it('reports a draw (sudden-death shrink took everyone)', () => {
    const result: Result = { kind: 'draw' }
    expect(shareCard(result, 0, 20 * 65, 'bot·easy')).toContain('drew in 1:05')
  })

  it('box edges are aligned (every line has equal display width)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const lines = shareCard(result, 0, 20 * 23, 'a-very-long-opponent-handle·synth')
      .split('\n')
      .filter((l) => l.length > 0)
    const widths = new Set(lines.map((l) => l.length))
    expect(widths.size).toBe(1)
    expect(lines[0]!.startsWith('┌')).toBe(true)
    expect(lines[lines.length - 1]!.startsWith('└')).toBe(true)
  })

  it('carries no ANSI escapes (plain text — must paste cleanly anywhere)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 23, 'x')
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/)
  })
})
