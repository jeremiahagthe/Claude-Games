import { describe, expect, it } from 'vitest'
import { BLASTER_COOLDOWN_TICKS, type Vec2 } from '@fragwait/core'
import { SPRITE_FRAMES, WALK_PERIOD_MS, pickSpriteDirection, selectFrame } from '../src/sprites/index.js'

const P = (x: number, y: number): Vec2 => ({ x, y })

describe('pickSpriteDirection — worked geometric examples', () => {
  // Soldier fixed at (5,5). dir=0 means facing +x. rel = wrapAngle(dir - bearing
  // (sprite→camera)); rel=0 ⇒ front, |rel|=π ⇒ back. Stored frames are the
  // viewer's-LEFT facings; mirror when rel<0 (soldier faces the viewer's right).
  const s = P(5, 5)

  it('camera dead in front → front, no mirror', () => {
    // cam at (10,5): bearing 0, rel 0.
    expect(pickSpriteDirection(0, s, P(10, 5))).toEqual({ dir: 'front', mirror: false })
  })

  it('camera dead behind → back, no mirror', () => {
    // cam at (0,5): bearing π, rel = -π → |rel|=π.
    expect(pickSpriteDirection(0, s, P(0, 5))).toEqual({ dir: 'back', mirror: false })
  })

  it('profile, rel = +π/2 (cam at (5,0)) → left, NOT mirrored', () => {
    // bearing = atan2(-5,0) = -π/2, rel = +π/2. Soldier (facing +x) is seen
    // aiming toward the viewer's left, so the stored left frame is used as-is.
    expect(pickSpriteDirection(0, s, P(5, 0))).toEqual({ dir: 'left', mirror: false })
  })

  it('profile, rel = -π/2 (cam at (5,10)) → left, mirrored', () => {
    // bearing = atan2(5,0) = +π/2, rel = -π/2. Soldier aims toward the viewer's
    // right, so the stored left frame is horizontally mirrored.
    expect(pickSpriteDirection(0, s, P(5, 10))).toEqual({ dir: 'left', mirror: true })
  })

  it('quarter, rel = +π/4 (cam at (6,4)) → front-left, not mirrored', () => {
    expect(pickSpriteDirection(0, s, P(6, 4))).toEqual({ dir: 'front-left', mirror: false })
  })

  it('quarter, rel = -π/4 (cam at (6,6)) → front-left, mirrored', () => {
    expect(pickSpriteDirection(0, s, P(6, 6))).toEqual({ dir: 'front-left', mirror: true })
  })

  it('boundary |rel| = π/8 belongs to the outer (front-left) bucket', () => {
    // dir = π/8, cam straight ahead (bearing 0) → rel = π/8 exactly.
    expect(pickSpriteDirection(Math.PI / 8, s, P(10, 5))).toEqual({ dir: 'front-left', mirror: false })
  })
})

describe('selectFrame', () => {
  const front = SPRITE_FRAMES.front

  it('fire overrides walk while blaster is on recent cooldown', () => {
    const f = selectFrame(front, { fireCooldown: BLASTER_COOLDOWN_TICKS, moving: true, now: 0 })
    expect(f).toBe(front.fire)
  })

  it('fire threshold uses the imported BLASTER_COOLDOWN_TICKS constant', () => {
    const threshold = BLASTER_COOLDOWN_TICKS - 2
    expect(selectFrame(front, { fireCooldown: threshold, moving: false, now: 0 })).toBe(front.fire)
    // one tick below threshold: back to walk/idle
    expect(selectFrame(front, { fireCooldown: threshold - 1, moving: false, now: 0 })).toBe(front.walk[0])
  })

  it('moving alternates walk[0]/walk[1] on a 220 ms period', () => {
    const opts = (now: number) => ({ fireCooldown: 0, moving: true, now })
    expect(selectFrame(front, opts(0))).toBe(front.walk[0])
    expect(selectFrame(front, opts(WALK_PERIOD_MS - 1))).toBe(front.walk[0])
    expect(selectFrame(front, opts(WALK_PERIOD_MS))).toBe(front.walk[1])
    expect(selectFrame(front, opts(2 * WALK_PERIOD_MS))).toBe(front.walk[0])
  })

  it('idle (not moving, not firing) shows walk[0]', () => {
    expect(selectFrame(front, { fireCooldown: 0, moving: false, now: 12345 })).toBe(front.walk[0])
  })
})
