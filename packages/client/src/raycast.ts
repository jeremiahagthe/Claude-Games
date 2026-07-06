import { type GameMap, type MatchState, fnv1a, isWall, wrapAngle, MAX_WALL_DIST } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'
import { applyMuzzleFlash, backgroundColorAt, brickShade, drawSprite, wallBaseColor } from './render-detail.js'
import { SPRITE_FRAMES, pickSpriteDirection, selectFrame } from './sprites/index.js'

export const FOV = Math.PI / 3
// Half the render FOV — the single owner of this value for the whole client.
// intent.ts imports it to map the pointer's normalized x to a fire-direction
// offset, so the crosshair the player points at and the shot agree. Must stay
// ≤ core's AIM_OFFSET_MAX (0.6) or the aim could exceed what makeInput clamps;
// FOV/2 = π/6 ≈ 0.524 ≤ 0.6. (See raycast.test.ts for the pinning test.)
export const RENDER_HALF_FOV = FOV / 2
export { backgroundColorAt } from './render-detail.js'

// Per-frame render-loop inputs that the sim snapshot alone can't carry: the
// wall-clock `now` (drives walk animation), a per-player "moving" flag (derived
// in offline.ts where the last two sim snapshots are both visible), and the
// latest pointer cell (1-based terminal coords) so the crosshair renders where
// the player is aiming. `pointer` is null until the first mouse report.
export interface RenderExtras {
  now: number
  moving: Record<string, boolean>
  pointer?: { x: number; y: number } | null
}

export function renderView(
  fb: FrameBuffer,
  map: GameMap,
  state: MatchState,
  selfId: string,
  flash = 0,
  extras?: RenderExtras,
): void {
  const now = extras?.now ?? 0
  const moving = extras?.moving ?? {}
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
  interface Sprite {
    x: number
    y: number
    blink: boolean
    slim: boolean
    color?: readonly [number, number, number] // slim pillar fill
    frame?: Uint8Array // humanoid: sampled gunner frame
    mirror?: boolean
    tint?: readonly [number, number, number] // per-id identity tint
  }
  const sprites: Sprite[] = []
  for (const p of Object.values(state.players)) {
    if (p.id === selfId || p.hp <= 0) continue
    const h = fnv1a(p.id)
    const choice = pickSpriteDirection(p.dir, p.pos, me.pos)
    const frame = selectFrame(SPRITE_FRAMES[choice.dir], {
      fireCooldown: p.fireCooldown,
      moving: moving[p.id] ?? false,
      now,
    })
    sprites.push({
      x: p.pos.x, y: p.pos.y, slim: false,
      frame, mirror: choice.mirror,
      tint: [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
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
    drawSprite(fb, zbuf, { screenX, y0, size, depth, slim: s.slim, color: s.color, frame: s.frame, mirror: s.mirror, tint: s.tint })
  }

  // Crosshair follows the pointer (cursor aim): the pointer's 1-based terminal
  // cell maps to a framebuffer pixel — x-1 to 0-base the column, and (y-1)*2+1
  // to hit the vertical middle of the cell (each cell is two framebuffer rows).
  // Clamped to keep the 3x3 plus inside the view even when the pointer sits over
  // the HUD rows or off-view. No pointer yet → framebuffer center, as before.
  const pointer = extras?.pointer ?? null
  const ccx = pointer ? Math.max(1, Math.min(fb.w - 2, pointer.x - 1)) : fb.w >> 1
  const ccy = pointer ? Math.max(1, Math.min(fb.h - 2, (pointer.y - 1) * 2 + 1)) : fb.h >> 1
  // Minimal plus (3x3 footprint, down from the previous +-2 5x5 blob): a
  // full-white center pixel with dimmer gray arms at +-1, so it reads as a
  // fine aim point instead of a chunky mark. Feel-8: when the pointer is
  // visible, it IS the one and only cursor — drawing our own on top of it
  // just duplicates it, so skip the plus entirely in that case. The fallback
  // (no pointer seen yet) still draws the center-screen plus as before.
  const center: [number, number] = [ccx, ccy]
  if (!pointer) {
    const arms: Array<[number, number]> = [[ccx - 1, ccy], [ccx + 1, ccy], [ccx, ccy - 1], [ccx, ccy + 1]]
    fb.set(center[0], center[1], 255, 255, 255)
    for (const [px, py] of arms) fb.set(px, py, 170, 170, 170)
  }

  // Only the center point feeds the flash bloom: brightening the dimmer arms
  // by flash*80 pushes them close enough to 255 that 256-color terminals
  // quantize them to the same color code as pure white, erasing the plus
  // shape at the exact moment (firing) it matters most.
  applyMuzzleFlash(fb, flash, [center])
}
