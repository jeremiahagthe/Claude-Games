import { describe, expect, it } from 'vitest'
import type { Result } from 'tankwait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: plain text printed to the NORMAL screen after the alt
// screen is restored, so it lands in the player's scrollback ready to paste
// into a post. tankwait's bragging stats are rounds survived + damage dealt,
// alongside win/loss/draw + the opponent handle. ≤ 280 chars (the X budget).

describe('shareCard', () => {
  it('shows a win phrase, rounds, damage dealt, and opponent handle', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 7, 143, 'bot')
    expect(card).toContain('won in 7 rounds')
    expect(card).toContain('dealt 143 dmg')
    expect(card).toContain('vs bot')
    expect(card).toContain('npx -y tankwait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('reports a loss when the winner is not you', () => {
    const result: Result = { kind: 'win', winner: 1 }
    expect(shareCard(result, 0, 3, 40, 'bot')).toContain('lost in 3 rounds')
  })

  it('reports a draw (mutual death under sudden death)', () => {
    const result: Result = { kind: 'draw' }
    expect(shareCard(result, 0, 12, 200, 'bot')).toContain('drew in 12 rounds')
  })

  it('uses the singular round word for a one-round match', () => {
    const result: Result = { kind: 'win', winner: 0 }
    expect(shareCard(result, 0, 1, 60, 'bot')).toContain('in 1 round ·')
  })

  it('carries the install commands', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 5, 90, 'bot')
    expect(card).toContain('npx -y tankwait')
    expect(card).toContain('/plugin install games@games')
  })

  it('carries no ANSI escapes (plain text — must paste cleanly anywhere)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 5, 90, 'bot')
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/)
  })

  it('stays within a single share-able post (≤ 280 chars)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 9999, 999999, 'a-very-long-opponent-handle-xxx')
    expect(card.length).toBeLessThanOrEqual(280)
  })
})
