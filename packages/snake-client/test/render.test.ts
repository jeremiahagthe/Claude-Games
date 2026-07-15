import { describe, expect, it } from 'vitest'
import type { MatchState } from 'snakewait-core'
import { createMatch } from 'snakewait-core'
import { chooseLayout, renderFrame, tooSmallScreen } from '../src/render.js'

const ESC = '\x1b'
// The line separator renderFrame/tooSmallScreen now use instead of a bare
// '\n' (feel-gate fix round 2: ESC[K moved to the START of each line instead
// of the end. Root cause of the round-1 defect: a trailing ESC[K after an
// exactly-80-visible-column line lands on a terminal that is exactly 80
// columns wide with the cursor in the pending-wrap state at column 80 — the
// erase-to-EOL from THAT position deletes the line's own just-written last
// character. A leading ESC[K erases the row before any content lands, so it
// still kills resize residue to the right on wider terminals, but can never
// interact with the pending-wrap state a full-width line leaves behind).
const FRAME_SEP = `\r\n${ESC}[K`

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

// Strips the frame-level positioning wrapper (leading ESC[H ESC[K, trailing
// optional RESET + ESC[J) added by the feel-gate fix, then splits on the new
// \r\n ESC[K line separator — giving back the same logical line list the
// pre-fix tests pinned via `frame.split('\n')`.
function frameLines(frame: string): string[] {
  const body = frame.replace(/^\x1b\[H\x1b\[K/, '').replace(/(\x1b\[0m)?\x1b\[J$/, '')
  return body.split(FRAME_SEP)
}

function baseMatch(): MatchState {
  return createMatch(11, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
}

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  it('exact fit at 80x24: k=1, every line ≤ 80 visible cols, ≤ 23 rows', () => {
    const layout = chooseLayout(80, 24)!
    expect(layout.k).toBe(1)
    const s = createMatch(7, ['jeremiah', 'bot·1', 'bot·2', 'bot·3'], [false, true, true, true])
    const frame = renderFrame(s, 0, layout, 'claude is working…', 'truecolor')
    const lines = frameLines(frame)
    expect(lines.length).toBeLessThanOrEqual(23)
    for (const line of lines) {
      // The plan's pinned literal was /\[[0-9;]*m/g, which omits the leading
      // \x1b ESC byte and thus counts one phantom column per SGR escape. The
      // SEMANTICS (true visible width after stripping complete escape
      // sequences) are the pin, not the defective literal — corrected here.
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
      expect(visible.length, JSON.stringify(visible)).toBeLessThanOrEqual(80)
    }
    // Padding contract (stronger than the ≤80 gate): the HUD pads every
    // border+arena row to EXACTLY 80 visible cols — that's all 22 rows before
    // the status line (top border, 20 arena rows, bottom border; the HUD
    // sidebar spans the full bordered block). The status row is a
    // caller-supplied string only slice-capped by the renderer, so it stays
    // ≤80, not exactly 80.
    for (let i = 0; i < lines.length - 1; i++) {
      const visible = lines[i]!.replace(/\x1b\[[0-9;]*m/g, '')
      expect(visible.length, `row ${i}: ${JSON.stringify(visible)}`).toBe(80)
    }
    expect(lines.some((l) => l.includes('jeremiah'))).toBe(true)
  })
  it('window below 80x24 → null layout', () => {
    expect(chooseLayout(79, 24)).toBeNull()
    expect(chooseLayout(80, 23)).toBeNull()
  })
  it('k=2 only at 136x43+ (root cause: the 114 pin forgot the 22-col HUD — a k=2 frame is GRID_W*2 + 2 border + 22 HUD = 136 visible cols, not 114)', () => {
    expect(chooseLayout(136, 43)!.k).toBe(2)
    expect(chooseLayout(135, 43)!.k).toBe(1)
  })

  it('exact fit at 136x43: k=2, every border/arena row exactly 136 visible cols', () => {
    const layout = chooseLayout(136, 43)!
    expect(layout.k).toBe(2)
    const s = createMatch(7, ['jeremiah', 'bot·1', 'bot·2', 'bot·3'], [false, true, true, true])
    const frame = renderFrame(s, 0, layout, 'claude is working…', 'truecolor')
    const lines = frameLines(frame)
    // 40 arena rows (GRID_H*k/2 = 40*2/2) + top + bottom border = 42 border/arena
    // rows, plus one status row = 43 total lines — matches the rows>=43 gate exactly.
    expect(lines.length).toBeLessThanOrEqual(43)
    for (let i = 0; i < lines.length - 1; i++) {
      const visible = lines[i]!.replace(/\x1b\[[0-9;]*m/g, '')
      expect(visible.length, `row ${i}: ${JSON.stringify(visible)}`).toBe(136)
    }
  })
})

describe('additional render coverage', () => {
  const layout = chooseLayout(80, 24)!

  it('mono mode: no color escape sequences, glyph set only', () => {
    const s = baseMatch()
    const frame = renderFrame(s, 0, layout, 'status', 'mono')
    // Root cause: the feel-gate fix makes every frame carry positioning
    // escapes (ESC[H / ESC[K / ESC[J) unconditionally, including in mono
    // mode, so the old "frame has zero escapes" pin no longer holds — only
    // SGR color escapes ('...m') are guaranteed absent in mono.
    expect(frame).toBe(strip(frame))
    expect(frame).not.toMatch(/\x1b\[[0-9;]*m/)
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
    const lines = frameLines(frame)
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
    expect(frameLines(monoFrame)[1]!.charAt(1)).toBe('█')

    const trueFrame = renderFrame(state, 0, layout, '', 'truecolor')
    expect(frameLines(trueFrame)[1]).toContain('38;2;90;90;100')
  })
})

describe('tooSmallScreen', () => {
  it('centers the message within the given window', () => {
    const msg = tooSmallScreen(40, 10)
    expect(msg).toContain('snakewait needs 80x24')
    expect(frameLines(msg).length).toBeLessThanOrEqual(10)
  })
})

// Feel-gate fix round 1: the renderer scrolled the terminal because
// renderFrame ended with a bare `lines.join('\n')` — no cursor-positioning
// escapes, so every 50ms paint appended fresh rows below the previous frame
// instead of repainting in place. That fix trailed each line with ESC[K,
// which round 2 found defective: on an exactly-80-column terminal (this
// game's canonical size), writing a full 80-visible-column line leaves the
// cursor in the VT pending-wrap state at column 80, and a trailing ESC[K from
// there erases from the active position INCLUSIVE — deleting the line's own
// just-written 80th column (visible symptom: the HUD hint's trailing "s" was
// eaten). Round 2 moves the clear-to-EOL to the START of each line instead:
// a leading ESC[K erases the row before its content is written, so it still
// kills resize residue to the right on wider terminals, but can never
// interact with the pending-wrap state a full-width line leaves at column 80.
// Pin the raw (pre-strip) escape framing directly, mirroring bomber-client's
// renderFrame contract (packages/bomber-client/src/render.ts:329-334) — note
// bomber-client still uses the trailing-K pattern and carries the same latent
// defect; it is frozen and intentionally not fixed here (see ledger).
describe('frame repaints in place (feel-gate: no terminal scroll, no column-80 erase)', () => {
  const layout = chooseLayout(80, 24)!

  it('renderFrame: starts with ESC[H ESC[K, lines joined by \\r\\n ESC[K, ends with ESC[J', () => {
    const s = baseMatch()
    const frame = renderFrame(s, 0, layout, 'status', 'truecolor')
    expect(frame.startsWith(`${ESC}[H${ESC}[K`)).toBe(true)
    expect(frame.endsWith(`${ESC}[J`)).toBe(true)
    expect(frame).toContain(FRAME_SEP)
    // Every line boundary uses \r\n ESC[K, never a bare '\n' — a lone '\n' not
    // followed by ESC[K would mean a line broke without clearing to EOL.
    const withoutSep = frame.split(FRAME_SEP).join('')
    expect(withoutSep.includes('\n')).toBe(false)
  })

  it('renderFrame: mono mode carries no trailing RESET (no SGR to reset)', () => {
    const s = baseMatch()
    const frame = renderFrame(s, 0, layout, 'status', 'mono')
    expect(frame.endsWith(`${ESC}[J`)).toBe(true)
    expect(frame.endsWith(`${ESC}[0m${ESC}[J`)).toBe(false)
  })

  it('tooSmallScreen: starts with ESC[H ESC[K, lines joined by \\r\\n ESC[K, ends with ESC[J, no RESET (plain text)', () => {
    const msg = tooSmallScreen(40, 10)
    expect(msg.startsWith(`${ESC}[H${ESC}[K`)).toBe(true)
    expect(msg.endsWith(`${ESC}[J`)).toBe(true)
    expect(msg.endsWith(`${ESC}[0m${ESC}[J`)).toBe(false)
    expect(msg).toContain(FRAME_SEP)
  })
})
