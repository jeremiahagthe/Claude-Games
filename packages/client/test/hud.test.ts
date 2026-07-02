import { describe, expect, it } from 'vitest'
import { MatchRoom, mapById } from '@fragwait/core'
import { KillFeed, hudRows } from '../src/hud.js'

function room(): MatchRoom {
  const r = new MatchRoom(mapById('legacy_monolith'), 3)
  r.addPlayer('a', 'rebased-rustacean', false)
  r.addPlayer('b', 'segfaulting-sensei', false)
  return r
}

describe('KillFeed', () => {
  it('renders handles and weapons, keeps last 3', () => {
    const r = room()
    const feed = new KillFeed()
    feed.push({ tick: 1, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    expect(feed.lines()[0]).toBe('rebased-rustacean ⌫ segfaulting-sensei')
    feed.push({ tick: 2, killerId: 'b', victimId: 'a', weapon: 'rail' }, r.state)
    feed.push({ tick: 3, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    feed.push({ tick: 4, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    expect(feed.lines()).toHaveLength(3)
    expect(feed.lines()[0]).toContain('⌦') // rail glyph survived, oldest dropped
  })
})

describe('hudRows', () => {
  it('fixed width, shows hp/frags/time and Claude line', () => {
    const r = room()
    const { top, bottom } = hudRows(r.state, 'a', 80, 134, new KillFeed())
    expect(top).toHaveLength(80)
    expect(top).toContain('3:00')
    expect(top).toContain('Claude working 2m14s')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]).toHaveLength(80)
    expect(bottom[0]).toContain('HP')
    expect(bottom[0]).toContain('FRAGS 0')
  })
  it('omits Claude line when not busy', () => {
    const r = room()
    const { top } = hudRows(r.state, 'a', 80, null, new KillFeed())
    expect(top).not.toContain('Claude')
  })
})
