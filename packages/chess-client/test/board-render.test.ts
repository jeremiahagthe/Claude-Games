import { describe, expect, it } from 'vitest'
import { initialState } from 'checkwait-core'
import type { ChessState } from 'checkwait-core'
import { cellToSquare, renderBoard, type RenderOpts } from '../src/board-render.js'

function strip(s: string): string {
  // CSI SGR, OSC, and VT100 line attributes (ESC#n — feel chess-2 DECDWL/DECDHL)
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b#[0-9]/g, '')
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

  // feel-1: truecolor uses the FILLED glyph set for both sides (outline set
  // rendered faint) — side is carried by explicit piece foreground colors.
  const WHITE_FG = '\x1b[38;2;255;255;255m'
  const BLACK_FG = '\x1b[38;2;20;20;20m'

  it('renders filled glyphs with per-side piece foregrounds (truecolor)', () => {
    const out = renderBoard(baseOpts())
    expect(out).toContain('♚')
    expect(out).not.toContain('♔') // outline set retired in feel-1
    expect(out).toContain(WHITE_FG)
    expect(out).toContain(BLACK_FG)
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

  it('emits the pinned legal-target SGR background for legal target squares', () => {
    const out = renderBoard(baseOpts({ legalTargets: [28] })) // e4, empty square
    expect(out).toContain('\x1b[48;2;130;151;105m')
    expect(out).toContain('•')
  })

  it('emits the pinned last-move SGR background (#a3a84f) for from/to squares', () => {
    const out = renderBoard(baseOpts({ lastMove: { from: 12, to: 28 } }))
    expect(out).toContain('\x1b[48;2;163;168;79m')
  })

  // feel-1 frame-fit rules: the top rank scrolled off at the recommended
  // 100x28 because WIDE (24 board lines) + HUD exceeded the old 22-row
  // fallback threshold; and any overflow must drop HUD lines, never scroll.
  it('falls back to 4x2 cells when rows < 28 even with plenty of columns', () => {
    const out = renderBoard(baseOpts({ cols: 100, rows: 27 }))
    const lines = strip(out).split('\r\n')
    expect(lines.some((l) => l.length === 32)).toBe(true)
    expect(lines.some((l) => l.length === 48)).toBe(false)
  })

  // feel chess-2: double-size piece rows (DECDWL/DECDHL) on supporting terminals.
  it('bigPieces: each rank is spacer + DECDHL top/bottom halves, same 24-line board', () => {
    const out = renderBoard(baseOpts({ bigPieces: true }))
    expect(out).toContain('\x1b#3')
    expect(out).toContain('\x1b#4')
    const lines = out.split('\r\n')
    expect(lines.length).toBe(28) // 8 * (1 spacer + 2 half-rows) + 4 HUD — geometry unchanged
    expect(lines.filter((l) => l.startsWith('\x1b#3')).length).toBe(8)
    expect(lines.filter((l) => l.startsWith('\x1b#4')).length).toBe(8)
    // top/bottom halves carry identical content so the glyph spans both rows
    const top = lines.find((l) => l.startsWith('\x1b#3'))
    const bottom = lines.find((l) => l.startsWith('\x1b#4'))
    expect(top?.slice(3)).toBe(bottom?.slice(3))
    // piece cells are cw/2 logical chars (double width = same visual columns)
    const stripped = strip(out).split('\r\n')
    expect(stripped.some((l) => l.length === 24)).toBe(true) // piece rows
    expect(stripped.some((l) => l.length === 48)).toBe(true) // spacer rows
  })

  it('bigPieces is ignored in basic mode and NARROW cells (no DECDHL emitted)', () => {
    const basic = renderBoard(baseOpts({ bigPieces: true, colorMode: 'basic' }))
    expect(basic).not.toContain('\x1b#3')
    const narrow = renderBoard(baseOpts({ bigPieces: true, cols: 59, rows: 22 }))
    expect(narrow).not.toContain('\x1b#3')
  })

  it('non-double lines carry an explicit single-width attribute (ESC#5)', () => {
    const out = renderBoard(baseOpts({ bigPieces: true }))
    const lines = out.split('\r\n')
    // stale double-height attributes must be impossible after resize
    for (const l of lines) {
      const isHalf = l.startsWith('\x1b#3') || l.startsWith('\x1b#4')
      if (!isHalf) expect(l.includes('\x1b#5')).toBe(true)
    }
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
