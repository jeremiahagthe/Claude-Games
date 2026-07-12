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

// Review fix (Task 9): glyph mode is selected precisely BECAUSE the terminal
// often can't do truecolor (Apple Terminal detects as '256'), so the glyph
// renderer must honor the color mode instead of unconditionally emitting
// 24-bit SGR — mirroring chess board-render.ts's dedicated basic-mode branch.
describe('glyph mode honors the terminal color mode', () => {
  const s = () => createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
  const GLYPH = { r: 1, sideHud: false, glyph: true }

  it("'256' glyph frame: no truecolor SGR, basic SGR colors instead", () => {
    const out = renderFrame(s(), 0, GLYPH, 'Claude working…', '256')
    expect(out).not.toContain('38;2;')
    expect(out).not.toContain('48;2;')
    expect(out).toMatch(/\x1b\[9[0-7]m/) // bright basic fg codes carry teams/entities
  })

  it("'mono' glyph frame: no color escapes at all — letters only", () => {
    const out = renderFrame(s(), 0, GLYPH, 'Claude working…', 'mono')
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/)
    expect(strip(out)).toContain('@1') // players still drawn, as plain letters
  })

  it('mono soft blocks fall back to ASCII (no ▒ shade glyph)', () => {
    const out = strip(renderFrame(s(), 0, GLYPH, '', 'mono'))
    expect(out).not.toContain('▒')
    expect(out).toContain('xx')
  })

  it('truecolor glyph (r<2 tiny-window case) may keep truecolor SGR', () => {
    const out = renderFrame(s(), 0, GLYPH, '', 'truecolor')
    expect(out).toContain('38;2;')
  })

  it('mode defaults to truecolor (the pinned suite calls renderFrame without it)', () => {
    const withDefault = renderFrame(s(), 0, GLYPH, '')
    const explicit = renderFrame(s(), 0, GLYPH, '', 'truecolor')
    expect(withDefault).toBe(explicit)
  })
})

// Final review Fix 3 (spec compliance): the side HUD's ~16 unused rows at
// r=2 must actually carry the spec's full content — per-player bomb/range/
// speed counts and key hints — not just names/clock/shrink, while the
// pinned 80x24-gate block above stays byte-identical and green (same frame-
// fit rule: side HUD width is structurally sliced to SIDE_TEXT_WIDTH).
describe('side HUD spec content (Fix 3)', () => {
  it('shows bomb/range/speed stat counts for all four players', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const flat = strip(renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, ''))
    for (const p of s.players) {
      expect(flat).toContain(`b${p.bombCap}r${p.range}s${p.speed}`)
    }
  })

  it('shows at least one key hint (move/bomb/quit controls)', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const flat = strip(renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, ''))
    expect(flat).toMatch(/wasd/i)
    expect(flat).toMatch(/bomb/i)
    expect(flat).toMatch(/quit/i)
  })

  it('the fuller HUD still fits: ≤24 lines, every line ≤80 visible cols', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const lines = renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, 'Claude working…').split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(80)
  })

  it('a colored swatch does not corrupt the frame: every opened SGR escape on a HUD line is balanced by a reset', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const out = renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, '')
    // Guards against slicing straight through an escape sequence (which would leave a
    // truncated/unbalanced code and bleed color into the next line) — every line that opens
    // a swatch color must also close it before the line ends (ESC[K).
    for (const line of out.split('\x1b[K\r\n')) {
      const opens = (line.match(/\x1b\[(?:38|48);2;\d+;\d+;\d+m|\x1b\[9\dm/g) ?? []).length
      const resets = (line.match(/\x1b\[0m/g) ?? []).length
      if (opens > 0) expect(resets).toBeGreaterThanOrEqual(1)
    }
  })
})
