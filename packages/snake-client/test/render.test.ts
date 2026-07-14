import { describe, expect, it } from 'vitest'
import type { MatchState } from 'snakewait-core'
import { createMatch } from 'snakewait-core'
import { chooseLayout, renderFrame, tooSmallScreen } from '../src/render.js'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function baseMatch(): MatchState {
  return createMatch(11, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
}

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  it('exact fit at 80x24: k=1, every line ≤ 80 visible cols, ≤ 23 rows', () => {
    const layout = chooseLayout(80, 24)!
    expect(layout.k).toBe(1)
    const s = createMatch(7, ['jeremiah', 'bot·1', 'bot·2', 'bot·3'], [false, true, true, true])
    const frame = renderFrame(s, 0, layout, 'claude is working…', 'truecolor')
    const lines = frame.split('\n')
    expect(lines.length).toBeLessThanOrEqual(23)
    for (const line of lines) {
      const visible = line.replace(/\[[0-9;]*m/g, '')
      expect(visible.length, JSON.stringify(visible)).toBeLessThanOrEqual(80)
    }
    expect(lines.some((l) => l.includes('jeremiah'))).toBe(true)
  })
  it('window below 80x24 → null layout', () => {
    expect(chooseLayout(79, 24)).toBeNull()
    expect(chooseLayout(80, 23)).toBeNull()
  })
  it('k=2 only at 114x43+', () => {
    expect(chooseLayout(114, 43)!.k).toBe(2)
    expect(chooseLayout(113, 43)!.k).toBe(1)
  })
})

describe('additional render coverage', () => {
  const layout = chooseLayout(80, 24)!

  it('mono mode: no escape sequences, glyph set only', () => {
    const s = baseMatch()
    const frame = renderFrame(s, 0, layout, 'status', 'mono')
    expect(frame).toBe(strip(frame))
    expect(frame).toMatch(/[oxOX+#*@]/) // body/head glyphs for at least one snake
    expect(frame).toContain('█') // walls/border glyph
  })

  it("256 mode: emits '38;5;' and never '38;2;'", () => {
    const s = baseMatch()
    const frame = renderFrame(s, 0, layout, 'status', '256')
    expect(frame).toContain('38;5;')
    expect(frame).not.toContain('38;2;')
  })

  it("a dead snake's corpse-food renders as food", () => {
    const s = baseMatch()
    const dead = { ...s.snakes[0]!, alive: false, cells: [] }
    const state: MatchState = { ...s, snakes: [dead, ...s.snakes.slice(1)], food: [{ x: 0, y: 0 }] }
    const frame = renderFrame(state, 1, layout, '', 'mono')
    const lines = frame.split('\n')
    // line 0 = top border; line 1 = first arena row; col 0 = left border, col 1 = cell x=0.
    expect(lines[1]!.charAt(1)).toBe('.')
  })

  it('closed rings paint wall color at ring cells', () => {
    const s = baseMatch()
    const state: MatchState = {
      ...s,
      rings: 5,
      food: [],
      snakes: s.snakes.map((sn) => ({ ...sn, alive: false, cells: [] })),
    }
    const monoFrame = renderFrame(state, 0, layout, '', 'mono')
    expect(monoFrame.split('\n')[1]!.charAt(1)).toBe('█')

    const trueFrame = renderFrame(state, 0, layout, '', 'truecolor')
    expect(trueFrame.split('\n')[1]).toContain('38;2;90;90;100')
  })
})

describe('tooSmallScreen', () => {
  it('centers the message within the given window', () => {
    const msg = tooSmallScreen(40, 10)
    expect(msg).toContain('snakewait needs 80x24')
    expect(msg.split('\n').length).toBeLessThanOrEqual(10)
  })
})
