import { MOVE_SPEED, PLAYER_RADIUS, TURN_SPEED } from './constants.js'
import { type GameMap, isWall } from './map.js'
import type { PlayerInput, PlayerState } from './types.js'

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI)
  if (r > Math.PI) r -= 2 * Math.PI
  if (r <= -Math.PI) r += 2 * Math.PI
  return r
}

export function makeInput(seq: number, partial: Partial<Omit<PlayerInput, 'seq'>> = {}): PlayerInput {
  return { seq, forward: 0, strafe: 0, turn: 0, fire: false, ...partial }
}

function collides(map: GameMap, x: number, y: number): boolean {
  const r = PLAYER_RADIUS
  const minX = Math.floor(x - r)
  const maxX = Math.floor(x + r)
  const minY = Math.floor(y - r)
  const maxY = Math.floor(y + r)
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!isWall(map, cx, cy)) continue
      // circle vs cell AABB
      const nx = Math.max(cx, Math.min(x, cx + 1))
      const ny = Math.max(cy, Math.min(y, cy + 1))
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true
    }
  }
  return false
}

export function stepPlayer(p: PlayerState, input: PlayerInput, map: GameMap): void {
  p.dir = wrapAngle(p.dir + input.turn * TURN_SPEED)
  let dx = Math.cos(p.dir) * input.forward + Math.cos(p.dir + Math.PI / 2) * input.strafe
  let dy = Math.sin(p.dir) * input.forward + Math.sin(p.dir + Math.PI / 2) * input.strafe
  const len = Math.hypot(dx, dy)
  if (len > 0) {
    dx = (dx / len) * MOVE_SPEED
    dy = (dy / len) * MOVE_SPEED
    if (!collides(map, p.pos.x + dx, p.pos.y)) p.pos.x += dx
    if (!collides(map, p.pos.x, p.pos.y + dy)) p.pos.y += dy
  }
  p.lastInputSeq = input.seq
}
