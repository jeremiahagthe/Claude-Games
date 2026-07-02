import { type GameMap, type MatchState, fnv1a, isWall, wrapAngle, MAX_WALL_DIST } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'
import { applyMuzzleFlash, backgroundColorAt, brickShade, drawSprite, wallBaseColor } from './render-detail.js'

export const FOV = Math.PI / 3
export { backgroundColorAt } from './render-detail.js'

export function renderView(fb: FrameBuffer, map: GameMap, state: MatchState, selfId: string, flash = 0): void {
  const me = state.players[selfId]
  if (!me) return
  for (let y = 0; y < fb.h; y++) {
    const [r, g, b] = backgroundColorAt(y, fb.h)
    for (let x = 0; x < fb.w; x++) fb.set(x, y, r, g, b)
  }

  const zbuf = new Float64Array(fb.w)
  const tanHalf = Math.tan(FOV / 2)
  const wallColor = wallBaseColor(map.id)
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
    // lodev-style wall-hit fractional coordinate, used as the texture u
    const wallX = side === 0 ? me.pos.y + dist * dy : me.pos.x + dist * dx
    const u = wallX - Math.floor(wallX)
    for (let y = y0; y < y0 + wallH; y++) {
      const v = (y - y0) / wallH
      const shade = fade * brickShade(u, v, cx, cy)
      const r = Math.min(255, Math.floor(wallColor[0] * shade))
      const g = Math.min(255, Math.floor(wallColor[1] * shade))
      const b = Math.min(255, Math.floor(wallColor[2] * shade))
      fb.set(col, y, r, g, b)
    }
  }

  // sprites far -> near
  interface Sprite { x: number; y: number; color: readonly [number, number, number]; blink: boolean; slim: boolean }
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
    const y0 = (fb.h - size) >> 1
    drawSprite(fb, zbuf, { screenX, y0, size, depth, color: s.color, slim: s.slim })
  }

  const ccx = fb.w >> 1
  const ccy = fb.h >> 1
  // Minimal plus (3x3 footprint, down from the previous +-2 5x5 blob): a
  // full-white center pixel with dimmer gray arms at +-1, so it reads as a
  // fine aim point instead of a chunky mark.
  const center: [number, number] = [ccx, ccy]
  const arms: Array<[number, number]> = [[ccx - 1, ccy], [ccx + 1, ccy], [ccx, ccy - 1], [ccx, ccy + 1]]
  fb.set(center[0], center[1], 255, 255, 255)
  for (const [px, py] of arms) fb.set(px, py, 170, 170, 170)

  // Only the center point feeds the flash bloom: brightening the dimmer arms
  // by flash*80 pushes them close enough to 255 that 256-color terminals
  // quantize them to the same color code as pure white, erasing the plus
  // shape at the exact moment (firing) it matters most.
  applyMuzzleFlash(fb, flash, [center])
}
