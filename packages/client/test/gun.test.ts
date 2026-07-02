import { describe, expect, it } from 'vitest'
import { FrameBuffer } from '../src/framebuffer.js'
import { drawGun } from '../src/gun.js'

describe('drawGun', () => {
  it('draws pixels that differ from a blank framebuffer', () => {
    const blank = new FrameBuffer(100, 60)
    const withGun = new FrameBuffer(100, 60)
    drawGun(withGun, 'blaster', 0)
    expect(Buffer.compare(Buffer.from(blank.px), Buffer.from(withGun.px))).not.toBe(0)
  })

  it('recoil changes the rendered pixels', () => {
    const noRecoil = new FrameBuffer(100, 60)
    const withRecoil = new FrameBuffer(100, 60)
    drawGun(noRecoil, 'blaster', 0)
    drawGun(withRecoil, 'blaster', 1)
    expect(Buffer.compare(Buffer.from(noRecoil.px), Buffer.from(withRecoil.px))).not.toBe(0)
  })

  it('rail weapon renders differently than blaster', () => {
    const blaster = new FrameBuffer(100, 60)
    const rail = new FrameBuffer(100, 60)
    drawGun(blaster, 'blaster', 0)
    drawGun(rail, 'rail', 0)
    expect(Buffer.compare(Buffer.from(blaster.px), Buffer.from(rail.px))).not.toBe(0)
  })

  it('is contained near the bottom of the frame and does not touch the top half', () => {
    const fb = new FrameBuffer(100, 60)
    drawGun(fb, 'blaster', 0)
    let topHalfTouched = false
    for (let y = 0; y < fb.h / 2; y++) {
      for (let x = 0; x < fb.w; x++) {
        const i = (y * fb.w + x) * 3
        if (fb.px[i] !== 0 || fb.px[i + 1] !== 0 || fb.px[i + 2] !== 0) topHalfTouched = true
      }
    }
    expect(topHalfTouched).toBe(false)
  })
})
