import { describe, expect, it } from 'vitest'
import { FrameBuffer, TermRenderer, rgbTo256 } from '../src/framebuffer.js'

describe('FrameBuffer', () => {
  it('stores pixels', () => {
    const fb = new FrameBuffer(4, 4)
    fb.set(1, 2, 255, 128, 0)
    expect([...fb.px.slice((2 * 4 + 1) * 3, (2 * 4 + 1) * 3 + 3)]).toEqual([255, 128, 0])
  })
})

describe('rgbTo256', () => {
  it('maps primaries into the 6x6x6 cube', () => {
    expect(rgbTo256(255, 0, 0)).toBe(196)
    expect(rgbTo256(0, 0, 255)).toBe(21)
  })
  it('maps grays to the gray ramp', () => {
    const n = rgbTo256(128, 128, 128)
    expect(n).toBeGreaterThanOrEqual(232)
    expect(n).toBeLessThanOrEqual(255)
  })
})

describe('TermRenderer diffing', () => {
  it('first frame paints, identical second frame emits nothing', () => {
    const fb = new FrameBuffer(4, 4) // 4x4 px = 4 cols x 2 text rows
    fb.fill(10, 20, 30)
    const r = new TermRenderer('truecolor')
    const first = r.frame(fb)
    expect(first).toContain('▀') // ▀
    expect(first).toContain('38;2;10;20;30')
    expect(r.frame(fb)).toBe('') // no change, no bytes
  })
  it('single pixel change emits a single cell update', () => {
    const fb = new FrameBuffer(4, 4)
    fb.fill(0, 0, 0)
    const r = new TermRenderer('truecolor')
    r.frame(fb)
    fb.set(2, 0, 255, 255, 255)
    const out = r.frame(fb)
    expect(out).toContain('\x1b[1;3H') // row 1, col 3
    expect(out.split('▀').length - 1).toBe(1)
  })
  it('mono mode renders luminance characters', () => {
    const fb = new FrameBuffer(2, 2)
    fb.fill(255, 255, 255)
    const out = new TermRenderer('mono').frame(fb)
    expect(out).toContain('@')
  })
  it('a horizontal run of changed cells emits one cursor address', () => {
    const fb = new FrameBuffer(6, 2) // 6 cols x 1 text row
    fb.fill(0, 0, 0)
    const r = new TermRenderer('truecolor')
    r.frame(fb)
    for (const x of [2, 3, 4]) fb.set(x, 0, 255, 0, 0) // contiguous run in row 0
    const out = r.frame(fb)
    expect(out.match(/\x1b\[\d+;\d+H/g)).toHaveLength(1) // single address
    expect(out).toContain('\x1b[1;3H') // run starts at row 1, col 3
    expect(out.split('▀').length - 1).toBe(3) // three cells emitted
  })
})
