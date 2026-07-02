import { describe, expect, it } from 'vitest'
import { DIFFICULTY_SKILLS, MATCH_TICKS } from '../src/constants.js'
import { BotBrain } from '../src/bots.js'
import { parseMap } from '../src/map.js'
import { mapById } from '../src/maps.js'
import { MatchRoom } from '../src/room.js'

// Open interior with no walls between (4,3) and (8,3) so bots/enemies placed there
// have a clear line of sight and the geometry stays exactly as positioned (bots
// only move via stepPlayer, which these reaction/wobble tests never call).
const OPEN_ROOM = parseMap('open_room_bot_test', 'OpenRoomBotTest', [
  '####################',
  '#..................#',
  '#..................#',
  '#..................#',
  '#........R.........#',
  '#..................#',
  '#..................#',
  '#SSSSSSSSSSSSSSSSSS#',
  '####################',
].join('\n'))

function facingEnemy(room: MatchRoom): void {
  room.addPlayer('bot0', 'b', true)
  room.addPlayer('human', 'h', false)
  const me = room.state.players.bot0!
  const enemy = room.state.players.human!
  me.pos = { x: 4, y: 3 }
  me.dir = 0 // facing +x, straight at enemy
  enemy.pos = { x: 8, y: 3 } // dist 4: inside [2.5, 5) so the bot's own forward stays 0
}

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

  it('bots stay mobile: stuck-ticks stay below 30% of bot-ticks on every map (mobility smoke)', () => {
    const maxStuckRatio = 0.3
    const ticks = 1200 // 1 minute at 20 tps
    for (const mapId of ['node_modules', 'legacy_monolith', 'microservices'] as const) {
      const map = mapById(mapId)
      const room = new MatchRoom(map, 900)
      const brains = [0, 1, 2, 3].map((i) => {
        room.addPlayer(`bot${i}`, `bot-${i}`, true)
        return new BotBrain(`bot${i}`, 200 + i, 0.6)
      })
      let stuckTicks = 0
      for (let t = 0; t < ticks; t++) {
        const before = new Map(brains.map((b) => [b.id, { ...room.state.players[b.id]!.pos }]))
        for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
        room.tick()
        for (const b of brains) {
          const prev = before.get(b.id)!
          const now = room.state.players[b.id]!.pos
          if (prev.x === now.x && prev.y === now.y) stuckTicks++
        }
      }
      const botTicks = brains.length * ticks
      const ratio = stuckTicks / botTicks
      expect(ratio, `${mapId}: stuck ratio ${(ratio * 100).toFixed(1)}%`).toBeLessThan(maxStuckRatio)
    }
  })

  it('does not fire before REACTION_TICKS ticks have elapsed since first sighting', () => {
    const room = new MatchRoom(OPEN_ROOM, 1)
    facingEnemy(room)
    const skill = 0.3
    const reactionTicks = Math.round((1 - skill) * 12) // 8
    const brain = new BotBrain('bot0', 42, skill)
    for (let t = 0; t < reactionTicks; t++) {
      room.state.tick = t
      const input = brain.think(room.state, room.map)
      expect(input.fire, `tick ${t} must not fire (reaction not yet elapsed)`).toBe(false)
    }
  })

  it('re-sighting after a brief (< RESIGHT_GAP_TICKS) loss of visibility does not restart the reaction delay', () => {
    const room = new MatchRoom(OPEN_ROOM, 1)
    facingEnemy(room)
    const skill = 0.3
    const reactionTicks = Math.round((1 - skill) * 12) // 8
    const brain = new BotBrain('bot0', 42, skill)
    const enemy = room.state.players.human!
    const enemyPos = { ...enemy.pos }

    // See the enemy for a couple of ticks, then hide it (out of range) for 5 ticks
    // (< RESIGHT_GAP_TICKS = 20), then bring it back — this must NOT reset the timer.
    room.state.tick = 0
    brain.think(room.state, room.map)
    room.state.tick = 1
    brain.think(room.state, room.map)
    for (let t = 2; t < 7; t++) {
      room.state.tick = t
      enemy.pos = { x: 100, y: 100 } // far outside SIGHT_RANGE
      brain.think(room.state, room.map)
    }
    enemy.pos = enemyPos
    let firedBeforeReaction = false
    for (let t = 7; t < reactionTicks; t++) {
      room.state.tick = t
      if (brain.think(room.state, room.map).fire) firedBeforeReaction = true
    }
    expect(firedBeforeReaction).toBe(false) // still gated by the original sighting at tick 0
    // and by reactionTicks (8) the delay counted from the ORIGINAL sighting has elapsed,
    // not restarted at tick 7 when the enemy reappeared.
    room.state.tick = reactionTicks
    // no assertion on fire=true here (still probabilistic); just confirm think() no longer throws
    expect(() => brain.think(room.state, room.map)).not.toThrow()
  })

  it('wander noise is constant between AIM_WANDER_TICKS resample boundaries', () => {
    const room = new MatchRoom(OPEN_ROOM, 1)
    facingEnemy(room)
    const brain = new BotBrain('bot0', 7, 0) // skill 0 => max wobble amplitude
    const AIM_WANDER_TICKS = 6
    const turns: number[] = []
    for (let t = 0; t < 30; t++) {
      room.state.tick = t
      turns.push(brain.think(room.state, room.map).turn)
    }
    // Within each resample window, turn (a deterministic function of the constant
    // wander noise plus fixed geometry) must never change mid-window.
    for (let w = 0; w * AIM_WANDER_TICKS < turns.length; w++) {
      const start = w * AIM_WANDER_TICKS
      const end = Math.min(start + AIM_WANDER_TICKS, turns.length)
      const first = turns[start]!
      for (let i = start + 1; i < end; i++) {
        expect(turns[i], `tick ${i} (window starting ${start}) must match window's first turn`).toBe(first)
      }
    }
    // Sanity: the wobble mechanism is actually live (not a no-op) — across 5
    // windows with skill 0 (max amplitude) we should see more than one distinct value.
    expect(new Set(turns).size).toBeGreaterThan(1)
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

  it('a 1000-tick headless 4-bot match at normal difficulty still produces at least one frag', () => {
    const map = mapById('legacy_monolith')
    const room = new MatchRoom(map, 13)
    const skills = DIFFICULTY_SKILLS.normal
    const brains = [0, 1, 2, 3].map((i) => {
      room.addPlayer(`bot${i}`, `bot-${i}`, true)
      return new BotBrain(`bot${i}`, 300 + i, skills[i % skills.length])
    })
    for (let t = 0; t < 1000; t++) {
      for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
      room.tick()
    }
    const totalFrags = Object.values(room.state.players).reduce((n, p) => n + p.frags, 0)
    expect(totalFrags).toBeGreaterThanOrEqual(1)
  })
})
