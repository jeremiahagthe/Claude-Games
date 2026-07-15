import { describe, expect, it } from 'vitest'
import { createMatch, GARBAGE, bIdx } from 'blockwait-core'
import type { ActivePiece } from 'blockwait-core'
import { chooseLayout, ghostY, renderFrame, tooSmallScreen } from '../src/render.js'

const STRIP = /\x1b\[[0-9;]*[A-Za-z]/g
const frameLines = (f: string) => f.replace(/\x1b\[[HKJ]/g, '').split('\r\n').map((l) => l.replace(STRIP, ''))

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  const m = createMatch(7, ['jeremiah', 'rival'], [false, true])
  it('exact fit at 80x24: 23 lines, EVERY line exactly 80 visible cols', () => {
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 'claude is working…', 'truecolor')
    const lines = frameLines(frame)
    expect(lines.length).toBe(23)
    for (const l of lines) expect(l.length, JSON.stringify(l)).toBe(80)
    expect(lines.some((l) => l.includes('jeremiah'))).toBe(true)
    expect(lines.some((l) => l.includes('rival'))).toBe(true)
  })
  it('below 80x24 → null layout; bigger stays k=1 (no scaling in v1)', () => {
    expect(chooseLayout(79, 24)).toBeNull(); expect(chooseLayout(80, 23)).toBeNull()
    expect(chooseLayout(200, 60)).not.toBeNull()
  })
  it('raw positional framing (the 813d2a9/8f417db pins): ESC[H home, ESC[K at line START, ESC[J tail', () => {
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'truecolor')
    expect(frame.startsWith('\x1b[H\x1b[K')).toBe(true)
    expect(frame.includes('\r\n\x1b[K')).toBe(true)
    expect(frame.endsWith('\x1b[J')).toBe(true)
    expect(/\x1b\[K(\x1b\[[0-9;]*m)*\s*$/m.test(frame.split('\r\n').at(-2) ?? '')).toBe(false) // no trailing ESC[K on content lines
    const tooSmall = tooSmallScreen(79, 24)
    expect(tooSmall.startsWith('\x1b[H\x1b[K')).toBe(true); expect(tooSmall.endsWith('\x1b[J')).toBe(true)
  })
  it('color tiers: mono has zero escapes beyond framing; 256 uses 38;5; and never 38;2;', () => {
    const mono = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'mono').replace(/\x1b\[[HKJ]/g, '')
    expect(mono.includes('\x1b')).toBe(false)
    const c256 = renderFrame(m, 0, chooseLayout(80, 24)!, 's', '256')
    expect(c256.includes('38;5;')).toBe(true); expect(c256.includes('38;2;')).toBe(false)
  })
})

describe('additional render pins', () => {
  it('ghost cells appear at ghostY for an empty board (piece at spawn → ghost at the floor)', () => {
    const m = createMatch(3, ['jeremiah', 'rival'], [false, true])
    // Piece spawns near the top; on an empty board the ghost sits far below
    // it, at the floor — the frame must show ghost dim glyphs there.
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'truecolor')
    const lines = frameLines(frame)
    // Bottom-most visible board row (line 20, 1-indexed board rows 1-20) is
    // where the empty-board ghost lands (board row 23, the floor).
    expect(lines[20]!.includes('··')).toBe(true)
  })
  it('a board cell set to GARBAGE renders in every mode (mono ▒▒)', () => {
    const m = createMatch(5, ['jeremiah', 'rival'], [false, true])
    m.players[0]!.board[bIdx(0, 23)] = GARBAGE
    const mono = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'mono')
    const lines = frameLines(mono)
    expect(lines[20]!.includes('▒▒')).toBe(true)
    for (const mode of ['truecolor', '256'] as const) {
      const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 's', mode)
      expect(frame.includes('▒▒')).toBe(true)
    }
  })
  it('incoming count visible in the HUD when pendingGarbage is non-empty', () => {
    const m = createMatch(9, ['jeremiah', 'rival'], [false, true])
    m.players[0]!.pendingGarbage = [{ rows: 3, holeCol: 2 }]
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'truecolor')
    expect(frame.includes('incoming: 3')).toBe(true)
  })
  it('ghostY: empty board, T rot 0 x=3 → lands so its bottom row is 23', () => {
    const board = new Array<number>(24 * 10).fill(0)
    const piece: ActivePiece = { kind: 'T', rot: 0, x: 3, y: 2 }
    const y = ghostY(board, piece)
    expect(y).toBe(22) // T rot0 bottom cells sit at y+1
  })
  it('ghostY: over a full row 23 → one higher', () => {
    const board = new Array<number>(24 * 10).fill(0)
    for (let x = 0; x < 10; x++) board[bIdx(x, 23)] = GARBAGE
    const piece: ActivePiece = { kind: 'T', rot: 0, x: 3, y: 2 }
    const y = ghostY(board, piece)
    expect(y).toBe(21)
  })
})
