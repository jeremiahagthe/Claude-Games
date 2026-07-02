import { describe, expect, it } from 'vitest'
import { FrameBuffer } from '../src/framebuffer.js'
import { drawSprite } from '../src/render-detail.js'
import { SPRITE_FRAMES } from '../src/sprites/index.js'

const BG: [number, number, number] = [7, 11, 13]

function fresh(): { fb: FrameBuffer; zbuf: Float64Array } {
  const fb = new FrameBuffer(40, 80)
  fb.fill(BG[0], BG[1], BG[2])
  const zbuf = new Float64Array(40).fill(100) // wall far away: sprite always in front
  return { fb, zbuf }
}

function pixel(fb: FrameBuffer, x: number, y: number): [number, number, number] {
  const i = (y * fb.w + x) * 3
  return [fb.px[i]!, fb.px[i + 1]!, fb.px[i + 2]!]
}

function changedCount(fb: FrameBuffer): number {
  let n = 0
  for (let y = 0; y < fb.h; y++) {
    for (let x = 0; x < fb.w; x++) {
      const [r, g, b] = pixel(fb, x, y)
      if (r !== BG[0] || g !== BG[1] || b !== BG[2]) n++
    }
  }
  return n
}

describe('drawSprite (gunner billboard)', () => {
  // size=80 fills a 40-wide framebuffer exactly: width = size*(40/80) = 40.
  const spec = {
    screenX: 20,
    y0: 0,
    size: 80,
    depth: 1,
    slim: false,
    frame: SPRITE_FRAMES.front.walk[0],
    mirror: false,
    tint: [255, 255, 255] as const,
  }

  it('renders a non-empty figure into the framebuffer for a close sprite', () => {
    const { fb, zbuf } = fresh()
    drawSprite(fb, zbuf, spec)
    expect(changedCount(fb)).toBeGreaterThan(0)
  })

  it('transparent pixels leave the background untouched', () => {
    const { fb, zbuf } = fresh()
    drawSprite(fb, zbuf, spec)
    // The top-left corner of front.walk[0] is transparent (index 0), so that
    // framebuffer pixel must remain the background color.
    expect(pixel(fb, 0, 0)).toEqual(BG)
  })

  it('z-buffer-occluded columns are left untouched', () => {
    const { fb, zbuf } = fresh()
    // Occlude the left half: wall at depth 0 (< sprite depth 1) hides cols 0..19.
    for (let c = 0; c < 20; c++) zbuf[c] = 0
    drawSprite(fb, zbuf, spec)
    for (let y = 0; y < fb.h; y++) {
      for (let x = 0; x < 20; x++) expect(pixel(fb, x, y)).toEqual(BG)
    }
    // The visible right half still drew something.
    let drewRight = false
    for (let y = 0; y < fb.h && !drewRight; y++) {
      for (let x = 20; x < 40; x++) {
        const [r, g, b] = pixel(fb, x, y)
        if (r !== BG[0] || g !== BG[1] || b !== BG[2]) { drewRight = true; break }
      }
    }
    expect(drewRight).toBe(true)
  })

  it('the slim rail-pickup pillar branch still renders a thin fill', () => {
    const { fb, zbuf } = fresh()
    drawSprite(fb, zbuf, { screenX: 20, y0: 0, size: 80, depth: 1, slim: true, color: [80, 220, 255] })
    // Pillar is ~15% of size wide and centered — narrower than the humanoid.
    const changed = changedCount(fb)
    expect(changed).toBeGreaterThan(0)
    expect(changed).toBeLessThan(40 * 80) // not full-frame
  })
})
