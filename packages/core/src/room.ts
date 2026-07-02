import {
  BLASTER_COOLDOWN_TICKS, BLASTER_DMG, MATCH_TICKS, MAX_HP, MAX_PLAYERS,
  RAIL_DMG, RAIL_PICKUP_RADIUS, RAIL_RESPAWN_TICKS, SPAWN_PROTECTION_TICKS,
} from './constants.js'
import { fireHitscan } from './combat.js'
import type { GameMap } from './map.js'
import { makeInput, stepPlayer, wrapAngle } from './movement.js'
import { mulberry32 } from './prng.js'
import type { KillEvent, MatchState, PlayerInput, PlayerState, Vec2 } from './types.js'

export class MatchRoom {
  readonly map: GameMap
  state: MatchState
  private queues = new Map<string, PlayerInput[]>()
  private lastInputs = new Map<string, PlayerInput>()
  private rng: () => number

  constructor(map: GameMap, seed: number) {
    this.map = map
    this.rng = mulberry32(seed)
    this.state = {
      tick: 0,
      timeLeftTicks: MATCH_TICKS,
      mapId: map.id,
      players: {},
      rail: { pos: { ...map.railSpawn }, present: true, respawnTimer: 0 },
      kills: [],
    }
  }

  get finished(): boolean {
    return this.state.timeLeftTicks <= 0
  }

  humanCount(): number {
    return Object.values(this.state.players).filter((p) => !p.bot).length
  }

  playerCount(): number {
    return Object.keys(this.state.players).length
  }

  addPlayer(id: string, handle: string, bot: boolean): PlayerState {
    if (this.playerCount() >= MAX_PLAYERS) throw new Error('room full')
    const pos = this.pickSpawn()
    const center = { x: this.map.width / 2, y: this.map.height / 2 }
    const p: PlayerState = {
      id, handle, bot,
      pos,
      dir: wrapAngle(Math.atan2(center.y - pos.y, center.x - pos.x)),
      hp: MAX_HP, frags: 0, deaths: 0,
      fireCooldown: 0, spawnProtection: SPAWN_PROTECTION_TICKS,
      hasRail: false, lastInputSeq: 0,
    }
    this.state.players[id] = p
    this.queues.set(id, [])
    return p
  }

  removePlayer(id: string): void {
    delete this.state.players[id]
    this.queues.delete(id)
    this.lastInputs.delete(id)
  }

  queueInput(id: string, inputs: PlayerInput[]): void {
    const q = this.queues.get(id)
    if (!q) return
    q.push(...inputs)
    while (q.length > 4) q.shift() // drop oldest on backlog
  }

  tick(): KillEvent[] {
    const s = this.state
    s.tick++
    s.timeLeftTicks--
    const kills: KillEvent[] = []

    for (const p of Object.values(s.players)) {
      if (p.fireCooldown > 0) p.fireCooldown--
      if (p.spawnProtection > 0) p.spawnProtection--
    }
    if (!s.rail.present && --s.rail.respawnTimer <= 0) {
      s.rail.present = true
      s.rail.respawnTimer = 0
    }

    // stable iteration order = insertion order; same on both sides given same joins
    for (const id of Object.keys(s.players)) {
      const p = s.players[id]!
      const q = this.queues.get(id) ?? []
      let input = q.shift()
      if (!input) {
        const last = this.lastInputs.get(id)
        input = last ? { ...last, seq: p.lastInputSeq, fire: false } : makeInput(p.lastInputSeq)
      }
      this.lastInputs.set(id, input)
      stepPlayer(p, input, this.map)

      if (input.fire && p.fireCooldown === 0 && p.hp > 0) {
        p.fireCooldown = BLASTER_COOLDOWN_TICKS
        p.spawnProtection = 0
        const weapon = p.hasRail ? 'rail' : 'blaster'
        const dmg = p.hasRail ? RAIL_DMG : BLASTER_DMG
        if (p.hasRail) p.hasRail = false
        const victimId = fireHitscan(id, s, this.map)
        if (victimId) {
          const v = s.players[victimId]!
          if (v.spawnProtection === 0) {
            v.hp -= dmg
            if (v.hp <= 0) {
              p.frags++
              v.deaths++
              kills.push({ tick: s.tick, killerId: id, victimId, weapon })
              this.respawn(v)
            }
          }
        }
      }
    }

    if (s.rail.present) {
      for (const p of Object.values(s.players)) {
        if (p.hp <= 0) continue
        const d = Math.hypot(p.pos.x - s.rail.pos.x, p.pos.y - s.rail.pos.y)
        if (d <= RAIL_PICKUP_RADIUS) {
          p.hasRail = true
          s.rail.present = false
          s.rail.respawnTimer = RAIL_RESPAWN_TICKS
          break
        }
      }
    }

    s.kills = kills
    return kills
  }

  private respawn(p: PlayerState): void {
    p.pos = this.pickSpawn(p.id)
    const center = { x: this.map.width / 2, y: this.map.height / 2 }
    p.dir = wrapAngle(Math.atan2(center.y - p.pos.y, center.x - p.pos.x))
    p.hp = MAX_HP
    p.spawnProtection = SPAWN_PROTECTION_TICKS
    p.hasRail = false
    p.fireCooldown = 0
  }

  // farthest-from-nearest-enemy spawn; deterministic tie-break on index
  private pickSpawn(excludeId?: string): Vec2 {
    const enemies = Object.values(this.state.players).filter((p) => p.id !== excludeId && p.hp > 0)
    let bestIdx = 0
    let bestScore = -1
    this.map.spawns.forEach((sp, i) => {
      const nearest = enemies.length
        ? Math.min(...enemies.map((e) => Math.hypot(e.pos.x - sp.x, e.pos.y - sp.y)))
        : this.rng() * 100 // empty room: seeded-random spawn variety
      if (nearest > bestScore) {
        bestScore = nearest
        bestIdx = i
      }
    })
    return { ...this.map.spawns[bestIdx]! }
  }
}
