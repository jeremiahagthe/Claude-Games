import { castWall } from './combat.js'
import { AIM_WANDER_TICKS, AIM_WOBBLE, REACTION_TICKS_SCALE, RESIGHT_GAP_TICKS } from './constants.js'
import type { GameMap } from './map.js'
import { isWall } from './map.js'
import { makeInput, wrapAngle } from './movement.js'
import { mulberry32 } from './prng.js'
import type { MatchState, PlayerInput, PlayerState, Vec2 } from './types.js'

const SIGHT_RANGE = 20
const AIM_FIRE_CONE = 0.15 // radians
const WAYPOINT_REACHED = 0.7
const STUCK_WINDOW = 10 // think() calls considered for stuck-recovery
const STUCK_DIST = 0.05 // net cells of movement below which a roaming bot is "stuck"

// Ticks a bot must wait after first sighting an enemy before it's allowed to fire
// (it may still turn toward the enemy during this window). skill 0.3 -> 8 ticks (400ms).
function reactionTicks(skill: number): number {
  return Math.round((1 - skill) * REACTION_TICKS_SCALE)
}

// Floor cells reachable from map.spawns[0] via 4-neighbor flood fill, computed lazily
// once per map and cached by map.id so BotBrain never roams toward walled-off pockets.
// Cell key: y * map.width + x.
const reachableCache = new Map<string, Set<number>>()

function reachableFloor(map: GameMap): Set<number> {
  const cached = reachableCache.get(map.id)
  if (cached) return cached
  const seen = new Set<number>()
  const start = { x: Math.floor(map.spawns[0]!.x), y: Math.floor(map.spawns[0]!.y) }
  const stack: Vec2[] = [start]
  while (stack.length) {
    const { x, y } = stack.pop()!
    if (isWall(map, x, y)) continue
    const key = y * map.width + x
    if (seen.has(key)) continue
    seen.add(key)
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 })
  }
  reachableCache.set(map.id, seen)
  return seen
}

export class BotBrain {
  private rng: () => number
  private waypoint: Vec2 | null = null
  private seq = 0
  private posHistory: Vec2[] = []
  private lastVisibleTick = -Infinity // state.tick this bot last saw any enemy
  private sightingTick = -Infinity // state.tick the current sighting streak began
  private wanderNoise = 0
  private wanderResampleTick = -Infinity

  constructor(readonly id: string, seed: number, private skill = 0.45) {
    this.rng = mulberry32(seed)
  }

  think(state: MatchState, map: GameMap): PlayerInput {
    const me = state.players[this.id]
    if (!me || me.hp <= 0) return makeInput(++this.seq)

    const enemy = this.visibleEnemy(me, state, map)
    if (enemy) {
      this.trackPosition(me.pos)

      // A gap of >= RESIGHT_GAP_TICKS without any visible enemy counts as a fresh
      // sighting (reaction delay restarts); a brief loss of line-of-sight doesn't.
      if (state.tick - this.lastVisibleTick >= RESIGHT_GAP_TICKS) this.sightingTick = state.tick
      this.lastVisibleTick = state.tick
      const reactionElapsed = state.tick - this.sightingTick >= reactionTicks(this.skill)

      // Wander noise is resampled every AIM_WANDER_TICKS ticks and held constant
      // in between, so the bot genuinely points wrong for ~300ms stretches
      // instead of the noise averaging out tick-to-tick.
      if (state.tick - this.wanderResampleTick >= AIM_WANDER_TICKS) {
        this.wanderNoise = (this.rng() - 0.5) * 2 * (1 - this.skill) * AIM_WOBBLE
        this.wanderResampleTick = state.tick
      }

      const trueAngle = Math.atan2(enemy.pos.y - me.pos.y, enemy.pos.x - me.pos.x)
      const desired = wrapAngle(trueAngle + this.wanderNoise)
      const diff = wrapAngle(desired - me.dir)
      const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y)
      return makeInput(++this.seq, {
        turn: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0,
        forward: dist > 5 ? 1 : dist < 2.5 ? -1 : 0,
        strafe: this.rng() < 0.3 ? (this.rng() < 0.5 ? 1 : -1) : 0,
        fire: reactionElapsed && Math.abs(diff) < AIM_FIRE_CONE && this.rng() < 0.15 + this.skill * 0.5,
      })
    }

    // roam
    const stuck = this.trackPosition(me.pos)
    if (
      stuck ||
      !this.waypoint ||
      Math.hypot(this.waypoint.x - me.pos.x, this.waypoint.y - me.pos.y) < WAYPOINT_REACHED
    ) {
      this.waypoint = this.randomFloor(map, me.pos)
      if (stuck) this.posHistory = [] // give the new waypoint a fresh window before re-checking
    }
    const desired = Math.atan2(this.waypoint.y - me.pos.y, this.waypoint.x - me.pos.x)
    const diff = wrapAngle(desired - me.dir)
    return makeInput(++this.seq, {
      turn: diff > 0.1 ? 1 : diff < -0.1 ? -1 : 0,
      forward: Math.abs(diff) < 1.2 ? 1 : 0,
    })
  }

  // Records this tick's position and reports whether the bot has moved less than
  // STUCK_DIST cells of net displacement over the last STUCK_WINDOW think() calls.
  private trackPosition(pos: Vec2): boolean {
    this.posHistory.push({ ...pos })
    if (this.posHistory.length > STUCK_WINDOW) this.posHistory.shift()
    if (this.posHistory.length < STUCK_WINDOW) return false
    const oldest = this.posHistory[0]!
    return Math.hypot(pos.x - oldest.x, pos.y - oldest.y) < STUCK_DIST
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

  // Rejection-samples a reachable floor cell, preferring one within a moderate
  // distance of `from` so a straight-line walk is less likely to thread through
  // several maze turns (and thus less likely to pin the bot against a wall).
  // Keeps the 100-attempt bound; falls back to any reachable cell found, then
  // to the map's rail-pickup cell if nothing reachable was drawn at all.
  private randomFloor(map: GameMap, from: Vec2): Vec2 {
    const reachable = reachableFloor(map)
    const preferredMaxDist = Math.max(map.width, map.height) * 0.25
    let anyReachable: Vec2 | null = null
    for (let i = 0; i < 100; i++) {
      const x = 1 + Math.floor(this.rng() * (map.width - 2))
      const y = 1 + Math.floor(this.rng() * (map.height - 2))
      if (!reachable.has(y * map.width + x)) continue
      const candidate = { x: x + 0.5, y: y + 0.5 }
      if (!anyReachable) anyReachable = candidate
      if (Math.hypot(candidate.x - from.x, candidate.y - from.y) <= preferredMaxDist) return candidate
    }
    return anyReachable ?? { ...map.railSpawn }
  }
}
