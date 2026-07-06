import { BLASTER_COOLDOWN_TICKS, wrapAngle, type Vec2 } from 'fragwait-core'
import { SPRITE_FRAMES, FRAME_W, FRAME_H, PALETTE, type SpriteDir } from './gunner-data.js'

export { SPRITE_FRAMES, FRAME_W, FRAME_H, PALETTE }
export type { SpriteDir }

// Render-local constant (input-shaping / animation), intentionally NOT a game
// constant — it never affects simulation, only how billboards animate.
export const WALK_PERIOD_MS = 220

// |rel| sector boundaries (radians) — front / front-quarter / profile /
// rear-quarter / back. Boundaries belong to the outer (higher-|rel|) bucket.
const B_FRONT = Math.PI / 8
const B_QUARTER = (3 * Math.PI) / 8
const B_PROFILE = (5 * Math.PI) / 8
const B_REAR = (7 * Math.PI) / 8

export interface SpriteChoice {
  dir: SpriteDir
  mirror: boolean
}

/**
 * Doom-style directional frame selection.
 *
 * `rel = wrapAngle(spriteDir - bearing(sprite→camera))` is the soldier's facing
 * relative to the line from the soldier to the camera: rel = 0 ⇒ the soldier
 * faces the camera dead-on (front); |rel| = π ⇒ back.
 *
 * Mirror derivation (see report): the camera's screen-right world axis has angle
 * `bearing - π/2`, so the soldier's facing projected onto screen-right has sign
 * `sign(cos(spriteDir - (bearing - π/2))) = sign(-sin(rel))`. Thus:
 *   rel > 0 (sin rel > 0) ⇒ soldier faces the viewer's LEFT ⇒ stored frame as-is.
 *   rel < 0 (sin rel < 0) ⇒ soldier faces the viewer's RIGHT ⇒ mirror horizontally.
 * Front and back are head-on, so they never mirror.
 */
export function pickSpriteDirection(spriteDir: number, spritePos: Vec2, camPos: Vec2): SpriteChoice {
  const bearing = Math.atan2(camPos.y - spritePos.y, camPos.x - spritePos.x)
  const rel = wrapAngle(spriteDir - bearing)
  const a = Math.abs(rel)
  const mirror = rel < 0
  if (a < B_FRONT) return { dir: 'front', mirror: false }
  if (a < B_QUARTER) return { dir: 'front-left', mirror }
  if (a < B_PROFILE) return { dir: 'left', mirror }
  if (a < B_REAR) return { dir: 'back-left', mirror }
  return { dir: 'back', mirror: false }
}

export interface FrameOpts {
  fireCooldown: number
  moving: boolean
  now: number
}

/**
 * Frame within a direction: fire (highest priority) → walk cycle → idle.
 * Fire is active while the blaster is still on cooldown from a recent shot
 * (within 2 ticks of the fresh-fire cooldown value).
 */
export function selectFrame(
  frames: { walk: [Uint8Array, Uint8Array]; fire: Uint8Array },
  opts: FrameOpts,
): Uint8Array {
  if (opts.fireCooldown >= BLASTER_COOLDOWN_TICKS - 2) return frames.fire
  if (opts.moving) return frames.walk[Math.floor(opts.now / WALK_PERIOD_MS) % 2]!
  return frames.walk[0]
}
