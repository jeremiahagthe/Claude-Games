import { describe, expect, it } from 'vitest'
import { FRAME_W, FRAME_H, PALETTE, SPRITE_FRAMES, type SpriteDir } from '../src/sprites/gunner-data.js'

const DIRS: SpriteDir[] = ['front', 'front-left', 'left', 'back-left', 'back']

describe('gunner-data (generated)', () => {
  it('exposes all 5 directions with 2 walk frames + 1 fire frame', () => {
    for (const d of DIRS) {
      expect(SPRITE_FRAMES[d].walk).toHaveLength(2)
      expect(SPRITE_FRAMES[d].fire).toBeInstanceOf(Uint8Array)
    }
  })

  it('every frame is exactly FRAME_W*FRAME_H bytes', () => {
    for (const d of DIRS) {
      for (const f of [...SPRITE_FRAMES[d].walk, SPRITE_FRAMES[d].fire]) {
        expect(f.length).toBe(FRAME_W * FRAME_H)
      }
    }
  })

  it('every pixel byte indexes within the palette', () => {
    const maxIdx = PALETTE.length - 1
    for (const d of DIRS) {
      for (const f of [...SPRITE_FRAMES[d].walk, SPRITE_FRAMES[d].fire]) {
        for (const b of f) expect(b).toBeLessThanOrEqual(maxIdx)
      }
    }
  })

  it('palette has at most 32 entries (index 0 transparent + <=31 opaque)', () => {
    expect(PALETTE.length).toBeLessThanOrEqual(32)
    expect(PALETTE[0]).toEqual([0, 0, 0])
  })

  it('back.fire and back-left.fire are the SAME Uint8Array instance (dedup)', () => {
    expect(SPRITE_FRAMES.back.fire).toBe(SPRITE_FRAMES['back-left'].fire)
  })

  it('all four corners of front.walk[0] are transparent (index 0)', () => {
    const f = SPRITE_FRAMES.front.walk[0]
    const corners = [
      0, // top-left
      FRAME_W - 1, // top-right
      (FRAME_H - 1) * FRAME_W, // bottom-left
      (FRAME_H - 1) * FRAME_W + (FRAME_W - 1), // bottom-right
    ]
    for (const c of corners) expect(f[c]).toBe(0)
  })
})
