import { describe, expect, it } from 'vitest'
import type { Result } from 'snakewait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: printed to the NORMAL screen after the alt screen is
// restored, so it lands in the player's scrollback ready to copy into a post.
// Mirrors packages/bomber-client/test/share.test.ts's shape (box-drawing +
// install lines), content adapted for snakewait (win/loss/draw + match time +
// final snake length, not bomber's move count).

describe('shareCard', () => {
  it('shows a win phrase, elapsed time, final length, and opponent handle', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 95, 12, 'bot·easy')
    expect(card).toContain('won in 1:35')
    expect(card).toContain('length 12')
    expect(card).toContain('vs bot·easy')
    expect(card).toContain('npx -y snakewait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('reports a loss when the winner is not you', () => {
    const result: Result = { kind: 'win', winner: 1 }
    expect(shareCard(result, 0, 20 * 10, 8, 'bot·easy')).toContain('lost in 0:10')
  })

  it('reports a draw (sudden-death shrink took everyone)', () => {
    const result: Result = { kind: 'draw' }
    expect(shareCard(result, 0, 20 * 65, 4, 'bot·easy')).toContain('drew in 1:05')
  })

  it('carries the install commands', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 23, 20, 'bot·hard')
    expect(card).toContain('npx -y snakewait')
    expect(card).toContain('/plugin install games@games')
  })

  it('carries no ANSI escapes (plain text — must paste cleanly anywhere)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 23, 10, 'x')
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/)
  })

  it('stays within a single share-able post (≤ 280 chars)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 3599, 999, 'bot·hard')
    expect(card.length).toBeLessThanOrEqual(280)
  })
})
