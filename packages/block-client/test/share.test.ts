import { describe, expect, it } from 'vitest'
import type { Result } from 'blockwait-core'
import { shareCard } from '../src/share.js'

// Post-match share card: plain text printed to the NORMAL screen after the alt
// screen is restored, so it lands in the player's scrollback ready to paste
// into a post. blockwait's bragging stats are lines cleared + lines sent
// (garbage attack), alongside win/loss/draw + elapsed match time.

describe('shareCard', () => {
  it('shows a win phrase, elapsed time, lines/sent, and opponent handle', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 95, 22, 9, 'bot·easy')
    expect(card).toContain('won in 1:35')
    expect(card).toContain('lines 22')
    expect(card).toContain('sent 9')
    expect(card).toContain('vs bot·easy')
    expect(card).toContain('npx -y blockwait')
    expect(card).toContain('/plugin marketplace add jeremiahagthe/Claude-Games')
  })

  it('reports a loss when the winner is not you', () => {
    const result: Result = { kind: 'win', winner: 1 }
    expect(shareCard(result, 0, 20 * 10, 3, 1, 'bot·easy')).toContain('lost in 0:10')
  })

  it('reports a draw (mutual top-out under sudden death)', () => {
    const result: Result = { kind: 'draw' }
    expect(shareCard(result, 0, 20 * 65, 40, 30, 'bot·easy')).toContain('drew in 1:05')
  })

  it('formats the clock as m:ss with a zero-padded seconds field', () => {
    const result: Result = { kind: 'win', winner: 0 }
    expect(shareCard(result, 0, 20 * 5, 1, 0, 'x')).toContain('in 0:05')
    expect(shareCard(result, 0, 20 * 125, 1, 0, 'x')).toContain('in 2:05')
  })

  it('carries the install commands', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 23, 20, 5, 'bot·hard')
    expect(card).toContain('npx -y blockwait')
    expect(card).toContain('/plugin install games@games')
  })

  it('carries no ANSI escapes (plain text — must paste cleanly anywhere)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 23, 10, 2, 'x')
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/)
  })

  it('stays within a single share-able post (≤ 280 chars)', () => {
    const result: Result = { kind: 'win', winner: 0 }
    const card = shareCard(result, 0, 20 * 3599, 9999, 9999, 'bot·hard')
    expect(card.length).toBeLessThanOrEqual(280)
  })
})
