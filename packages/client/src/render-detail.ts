import { fnv1a } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'
import { FRAME_W, FRAME_H, PALETTE } from './sprites/index.js'

// Background (ceiling/floor) base colors. Raycast tests reference these exact
// values, so keep them stable — only the per-row gradient factor changes.
export const CEIL = [18, 18, 24] as const
export const FLOOR = [38, 36, 34] as const

const WALL_PALETTES: Record<string, readonly [number, number, number]> = {
  legacy_monolith: [150, 120, 95],
  node_modules: [105, 135, 100],
  microservices: [110, 120, 145],
}
const WALL_FALLBACK: readonly [number, number, number] = [140, 120, 100]

export function wallBaseColor(mapId: string): readonly [number, number, number] {
  return WALL_PALETTES[mapId] ?? WALL_FALLBACK
}

/**
 * Multiplicative brightness for a brick texture sampled at wall-local
 * coordinate (u, v) — u = fractional wall-hit position along the wall,
 * v = fractional pixel row within the wall column — within grid cell
 * (cellX, cellY). Darkens mortar lines and applies a small per-brick
 * brightness hash so adjacent bricks aren't perfectly uniform.
 */
export function brickShade(u: number, v: number, cellX: number, cellY: number): number {
  const uu = u - Math.floor(u)
  const vv = v - Math.floor(v)
  const brickRow = Math.floor(vv * 3)
  const rowOffset = brickRow % 2 ? 0.5 : 0
  const horizontalMortar = (vv * 3) % 1 < 0.08
  const verticalMortar = ((uu * 4 + rowOffset) % 1) < 0.06
  const mortar = horizontalMortar || verticalMortar ? 0.55 : 1
  const hash = fnv1a(`${Math.floor(uu * 4)},${brickRow},${cellX},${cellY}`)
  const variance = ((hash % 1000) / 1000 - 0.5) * 0.16 // +-8%
  return mortar * (1 + variance)
}

/**
 * Ceiling/floor background color at framebuffer row y (of height h), with a
 * gradient that darkens toward the horizon (x0.5) and brightens toward the
 * top/bottom edges (full base color).
 */
export function backgroundColorAt(y: number, h: number): [number, number, number] {
  const half = h >> 1
  const base = y < half ? CEIL : FLOOR
  const span = y < half ? half : h - half
  const edgeDist = y < half ? half - y : y - half + 1
  const t = span > 0 ? Math.min(1, edgeDist / span) : 1
  const factor = 0.5 + 0.5 * t
  return [Math.floor(base[0] * factor), Math.floor(base[1] * factor), Math.floor(base[2] * factor)]
}

export interface SpriteDrawSpec {
  screenX: number
  y0: number
  size: number
  depth: number
  slim: boolean // rail pickup: thin pillar, not a humanoid
  // Slim pillar: flat fill color. Humanoid: sampled frame + mirror + per-id tint.
  color?: readonly [number, number, number]
  frame?: Uint8Array
  mirror?: boolean
  tint?: readonly [number, number, number]
}

/**
 * Draws a billboard sprite: a directional/animated gunner frame sampled
 * nearest-neighbor, or a slim pillar for the rail pickup. The wall pass's
 * per-column z-buffer gates which columns are visible.
 */
export function drawSprite(fb: FrameBuffer, zbuf: Float64Array, spec: SpriteDrawSpec): void {
  const { screenX, y0, size, depth, slim } = spec
  if (slim) {
    const color = spec.color ?? [255, 255, 255]
    const w = Math.max(1, Math.floor(size * 0.15))
    for (let col = screenX - (w >> 1); col <= screenX + (w >> 1); col++) {
      if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
      for (let y = y0 + (size >> 3); y < y0 + size; y++) fb.set(col, y, color[0], color[1], color[2])
    }
    return
  }

  const frame = spec.frame
  if (!frame) return
  const tint = spec.tint ?? [255, 255, 255]
  const mirror = spec.mirror ?? false
  // Aspect matches the source cell: width = size * (FRAME_W / FRAME_H) = size/2.
  const width = size * (FRAME_W / FRAME_H)
  const left = screenX - width / 2
  const iw = Math.max(1, Math.round(width))
  const colStart = Math.floor(left)
  // Distance shading and per-id tint (identity in multiplayer). Precompute the
  // combined per-channel multiplier: depth fade × subtle id tint.
  const fade = Math.min(1, Math.max(0.45, 1 - depth * 0.03))
  const mr = fade * (0.7 + (0.3 * tint[0]) / 255)
  const mg = fade * (0.7 + (0.3 * tint[1]) / 255)
  const mb = fade * (0.7 + (0.3 * tint[2]) / 255)
  for (let col = colStart; col < colStart + iw; col++) {
    if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
    let u = Math.floor(((col - left) / width) * FRAME_W)
    if (u < 0) u = 0
    else if (u >= FRAME_W) u = FRAME_W - 1
    if (mirror) u = FRAME_W - 1 - u
    for (let y = y0; y < y0 + size; y++) {
      let v = Math.floor(((y - y0) / size) * FRAME_H)
      if (v < 0) v = 0
      else if (v >= FRAME_H) v = FRAME_H - 1
      const idx = frame[v * FRAME_W + u]!
      if (idx === 0) continue // transparent: leave background/z-buffer untouched
      const [pr, pg, pb] = PALETTE[idx]!
      fb.set(
        col,
        y,
        Math.min(255, Math.floor(pr * mr)),
        Math.min(255, Math.floor(pg * mg)),
        Math.min(255, Math.floor(pb * mb)),
      )
    }
  }
}

/**
 * Brightens the bottom-center region (muzzle flash bloom) and the crosshair
 * pixels by flash*80 per channel, clamped to 255. No-op when flash <= 0.
 */
export function applyMuzzleFlash(
  fb: FrameBuffer,
  flash: number,
  crosshair: ReadonlyArray<readonly [number, number]>,
): void {
  if (flash <= 0) return
  const add = Math.min(255, flash * 80)
  const brighten = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= fb.w || y >= fb.h) return
    const i = (y * fb.w + x) * 3
    fb.px[i] = Math.min(255, fb.px[i]! + add)
    fb.px[i + 1] = Math.min(255, fb.px[i + 1]! + add)
    fb.px[i + 2] = Math.min(255, fb.px[i + 2]! + add)
  }
  const rowStart = fb.h - Math.max(1, Math.floor(fb.h * 0.15))
  const colHalf = Math.max(1, Math.floor(fb.w * 0.15))
  const ccx = fb.w >> 1
  for (let y = rowStart; y < fb.h; y++) {
    for (let x = ccx - colHalf; x <= ccx + colHalf; x++) brighten(x, y)
  }
  for (const [x, y] of crosshair) brighten(x, y)
}
