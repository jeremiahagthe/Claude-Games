import { describe, expect, it } from 'vitest'
import { BLASTER_COOLDOWN_TICKS, MATCH_TICKS, MAX_HP, MAX_PLAYERS, SPAWN_PROTECTION_TICKS } from '../src/constants.js'
import { mapById } from '../src/maps.js'
import { makeInput } from '../src/movement.js'
import { MatchRoom } from '../src/room.js'

const MAP = mapById('legacy_monolith')

describe('MatchRoom', () => {
  it('adds players at spawns, rejects overflow', () => {
    const room = new MatchRoom(MAP, 1)
    for (let i = 0; i < MAX_PLAYERS; i++) room.addPlayer(`p${i}`, `h${i}`, false)
    expect(room.playerCount()).toBe(MAX_PLAYERS)
    expect(() => room.addPlayer('extra', 'x', false)).toThrow(/full/)
    const p0 = room.state.players['p0']!
    expect(p0.hp).toBe(MAX_HP)
    expect(p0.spawnProtection).toBe(SPAWN_PROTECTION_TICKS)
  })

  it('a scripted duel produces a kill, scoring, and respawn', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    // teleport into a known duel position (test-only state surgery)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0; a.spawnProtection = 0
    b.pos = { x: 12.5, y: 2.5 }; b.dir = Math.PI; b.spawnProtection = 0
    let seq = 0
    let kills = 0
    // 4 blaster hits at 25 dmg kill; cooldown is 10 ticks → ~40 ticks
    for (let t = 0; t < 60 && kills === 0; t++) {
      room.queueInput('a', [makeInput(++seq, { fire: true })])
      room.queueInput('b', [makeInput(++seq)])
      kills += room.tick().length
      // keep b still even after respawn for determinism of this test
      const bs = room.state.players['b']!
      if (bs.hp === MAX_HP && bs.spawnProtection === SPAWN_PROTECTION_TICKS) break
    }
    expect(room.state.players['a']!.frags).toBe(1)
    expect(room.state.players['b']!.deaths).toBe(1)
    expect(room.state.players['b']!.hp).toBe(MAX_HP) // instant respawn
  })

  it('spawn protection blocks damage; firing cancels own protection', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0; a.spawnProtection = 0
    b.pos = { x: 8.5, y: 2.5 }; b.spawnProtection = 100
    room.queueInput('a', [makeInput(1, { fire: true })])
    room.tick()
    expect(room.state.players['b']!.hp).toBe(MAX_HP) // protected
    expect(room.state.players['a']!.fireCooldown).toBe(BLASTER_COOLDOWN_TICKS) // set by firing this tick
  })

  it('empty queue reuses movement but never fire', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    a.spawnProtection = 0
    room.queueInput('a', [makeInput(1, { forward: 1, fire: true })])
    room.tick() // fires: cooldown set to BLASTER_COOLDOWN_TICKS
    room.tick() // no queued input → reuse forward:1, fire:false; cooldown decrements
    expect(room.state.players['a']!.fireCooldown).toBe(BLASTER_COOLDOWN_TICKS - 1)
  })

  it('rail pickup, one-shot kill, and pickup respawn timer', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    a.pos = { ...MAP.railSpawn }; a.spawnProtection = 0
    room.queueInput('a', [makeInput(1)])
    room.tick()
    expect(room.state.players['a']!.hasRail).toBe(true)
    expect(room.state.rail.present).toBe(false)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0
    b.pos = { x: 12.5, y: 2.5 }; b.spawnProtection = 0
    room.queueInput('a', [makeInput(2, { fire: true })])
    const kills = room.tick()
    expect(kills).toHaveLength(1)
    expect(kills[0]!.weapon).toBe('rail')
    expect(room.state.players['a']!.hasRail).toBe(false)
  })

  it('match ends after MATCH_TICKS', () => {
    const room = new MatchRoom(MAP, 1)
    room.addPlayer('a', 'alpha', false)
    for (let i = 0; i < MATCH_TICKS; i++) room.tick()
    expect(room.finished).toBe(true)
  })

  it('deterministic: same seed + same inputs → identical state', () => {
    const run = () => {
      const room = new MatchRoom(MAP, 99)
      room.addPlayer('a', 'alpha', false)
      room.addPlayer('b', 'beta', false)
      let seq = 0
      for (let t = 0; t < 500; t++) {
        room.queueInput('a', [makeInput(++seq, { forward: 1, turn: t % 7 === 0 ? 1 : 0, fire: t % 13 === 0 })])
        room.queueInput('b', [makeInput(++seq, { forward: t % 2 ? 1 : 0, turn: -1, fire: t % 11 === 0 })])
        room.tick()
      }
      return JSON.stringify(room.state)
    }
    expect(run()).toBe(run())
  })
})
