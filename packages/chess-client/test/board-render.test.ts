import { describe, expect, it } from 'vitest'
import { initialState } from 'checkwait-core'
import type { ChessState } from 'checkwait-core'
import { cellToSquare, renderBoard, type RenderOpts } from '../src/board-render.js'

function strip(s: string): string {
  // CSI SGR, cursor-home/clear (ESC[H / ESC[J / ESC[K), and OSC sequences
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mHJK]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

function baseOpts(overrides: Partial<RenderOpts> = {}): RenderOpts {
  return {
    state: initialState(),
    selfColor: 'w',
    selected: null,
    legalTargets: [],
    lastMove: null,
    cursor: null,
    colorMode: 'truecolor',
    cols: 80,
    rows: 30,
    ...overrides,
  }
}

describe('renderBoard', () => {
  it('contains both clock strings for the start position (both sides at 3:00, white to move)', () => {
    const out = renderBoard(baseOpts())
    expect(out).toContain('● 3:00')
    expect(out).toContain('○ 3:00')
  })

  // feel-1: side is carried by explicit piece foreground colors.
  // feel chess-3: truecolor WIDE pieces are half-block PIXEL SPRITES that
  // fill their square — no font glyph can be bigger than the font, so the
  // glyph sets (filled included) are retired in this mode.
  const WHITE_FG = '\x1b[38;2;255;255;255m'
  const BLACK_FG = '\x1b[38;2;20;20;20m'

  it('renders half-block sprite pieces with per-side foregrounds (truecolor WIDE)', () => {
    const out = renderBoard(baseOpts())
    expect(out).toMatch(/[▀▄█]/)
    expect(out).not.toContain('♚') // glyphs retired in sprite mode (feel chess-3)
    expect(out).not.toContain('♔')
    expect(out).toContain(WHITE_FG)
    expect(out).toContain(BLACK_FG)
  })

  it('sprites span multiple rows of their square (pieces fill the cell, not one text row)', () => {
    const out = renderBoard(baseOpts())
    const blockLines = strip(out)
      .split('\r\n')
      .filter((l) => /[▀▄█]/.test(l))
    // 4 piece ranks x 3 subrows = up to 12 lines carry sprite pixels; the
    // old glyph renderer put pieces on exactly 4 (one middle row per rank).
    expect(blockLines.length).toBeGreaterThan(4)
  })

  it('renders letter pieces in basic mode (uppercase = white)', () => {
    const out = strip(renderBoard(baseOpts({ colorMode: 'basic' })))
    expect(out).toContain('K')
    expect(out).toContain('k')
  })

  // Orientation is asserted via piece FOREGROUNDS now that both sides share
  // the filled glyph set (feel-1): the first piece drawn top-left is black's
  // back rank for white, white's for black.
  it('white perspective: black pieces (rank 8) are drawn above white pieces (rank 1)', () => {
    const out = renderBoard(baseOpts({ selfColor: 'w' }))
    expect(out.indexOf(BLACK_FG)).toBeLessThan(out.indexOf(WHITE_FG))
  })

  it('black perspective: the board is flipped — white pieces now drawn above black pieces', () => {
    const out = renderBoard(baseOpts({ selfColor: 'b' }))
    expect(out.indexOf(WHITE_FG)).toBeLessThan(out.indexOf(BLACK_FG))
  })

  it('emits the pinned selected-square SGR background (#7d8f4d — mid-tone so white pieces stay visible)', () => {
    const out = renderBoard(baseOpts({ selected: 12 })) // e2
    expect(out).toContain('\x1b[48;2;125;143;77m')
  })

  it('emits the pinned legal-target SGR background and a dot marker for legal target squares', () => {
    const out = renderBoard(baseOpts({ legalTargets: [28] })) // e4, empty square
    expect(out).toContain('\x1b[48;2;130;151;105m')
    expect(out).toContain('\x1b[38;2;235;235;235m') // legal-dot sprite fg (feel chess-3)
  })

  it('emits the pinned last-move SGR background (#a3a84f) for from/to squares', () => {
    const out = renderBoard(baseOpts({ lastMove: { from: 12, to: 28 } }))
    expect(out).toContain('\x1b[48;2;163;168;79m')
  })

  // feel chess-4d: default terminals are wide but short (iTerm2 opens at
  // 80x24 — the 24-row sprite board + ANY below-board HUD line can't fit),
  // so with horizontal room the HUD sits BESIDE the board's top rows.
  it('side HUD at 80x24 (iTerm2 default): sprites, board uses every row, HUD top-right', () => {
    const out = renderBoard(baseOpts({ cols: 80, rows: 24, opponentHandle: 'bot·easy' }))
    const stripped = strip(out).split('\r\n')
    expect(stripped.length).toBe(24) // board only — no HUD rows below
    expect(out).toMatch(/[▀▄█]/)
    expect(stripped[0]).toContain('● 3:00') // clock beside rank 8
    expect(stripped[2]).toContain('vs bot·easy')
    expect(stripped[4]?.length).toBe(48) // rows past the HUD are pure board
  })

  it('side HUD is preferred whenever it fits — 80x30 renders 24 lines, clock on the first', () => {
    const out = renderBoard(baseOpts())
    const stripped = strip(out).split('\r\n')
    expect(stripped.length).toBe(24)
    expect(stripped[0]).toContain('● 3:00')
  })

  // The below-board ladder still serves narrow-but-tall windows where the
  // side HUD has no room (feel chess-4b/4c rungs).
  it('narrow-tall window: HUD collapses to 2 lines below the board (50x27)', () => {
    const out = renderBoard(baseOpts({ cols: 50, rows: 27, opponentHandle: 'bot·easy' }))
    const stripped = strip(out).split('\r\n')
    expect(stripped.length).toBe(26) // 8*3 board + 2 HUD
    expect(out).toMatch(/[▀▄█]/)
    expect(stripped.some((l) => l.includes('● 3:00') && l.includes('vs bot·easy'))).toBe(true)
  })

  it('compact HUD: status line wins over SAN history on the second line', () => {
    const out = strip(renderBoard(baseOpts({ cols: 50, rows: 27, sanHistory: ['e4'], statusLine: '> h' })))
    expect(out).toContain('> h')
    expect(out).not.toContain('e4')
  })

  it('narrow-tall window: HUD collapses to 1 line below the board (50x25)', () => {
    const out = renderBoard(baseOpts({ cols: 50, rows: 25, opponentHandle: 'bot·easy', statusLine: '> h' }))
    const stripped = strip(out).split('\r\n')
    expect(stripped.length).toBe(25) // 8*3 board + 1 HUD
    const hud = stripped[24]
    expect(hud).toContain('● 3:00')
    expect(hud).toContain('> h')
    expect(hud).not.toContain('vs bot·easy') // status outranks the opponent tail
  })

  it('falls back to 4x2 glyph cells when no layout can fit sprites', () => {
    const out = renderBoard(baseOpts({ cols: 100, rows: 23 })) // floor(23/8) < 3 even with the side HUD
    const lines = strip(out).split('\r\n')
    expect(lines.some((l) => l.length === 32)).toBe(true)
    expect(lines.some((l) => l.length === 48)).toBe(false)
  })

  // feel chess-3: squares grow with the terminal (cw = 2*ch, visually
  // square) so sprites get bigger the more room there is — capped at 16x8.
  it('scales squares up on a big terminal (130x44 → 10x5 cells, 80-wide board lines)', () => {
    const out = renderBoard(baseOpts({ cols: 130, rows: 44 }))
    const lines = strip(out).split('\r\n')
    expect(lines.some((l) => l.length === 80)).toBe(true) // 8 * cw=10
    expect(lines.length).toBe(40) // 8 * ch=5, side HUD — no rows below the board
  })

  it('caps square growth at 16x8 cells on huge terminals', () => {
    const out = renderBoard(baseOpts({ cols: 400, rows: 200 }))
    const lines = strip(out).split('\r\n')
    expect(lines.length).toBe(64) // 8 * ch=8
    expect(lines.filter((l) => l.length === 128).length).toBeGreaterThan(50) // 8 * cw=16; top rows carry the side HUD
  })

  it('sprite mode never emits VT100 line attributes (feel chess-2 DECDHL retired)', () => {
    const out = renderBoard(baseOpts())
    expect(out).not.toContain('\x1b#')
  })

  // feel chess-4 hardening: resize residue and sprite-mode cursor.
  it('every line ends with clear-to-EOL so a narrowing frame leaves no right-side residue', () => {
    const out = renderBoard(baseOpts())
    expect(out).toContain('\x1b[K\r\n')
    // one ESC[K per line boundary (24 board lines at 80x30 side-HUD → 23 joins)
    expect(out.split('\x1b[K\r\n').length).toBe(24)
  })

  it('sprite-mode cursor lifts the square background instead of underlining (no streaks)', () => {
    const out = renderBoard(baseOpts({ cursor: 0 })) // a1, dark square [122,79,40]
    expect(out).not.toContain('\x1b[4;48') // underline attr retired in sprite mode
    expect(out).toContain('\x1b[48;2;158;115;76m') // DARK + 36 lift
  })

  it('shows the enlarge-window hint in truecolor NARROW when no status line is set', () => {
    const narrow = strip(renderBoard(baseOpts({ cols: 59, rows: 22 })))
    expect(narrow).toContain('enlarge the window for bigger pieces')
    const wide = strip(renderBoard(baseOpts()))
    expect(wide).not.toContain('enlarge')
    const withStatus = strip(renderBoard(baseOpts({ cols: 59, rows: 22, statusLine: '> h' })))
    expect(withStatus).not.toContain('enlarge')
  })

  it('truncates HUD lines to the terminal width (a wrapped line would scroll the frame)', () => {
    const out = strip(renderBoard(baseOpts({ cols: 60, rows: 30, opponentHandle: 'x'.repeat(200) })))
    for (const l of out.split('\r\n')) expect(l.length).toBeLessThan(60)
  })

  it('never emits more lines than the terminal has rows', () => {
    const out = renderBoard(baseOpts({ cols: 100, rows: 28 }))
    expect(strip(out).split('\r\n').length).toBeLessThanOrEqual(28)
    const narrow = renderBoard(baseOpts({ cols: 59, rows: 18 }))
    expect(strip(narrow).split('\r\n').length).toBeLessThanOrEqual(18)
  })

  it('emits the pinned check SGR background (#e05252) on the checked king square', () => {
    // Minimal manual check setup: clear the f2 pawn (g3 is already empty in
    // the start position) and put a black queen on h4, giving check to the
    // white king on e1 along the open h4-g3-f2-e1 diagonal.
    const state: ChessState = {
      ...initialState(),
      board: (() => {
        const b = initialState().board.slice()
        b[13] = null // f2
        b[31] = { type: 'q', color: 'b' } // h4
        return b
      })(),
      turn: 'w',
    }
    const out = renderBoard(baseOpts({ state }))
    expect(out).toContain('\x1b[48;2;224;82;82m')
  })

  it('uses 6x3 cells (48-wide board lines) when space allows', () => {
    const out = renderBoard(baseOpts({ cols: 80, rows: 30 }))
    const lines = strip(out).split('\r\n')
    // one of the board rows (not HUD) should be exactly 48 visible chars wide
    expect(lines.some((l) => l.length === 48)).toBe(true)
  })

  it('falls back to 4x2 cells (32-wide board lines) below the 60x22 threshold', () => {
    const out = renderBoard(baseOpts({ cols: 59, rows: 22 }))
    const lines = strip(out).split('\r\n')
    expect(lines.some((l) => l.length === 32)).toBe(true)
    expect(lines.some((l) => l.length === 48)).toBe(false)
  })

  it('the render string is home-cursor based (starts with CSI H)', () => {
    expect(renderBoard(baseOpts()).startsWith('\x1b[H')).toBe(true)
  })

  it('renders the opponent handle line when provided, blank when omitted', () => {
    const withHandle = strip(renderBoard(baseOpts({ opponentHandle: 'bot·easy' })))
    expect(withHandle).toContain('vs bot·easy')
    const without = strip(renderBoard(baseOpts()))
    expect(without).not.toContain('vs ')
  })

  it('renders the status line when provided (e.g. Claude-attention banner text)', () => {
    const out = strip(renderBoard(baseOpts({ statusLine: '✔ Claude is done' })))
    expect(out).toContain('✔ Claude is done')
  })

  it('renders the last ~8 SAN moves when sanHistory is provided, omitting the line when empty/absent', () => {
    const out = strip(renderBoard(baseOpts({ sanHistory: ['e4', 'e5', 'Nf3'] })))
    expect(out).toContain('e4 e5 Nf3')

    const withoutHistory = strip(renderBoard(baseOpts()))
    const withEmptyHistory = strip(renderBoard(baseOpts({ sanHistory: [] })))
    expect(withoutHistory).toBe(withEmptyHistory)
  })

  it('truncates sanHistory display to the last 8 entries', () => {
    const moves = Array.from({ length: 12 }, (_, i) => `m${i}`)
    const out = strip(renderBoard(baseOpts({ sanHistory: moves })))
    expect(out).toContain(moves.slice(-8).join(' '))
    expect(out).not.toContain('m0 ')
  })
})

describe('cellToSquare', () => {
  it('maps the bottom-left cell to a1 for white (6x3 geometry)', () => {
    // bottom-left board row is subRow index 7 (0-based) * ch=3 => y starts at 22 (1-based 23)
    expect(cellToSquare(1, 23, 80, 30, 'w')).toBe(0) // a1 = sq(0,0) = 0
  })

  it('maps the top-left cell to a8 for white', () => {
    expect(cellToSquare(1, 1, 80, 30, 'w')).toBe(56) // a8 = rank7*8+file0 = 56
  })

  it('flips for black: top-left cell is now h1', () => {
    expect(cellToSquare(1, 1, 80, 30, 'b')).toBe(7) // h1 = rank0*8+file7 = 7
  })

  it('returns null outside the drawn board area', () => {
    expect(cellToSquare(200, 200, 80, 30, 'w')).toBeNull()
  })
})
