import { type GameMap, type MatchState, fnv1a, isWall, wrapAngle, MAX_WALL_DIST } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'

export const FOV = Math.PI / 3

const CEIL = [18, 18, 24] as const
const FLOOR = [38, 36, 34] as const
const WALL = [140, 120, 100] as const

export function renderView(fb: FrameBuffer, map: GameMap, state: MatchState, selfId: string): void {
  const me = state.players[selfId]
  if (!me) return
  const half = fb.h >> 1
  for (let y = 0; y < fb.h; y++) {
    const c = y < half ? CEIL : FLOOR
    for (let x = 0; x < fb.w; x++) fb.set(x, y, c[0], c[1], c[2])
  }

  const zbuf = new Float64Array(fb.w)
  const tanHalf = Math.tan(FOV / 2)
  for (let col = 0; col < fb.w; col++) {
    const camX = (2 * col) / fb.w - 1
    const rayDir = me.dir + Math.atan(camX * tanHalf)
    const dx = Math.cos(rayDir)
    const dy = Math.sin(rayDir)
    let cx = Math.floor(me.pos.x)
    let cy = Math.floor(me.pos.y)
    const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx)
    const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy)
    const stepX = dx < 0 ? -1 : 1
    const stepY = dy < 0 ? -1 : 1
    let sideX = dx < 0 ? (me.pos.x - cx) * deltaX : (cx + 1 - me.pos.x) * deltaX
    let sideY = dy < 0 ? (me.pos.y - cy) * deltaY : (cy + 1 - me.pos.y) * deltaY
    let side: 0 | 1 = 0
    let dist = MAX_WALL_DIST
    for (let i = 0; i < 4 * MAX_WALL_DIST; i++) {
      if (sideX < sideY) { sideX += deltaX; cx += stepX; side = 0 } else { sideY += deltaY; cy += stepY; side = 1 }
      if (isWall(map, cx, cy)) { dist = side === 0 ? sideX - deltaX : sideY - deltaY; break }
    }
    const perp = Math.max(0.01, dist * Math.cos(wrapAngle(rayDir - me.dir)))
    zbuf[col] = perp
    const wallH = Math.min(fb.h, Math.floor(fb.h / perp))
    const y0 = (fb.h - wallH) >> 1
    const fade = Math.max(0.15, 1 - perp / 16) * (side === 1 ? 0.75 : 1)
    const r = Math.floor(WALL[0] * fade)
    const g = Math.floor(WALL[1] * fade)
    const b = Math.floor(WALL[2] * fade)
    for (let y = y0; y < y0 + wallH; y++) fb.set(col, y, r, g, b)
  }

  // sprites far -> near
  interface Sprite { x: number; y: number; color: [number, number, number]; blink: boolean; slim: boolean }
  const sprites: Sprite[] = []
  for (const p of Object.values(state.players)) {
    if (p.id === selfId || p.hp <= 0) continue
    const h = fnv1a(p.id)
    sprites.push({
      x: p.pos.x, y: p.pos.y, slim: false,
      color: [120 + (h & 0x7f), 80 + ((h >> 8) & 0x7f), 80 + ((h >> 16) & 0x7f)],
      blink: p.spawnProtection > 0,
    })
  }
  if (state.rail.present) sprites.push({ x: state.rail.pos.x, y: state.rail.pos.y, color: [80, 220, 255], blink: false, slim: true })
  sprites.sort((a, b) => Math.hypot(b.x - me.pos.x, b.y - me.pos.y) - Math.hypot(a.x - me.pos.x, a.y - me.pos.y))

  for (const s of sprites) {
    if (s.blink && state.tick % 4 < 2) continue
    const rx = s.x - me.pos.x
    const ry = s.y - me.pos.y
    const depth = rx * Math.cos(me.dir) + ry * Math.sin(me.dir)
    if (depth <= 0.2) continue
    const lateral = -rx * Math.sin(me.dir) + ry * Math.cos(me.dir)
    const screenX = Math.floor((fb.w / 2) * (1 + lateral / (depth * tanHalf)))
    const size = Math.min(fb.h, Math.floor(fb.h / depth))
    const w = Math.max(1, Math.floor(size * (s.slim ? 0.15 : 0.4)))
    const y0 = (fb.h - size) >> 1
    for (let col = screenX - (w >> 1); col <= screenX + (w >> 1); col++) {
      if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
      for (let y = y0 + (s.slim ? 0 : size >> 3); y < y0 + size; y++) fb.set(col, y, s.color[0], s.color[1], s.color[2])
    }
  }

  const ccx = fb.w >> 1
  const ccy = fb.h >> 1
  for (const [px, py] of [[ccx, ccy], [ccx - 2, ccy], [ccx + 2, ccy], [ccx, ccy - 2], [ccx, ccy + 2]] as const) {
    fb.set(px, py, 255, 255, 255)
  }
}
