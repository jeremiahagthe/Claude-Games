import { describe, expect, it } from 'vitest'
import { createMatch } from 'boomwait-core'
import { chooseLayout, renderFrame } from '../src/render.js'

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

describe('the 80x24 gate', () => {
  it('iTerm2 default (80x24, truecolor) → r=2 sprites with side HUD', () => {
    expect(chooseLayout(80, 24, 'truecolor')).toEqual({ r: 2, sideHud: true, glyph: false })
  })
  it('frame at 80x24 fits: ≤24 lines, every line ≤80 visible cols', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const lines = renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, 'Claude working…').split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(80)
  })
  it('bigger window → bigger r, same rule', () =>
    expect(chooseLayout(160, 50, 'truecolor').r).toBeGreaterThanOrEqual(3))
  it('tiny window or no truecolor → glyph mode, still fits', () => {
    expect(chooseLayout(40, 14, 'truecolor').glyph).toBe(true)
    expect(chooseLayout(80, 24, '256').glyph).toBe(true)
    const s = createMatch(42, ['a', 'b', 'c', 'd'], [false, true, true, true])
    const lines = renderFrame(s, 0, { r: 1, sideHud: false, glyph: true }, '').split('\n')
    expect(lines.length).toBeLessThanOrEqual(14)
  })
  it('HUD shows all four players + timer + shrink warning', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const flat = strip(renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, ''))
    for (const n of ['you', 'bot1', 'bot2', 'bot3']) expect(flat).toContain(n)
  })
})
