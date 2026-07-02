import { describe, expect, it } from 'vitest'
import { MATCH_TICKS } from '../src/constants.js'
import { BotBrain } from '../src/bots.js'
import { mapById } from '../src/maps.js'
import { MatchRoom } from '../src/room.js'

describe('BotBrain', () => {
  it('produces valid inputs', () => {
    const room = new MatchRoom(mapById('legacy_monolith'), 5)
    room.addPlayer('bot1', 'lazy-linter', true)
    const brain = new BotBrain('bot1', 5)
    const input = brain.think(room.state, room.map)
    expect([-1, 0, 1]).toContain(input.forward)
    expect([-1, 0, 1]).toContain(input.turn)
    expect(typeof input.fire).toBe('boolean')
  })

  it('bot-vs-bot match produces frags and finishes (smoke)', () => {
    const map = mapById('legacy_monolith')
    const room = new MatchRoom(map, 7)
    const brains = [0, 1, 2, 3].map((i) => {
      room.addPlayer(`bot${i}`, `bot-${i}`, true)
      return new BotBrain(`bot${i}`, 100 + i, 0.6)
    })
    for (let t = 0; t < MATCH_TICKS; t++) {
      for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
      room.tick()
    }
    expect(room.finished).toBe(true)
    const totalFrags = Object.values(room.state.players).reduce((n, p) => n + p.frags, 0)
    expect(totalFrags).toBeGreaterThan(3) // 3 minutes of 4 aggressive bots must produce kills
  })

  it('bots are deterministic per seed', () => {
    const run = () => {
      const room = new MatchRoom(mapById('microservices'), 11)
      room.addPlayer('b0', 'x', true)
      room.addPlayer('b1', 'y', true)
      const brains = [new BotBrain('b0', 1), new BotBrain('b1', 2)]
      for (let t = 0; t < 400; t++) {
        for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
        room.tick()
      }
      return JSON.stringify(room.state)
    }
    expect(run()).toBe(run())
  })
})
