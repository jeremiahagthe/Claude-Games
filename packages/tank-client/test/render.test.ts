import { describe, expect, it } from 'vitest'
import { createMatch } from 'tankwait-core'
import type { MatchState } from 'tankwait-core'
import { chooseLayout, renderFrame, screenRow, tooSmallScreen } from '../src/render.js'
import type { RenderView } from '../src/render.js'

const STRIP = /\x1b\[[0-9;]*[A-Za-z]/g
const frameLines = (f: string) => f.replace(/\x1b\[[HKJ]/g, '').split('\r\n').map((l) => l.replace(STRIP, ''))
const view = (over: Partial<RenderView> = {}): RenderView => ({
  state: createMatch(7, ['jeremiah', 'rival'], [false, true]),
  you: 0, aim: { angle: 60, power: 50 }, phase: 'aim',
  shell: null, trail: [], explosion: null, clockMsLeft: 14_000,
  statusLine: 'claude is working…', ...over,
})

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  it('exact fit at 80x24: 24 lines, EVERY line exactly 80 visible cols', () => {
    const lines = frameLines(renderFrame(view(), chooseLayout(80, 24)!, 'truecolor'))
    expect(lines.length).toBe(24)
    for (const l of lines) expect(l.length, JSON.stringify(l)).toBe(80)
    expect(lines[0]!.includes('jeremiah')).toBe(true)
    expect(lines[0]!.includes('rival')).toBe(true)
  })
  it('below 80x24 → null layout; bigger stays k=1', () => {
    expect(chooseLayout(79, 24)).toBeNull(); expect(chooseLayout(80, 23)).toBeNull()
    expect(chooseLayout(200, 60)).not.toBeNull()
  })
  it('raw positional framing: ESC[H home, ESC[K at line START, ESC[J tail', () => {
    const frame = renderFrame(view(), chooseLayout(80, 24)!, 'truecolor')
    expect(frame.startsWith('\x1b[H\x1b[K')).toBe(true)
    expect(frame.includes('\r\n\x1b[K')).toBe(true)
    expect(frame.endsWith('\x1b[J')).toBe(true)
    const tooSmall = tooSmallScreen(79, 24)
    expect(tooSmall.startsWith('\x1b[H\x1b[K')).toBe(true); expect(tooSmall.endsWith('\x1b[J')).toBe(true)
  })
  it('color tiers: mono has zero escapes beyond framing; 256 uses 38;5; never 38;2;', () => {
    const mono = renderFrame(view(), chooseLayout(80, 24)!, 'mono').replace(/\x1b\[[HKJ]/g, '')
    expect(mono.includes('\x1b')).toBe(false)
    const c256 = renderFrame(view(), chooseLayout(80, 24)!, '256')
    expect(c256.includes('38;5;')).toBe(true); expect(c256.includes('38;2;')).toBe(false)
  })
  it('world→screen: screenRow maps floor to 22, top band to 2; shell above 41.5 is clipped', () => {
    expect(screenRow(0)).toBe(22); expect(screenRow(1)).toBe(22)
    expect(screenRow(2)).toBe(21); expect(screenRow(41)).toBe(2)
    const flying = renderFrame(view({ phase: 'anim', shell: [40, 60], clockMsLeft: null }), chooseLayout(80, 24)!, 'mono')
    expect(frameLines(flying).some((l) => l.includes('●'))).toBe(false)
  })
})

describe('additional render tests', () => {
  it('terrain column height: heights[5] = 10 fills rows 17..22 of col 5, blank above', () => {
    const state = createMatch(7, ['jeremiah', 'rival'], [false, true])
    state.heights[5] = 10
    const lines = frameLines(renderFrame(view({ state }), chooseLayout(80, 24)!, 'mono'))
    for (let row = 2; row <= 22; row++) {
      const ch = lines[row]![5]
      if (row >= 17) expect(ch, `row ${row}`).toBe('█')
      else expect(ch, `row ${row}`).not.toBe('█')
    }
  })

  it('both tank glyphs appear on their columns', () => {
    const state = createMatch(7, ['jeremiah', 'rival'], [false, true])
    const lines = frameLines(renderFrame(view({ state }), chooseLayout(80, 24)!, 'mono'))
    const [t0, t1] = state.tanks
    const row0 = screenRow(state.heights[t0.col]!)
    const row1 = screenRow(state.heights[t1.col]!)
    expect(lines[row0]!.slice(t0.col, t0.col + 2)).toBe('▟▙')
    expect(lines[row1]!.slice(t1.col, t1.col + 2)).toBe('◢◣')
  })

  it('shell at [40, 20] renders ● at row 12 col 40 during anim', () => {
    const state = createMatch(7, ['jeremiah', 'rival'], [false, true])
    const lines = frameLines(
      renderFrame(view({ state, phase: 'anim', shell: [40, 20], clockMsLeft: null }), chooseLayout(80, 24)!, 'mono'),
    )
    expect(screenRow(20)).toBe(12)
    expect(lines[12]![40]).toBe('●')
  })

  it('trail points render · at their cells', () => {
    const state = createMatch(7, ['jeremiah', 'rival'], [false, true])
    const lines = frameLines(
      renderFrame(
        view({ state, phase: 'anim', shell: [45, 18], trail: [[30, 22], [35, 20]], clockMsLeft: null }),
        chooseLayout(80, 24)!,
        'mono',
      ),
    )
    expect(lines[screenRow(22)]![30]).toBe('·')
    expect(lines[screenRow(20)]![35]).toBe('·')
  })

  it('explosion frame 3 renders ✶ marks', () => {
    const state = createMatch(7, ['jeremiah', 'rival'], [false, true])
    const frame = renderFrame(
      view({ state, phase: 'anim', explosion: { x: 40, y: 20, frame: 3 }, clockMsLeft: null }),
      chooseLayout(80, 24)!,
      'mono',
    )
    expect(frame.includes('✶')).toBe(true)
  })

  it('wind line shows ◀ arrows for negative wind and — calm — for 0', () => {
    const negState = createMatch(7, ['jeremiah', 'rival'], [false, true])
    negState.wind = -7
    const negLines = frameLines(renderFrame(view({ state: negState }), chooseLayout(80, 24)!, 'mono'))
    expect(negLines[1]!.includes('◀')).toBe(true)

    const calmState = createMatch(7, ['jeremiah', 'rival'], [false, true])
    calmState.wind = 0
    const calmLines = frameLines(renderFrame(view({ state: calmState }), chooseLayout(80, 24)!, 'mono'))
    expect(calmLines[1]!.includes('— calm —')).toBe(true)
  })

  it('hp bar length tracks hp: 100 → 10 filled cells, 45 → 4-or-5 by the pinned rounding', () => {
    // Left segment (tank 0's HUD block) is the first 34 columns of line 0.
    const state100 = createMatch(7, ['jeremiah', 'rival'], [false, true])
    const lines100 = frameLines(renderFrame(view({ state: state100 }), chooseLayout(80, 24)!, 'mono'))
    expect((lines100[0]!.slice(0, 34).match(/█/g) ?? []).length).toBe(10)

    const state45: MatchState = createMatch(7, ['jeremiah', 'rival'], [false, true])
    state45.tanks[0]!.hp = 45
    const lines45 = frameLines(renderFrame(view({ state: state45 }), chooseLayout(80, 24)!, 'mono'))
    const filled45 = (lines45[0]!.slice(0, 34).match(/█/g) ?? []).length
    expect(filled45).toBe(5)
  })

  it('hp bar/number never truncate under 24-char names — the name yields instead', () => {
    const longName = 'x'.repeat(24) // already sanitized (lowercase alnum)
    for (const [hp0, hp1] of [[7, 100], [100, 7]] as const) {
      const state = createMatch(7, [longName, longName], [false, true])
      state.tanks[0]!.hp = hp0
      state.tanks[1]!.hp = hp1
      const lines = frameLines(renderFrame(view({ state }), chooseLayout(80, 24)!, 'mono'))
      const line0 = lines[0]!
      expect(line0.length).toBe(80)
      const left = line0.slice(0, 34)
      const right = line0.slice(46)
      // full 10-cell hp bar present on both sides (filled + empty cells sum to 10)
      const barCells = (s: string) => (s.match(/[█░]/g) ?? []).length
      expect(barCells(left), `left ${JSON.stringify(left)}`).toBe(10)
      expect(barCells(right), `right ${JSON.stringify(right)}`).toBe(10)
      // exact hp digits present on both sides
      expect(left.includes(` ${hp0}`), `left hp ${hp0} in ${JSON.stringify(left)}`).toBe(true)
      expect(right.includes(`${hp1} `), `right hp ${hp1} in ${JSON.stringify(right)}`).toBe(true)
    }
  })

  it('clockMsLeft 14_000 renders 0:14', () => {
    const lines = frameLines(renderFrame(view({ clockMsLeft: 14_000 }), chooseLayout(80, 24)!, 'mono'))
    expect(lines[1]!.includes('0:14')).toBe(true)
  })
})
