import { AIM_OFFSET_MAX, MOVE_SPEED, PLAYER_RADIUS, TURN_SPEED } from './constants.js'
import { type GameMap, isWall } from './map.js'
import type { PlayerInput, PlayerState } from './types.js'

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI)
  if (r > Math.PI) r -= 2 * Math.PI
  if (r <= -Math.PI) r += 2 * Math.PI
  return r
}

// Clamps an analog axis to [-1, 1]; non-finite input (NaN, ±Infinity) becomes 0.
function clampAxis(v: number | undefined): number {
  if (v === undefined) return 0
  if (!Number.isFinite(v)) return 0
  return Math.max(-1, Math.min(1, v))
}

// Clamps the cursor-aim offset to ±AIM_OFFSET_MAX; absent/non-finite → 0. Kept
// separate from clampAxis because its range is ±AIM_OFFSET_MAX, not ±1.
function clampAimOffset(v: number | undefined): number {
  if (v === undefined) return 0
  if (!Number.isFinite(v)) return 0
  return Math.max(-AIM_OFFSET_MAX, Math.min(AIM_OFFSET_MAX, v))
}

export function makeInput(seq: number, partial: Partial<Omit<PlayerInput, 'seq'>> = {}): PlayerInput {
  return {
    seq,
    forward: clampAxis(partial.forward),
    strafe: clampAxis(partial.strafe),
    turn: clampAxis(partial.turn),
    fire: partial.fire ?? false,
    aimOffset: clampAimOffset(partial.aimOffset),
  }
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
    // Scale by input magnitude (analog forward/strafe) but never exceed
    // MOVE_SPEED — keeps diagonal movement no faster than straight movement.
    const speed = MOVE_SPEED * Math.min(1, len)
    dx = (dx / len) * speed
    dy = (dy / len) * speed
    if (!collides(map, p.pos.x + dx, p.pos.y)) p.pos.x += dx
    if (!collides(map, p.pos.x, p.pos.y + dy)) p.pos.y += dy
  }
  p.lastInputSeq = input.seq
}
