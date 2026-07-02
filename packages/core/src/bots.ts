import { castWall } from './combat.js'
import type { GameMap } from './map.js'
import { isWall } from './map.js'
import { makeInput, wrapAngle } from './movement.js'
import { mulberry32 } from './prng.js'
import type { MatchState, PlayerInput, PlayerState, Vec2 } from './types.js'

const SIGHT_RANGE = 20
const AIM_FIRE_CONE = 0.15 // radians
const WAYPOINT_REACHED = 0.7

export class BotBrain {
  private rng: () => number
  private waypoint: Vec2 | null = null
  private seq = 0

  constructor(readonly id: string, seed: number, private skill = 0.45) {
    this.rng = mulberry32(seed)
  }

  think(state: MatchState, map: GameMap): PlayerInput {
    const me = state.players[this.id]
    if (!me || me.hp <= 0) return makeInput(++this.seq)

    const enemy = this.visibleEnemy(me, state, map)
    if (enemy) {
      const trueAngle = Math.atan2(enemy.pos.y - me.pos.y, enemy.pos.x - me.pos.x)
      const noise = (this.rng() - 0.5) * (1 - this.skill) * 0.5
      const desired = wrapAngle(trueAngle + noise)
      const diff = wrapAngle(desired - me.dir)
      const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y)
      return makeInput(++this.seq, {
        turn: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0,
        forward: dist > 5 ? 1 : dist < 2.5 ? -1 : 0,
        strafe: this.rng() < 0.3 ? (this.rng() < 0.5 ? 1 : -1) : 0,
        fire: Math.abs(diff) < AIM_FIRE_CONE && this.rng() < 0.4 + this.skill * 0.4,
      })
    }

    // roam
    if (!this.waypoint || Math.hypot(this.waypoint.x - me.pos.x, this.waypoint.y - me.pos.y) < WAYPOINT_REACHED) {
      this.waypoint = this.randomFloor(map)
    }
    const desired = Math.atan2(this.waypoint.y - me.pos.y, this.waypoint.x - me.pos.x)
    const diff = wrapAngle(desired - me.dir)
    return makeInput(++this.seq, {
      turn: diff > 0.1 ? 1 : diff < -0.1 ? -1 : 0,
      forward: Math.abs(diff) < 1.2 ? 1 : 0,
    })
  }

  private visibleEnemy(me: PlayerState, state: MatchState, map: GameMap): PlayerState | null {
    let best: PlayerState | null = null
    let bestDist = SIGHT_RANGE
    for (const p of Object.values(state.players)) {
      if (p.id === this.id || p.hp <= 0) continue
      const dist = Math.hypot(p.pos.x - me.pos.x, p.pos.y - me.pos.y)
      if (dist >= bestDist) continue
      const angle = Math.atan2(p.pos.y - me.pos.y, p.pos.x - me.pos.x)
      if (castWall(map, me.pos.x, me.pos.y, angle).dist > dist) {
        best = p
        bestDist = dist
      }
    }
    return best
  }

  private randomFloor(map: GameMap): Vec2 {
    for (let i = 0; i < 100; i++) {
      const x = 1 + Math.floor(this.rng() * (map.width - 2))
      const y = 1 + Math.floor(this.rng() * (map.height - 2))
      if (!isWall(map, x, y)) return { x: x + 0.5, y: y + 0.5 }
    }
    return { ...map.railSpawn }
  }
}
