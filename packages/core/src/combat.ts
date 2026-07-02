import { HIT_RADIUS, MAX_WALL_DIST } from './constants.js'
import { type GameMap, isWall } from './map.js'
import type { MatchState } from './types.js'

// Standard DDA grid traversal (lodev.org raycasting tutorial technique; own code).
export function castWall(map: GameMap, ox: number, oy: number, dir: number): { dist: number; side: 0 | 1 } {
  const dx = Math.cos(dir)
  const dy = Math.sin(dir)
  let cx = Math.floor(ox)
  let cy = Math.floor(oy)
  const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx)
  const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy)
  const stepX = dx < 0 ? -1 : 1
  const stepY = dy < 0 ? -1 : 1
  let sideX = dx < 0 ? (ox - cx) * deltaX : (cx + 1 - ox) * deltaX
  let sideY = dy < 0 ? (oy - cy) * deltaY : (cy + 1 - oy) * deltaY
  let side: 0 | 1 = 0
  for (let i = 0; i < 4 * MAX_WALL_DIST; i++) {
    if (sideX < sideY) {
      sideX += deltaX
      cx += stepX
      side = 0
    } else {
      sideY += deltaY
      cy += stepY
      side = 1
    }
    if (isWall(map, cx, cy)) {
      const dist = side === 0 ? sideX - deltaX : sideY - deltaY
      return { dist: Math.min(dist, MAX_WALL_DIST), side }
    }
  }
  return { dist: MAX_WALL_DIST, side }
}

export function fireHitscan(shooterId: string, state: MatchState, map: GameMap): string | null {
  const shooter = state.players[shooterId]
  if (!shooter) return null
  const ux = Math.cos(shooter.dir)
  const uy = Math.sin(shooter.dir)
  const wallDist = castWall(map, shooter.pos.x, shooter.pos.y, shooter.dir).dist
  let best: { id: string; t: number } | null = null
  for (const p of Object.values(state.players)) {
    if (p.id === shooterId || p.hp <= 0) continue
    const vx = p.pos.x - shooter.pos.x
    const vy = p.pos.y - shooter.pos.y
    const t = vx * ux + vy * uy // distance along the ray
    if (t <= 0 || t >= wallDist) continue
    const perp = Math.abs(vx * -uy + vy * ux) // perpendicular distance to the ray
    if (perp > HIT_RADIUS) continue
    if (!best || t < best.t) best = { id: p.id, t }
  }
  return best?.id ?? null
}
