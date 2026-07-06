import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS, MIN_COMBATANTS, parseServerMsg } from 'fragwait-core'
import { MatchHost, type ClientConn } from '../src/match-host.js'

function conn(): ClientConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

describe('MatchHost', () => {
  it('first human gets a welcome and bots backfill to MIN_COMBATANTS', () => {
    const host = new MatchHost(1)
    const c = conn()
    const id = host.join(c, 'tester')
    expect(id).not.toBeNull()
    const welcome = parseServerMsg(c.sent[0]!)
    expect(welcome?.t).toBe('welcome')
    if (welcome?.t !== 'welcome') return
    expect(Object.keys(welcome.state.players)).toHaveLength(MIN_COMBATANTS)
    const bots = Object.values(welcome.state.players).filter((p) => p.bot)
    expect(bots).toHaveLength(MIN_COMBATANTS - 1)
    expect(bots.every((b) => b.handle.endsWith('·synth'))).toBe(true)
  })

  it('inputs move the player; snaps broadcast each tick', () => {
    const host = new MatchHost(2)
    const c = conn()
    const id = host.join(c, 'mover')!
    const welcome = parseServerMsg(c.sent[0]!)!
    const x0 = welcome.t === 'welcome' ? welcome.state.players[id]!.pos.x : 0
    host.handleMessage(id, JSON.stringify({ t: 'input', inputs: [{ seq: 1, forward: 1, strafe: 0, turn: 0, fire: false }] }))
    expect(host.tick()).toBe('running')
    const snap = parseServerMsg(c.sent[c.sent.length - 1]!)!
    expect(snap.t).toBe('snap')
    const me = snap.state.players[id]!
    expect(Math.hypot(me.pos.x - x0, 0)).toBeGreaterThan(0) // moved (direction depends on spawn facing)
  })

  it('human joining a bot-padded full room evicts one bot; bot-free full room rejects', () => {
    const host = new MatchHost(3)
    const conns = Array.from({ length: MAX_PLAYERS }, conn)
    const ids = conns.map((c, i) => host.join(c, `h${i}`))
    expect(ids.every(Boolean)).toBe(true) // bots evicted one by one as humans join
    expect(host.humanCount()).toBe(MAX_PLAYERS)
    expect(host.join(conn(), 'late')).toBeNull() // full of humans
  })

  it('zero humans → empty (caller stops the loop)', () => {
    const host = new MatchHost(4)
    const c = conn()
    const id = host.join(c, 'quitter')!
    expect(host.tick()).toBe('running')
    host.leave(id)
    expect(host.tick()).toBe('empty')
  })
})
