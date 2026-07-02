import { fnv1a } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'

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
  color: readonly [number, number, number]
  slim: boolean // rail pickup: thin pillar, not a humanoid
}

/** Draws a billboard sprite: a blocky humanoid silhouette, or a slim pillar for the rail pickup. */
export function drawSprite(fb: FrameBuffer, zbuf: Float64Array, spec: SpriteDrawSpec): void {
  const { screenX, y0, size, depth, color, slim } = spec
  if (slim) {
    const w = Math.max(1, Math.floor(size * 0.15))
    for (let col = screenX - (w >> 1); col <= screenX + (w >> 1); col++) {
      if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
      for (let y = y0 + (size >> 3); y < y0 + size; y++) fb.set(col, y, color[0], color[1], color[2])
    }
    return
  }

  const w = Math.max(1, Math.floor(size * 0.4))
  const left = screenX - (w >> 1)
  const right = screenX + (w >> 1)
  const headH = Math.max(1, Math.round(size * 0.22)) // top 22%: head
  const torsoH = Math.max(1, Math.round(size * 0.45)) // next 45%: torso, full width
  // remaining ~33%: legs, two columns with a gap
  for (let col = left; col <= right; col++) {
    if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
    const frac = w > 0 ? (col - left) / w : 0.5 // 0..1 across sprite width
    const edge = col === left || col === right
    const shade = edge ? 0.7 : 1 // outline
    for (let y = y0; y < y0 + size; y++) {
      const localY = y - y0
      let visible: boolean
      if (localY < headH) visible = frac >= 0.225 && frac <= 0.775 // 55% width, centered
      else if (localY < headH + torsoH) visible = true
      else visible = frac < 0.38 || frac > 0.62 // two leg columns
      if (!visible) continue
      fb.set(col, y, Math.floor(color[0] * shade), Math.floor(color[1] * shade), Math.floor(color[2] * shade))
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
