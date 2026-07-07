import type { ChessState, Color, Move, PieceType } from 'checkwait-core'
import { isInCheck, sqName } from 'checkwait-core'

export interface RenderOpts {
  state: ChessState
  selfColor: Color
  selected: number | null
  legalTargets: number[]
  lastMove: Move | null
  cursor: number | null // keyboard-cursor square
  colorMode: 'truecolor' | 'basic'
  cols: number
  rows: number
}

const ESC = '\x1b'
const RESET = `${ESC}[0m`

// Lichess-style board pair, pinned.
const LIGHT_RGB: readonly [number, number, number] = [240, 217, 181] // #f0d9b5
const DARK_RGB: readonly [number, number, number] = [181, 136, 99] // #b58863
const SELECTED_RGB: readonly [number, number, number] = [246, 246, 105] // #f6f669
const LEGAL_RGB: readonly [number, number, number] = [130, 151, 105] // muted green tint
const LAST_MOVE_RGB: readonly [number, number, number] = [205, 210, 106] // #cdd26a
const CHECK_RGB: readonly [number, number, number] = [224, 82, 82] // #e05252

function bg(rgb: readonly [number, number, number], underline: boolean): string {
  return underline ? `${ESC}[4;48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `${ESC}[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

const WHITE_GLYPHS: Record<PieceType, string> = { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' }
const BLACK_GLYPHS: Record<PieceType, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }

function pieceGlyph(type: PieceType, color: Color): string {
  return color === 'w' ? WHITE_GLYPHS[type] : BLACK_GLYPHS[type]
}

// FEN-style letter: uppercase = white, lowercase = black (basic/mono mode —
// no color channel, so case carries the side).
function pieceLetter(type: PieceType, color: Color): string {
  return color === 'w' ? type.toUpperCase() : type
}

interface CellGeometry {
  cw: number
  ch: number
}

const WIDE: CellGeometry = { cw: 6, ch: 3 }
const NARROW: CellGeometry = { cw: 4, ch: 2 }
const FALLBACK_COLS = 60
const FALLBACK_ROWS = 22

export function cellSize(cols: number, rows: number): CellGeometry {
  return cols < FALLBACK_COLS || rows < FALLBACK_ROWS ? NARROW : WIDE
}

// Visual row order (top of screen -> bottom): white sees rank8 down to
// rank1 (standard orientation); black sees the board flipped, rank1 down to
// rank8. `ranks[]`/`files[]` below are board-rank/file indices (0 = rank1 /
// file a), one entry per visual row/column.
function boardRanks(selfColor: Color): readonly number[] {
  const white = [7, 6, 5, 4, 3, 2, 1, 0]
  return selfColor === 'w' ? white : [...white].reverse()
}

function boardFiles(selfColor: Color): readonly number[] {
  const white = [0, 1, 2, 3, 4, 5, 6, 7]
  return selfColor === 'w' ? white : [...white].reverse()
}

function findKingSquare(state: ChessState, color: Color): number | null {
  for (let i = 0; i < 64; i++) {
    const piece = state.board[i]
    if (piece && piece.type === 'k' && piece.color === color) return i
  }
  return null
}

// Maps a 1-based terminal (x, y) mouse coordinate to a board square index,
// or null when outside the board's drawn area. Used by Task 9's click-to-
// select input handling; geometry mirrors renderBoard exactly (board is
// drawn flush against the home cursor, no left/top margin).
export function cellToSquare(x: number, y: number, cols: number, rows: number, selfColor: Color): number | null {
  const { cw, ch } = cellSize(cols, rows)
  const px = x - 1
  const py = y - 1
  if (px < 0 || py < 0 || px >= cw * 8 || py >= ch * 8) return null
  const colIdx = Math.floor(px / cw)
  const rowIdx = Math.floor(py / ch)
  const file = boardFiles(selfColor)[colIdx]
  const rank = boardRanks(selfColor)[rowIdx]
  if (file === undefined || rank === undefined) return null
  return rank * 8 + file
}

function fmtClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// `● 2:41  ○ 2:55` — self color first, filled circle marks whoever is to move.
function clockLine(state: ChessState, selfColor: Color): string {
  const oppColor: Color = selfColor === 'w' ? 'b' : 'w'
  const selfMark = state.turn === selfColor ? '●' : '○'
  const oppMark = state.turn === oppColor ? '●' : '○'
  return `${selfMark} ${fmtClock(state.clocksMs[selfColor])}  ${oppMark} ${fmtClock(state.clocksMs[oppColor])}`
}

// RenderOpts carries no SAN move-list or opponent handle (those aren't part
// of this task's produced interface), so the HUD's "last move" line shows
// the coordinate pair (e.g. "e2-e4") rather than true SAN — SAN requires the
// pre-move ChessState, which the renderer never receives. See board-render
// section of task-8-report.md for the full rationale.
function lastMoveLine(lastMove: Move | null): string {
  if (!lastMove) return ''
  return `last: ${sqName(lastMove.from)}-${sqName(lastMove.to)}`
}

function centerPad(s: string, width: number): string {
  const total = width - s.length
  const left = Math.floor(total / 2)
  const right = total - left
  return ' '.repeat(Math.max(0, left)) + s + ' '.repeat(Math.max(0, right))
}

export function renderBoard(o: RenderOpts): string {
  const { cw, ch } = cellSize(o.cols, o.rows)
  const ranks = boardRanks(o.selfColor)
  const files = boardFiles(o.selfColor)
  const legalSet = new Set(o.legalTargets)
  const inCheck = isInCheck(o.state, o.state.turn)
  const kingSquare = inCheck ? findKingSquare(o.state, o.state.turn) : null

  const lines: string[] = []

  for (const rank of ranks) {
    for (let subRow = 0; subRow < ch; subRow++) {
      let line = ''
      for (const file of files) {
        const idx = rank * 8 + file
        const piece = o.state.board[idx]
        const isLight = (file + rank) % 2 === 1
        const isSelected = o.selected === idx
        const isCheck = kingSquare === idx
        const isLastMove = !!o.lastMove && (o.lastMove.from === idx || o.lastMove.to === idx)
        const isLegal = legalSet.has(idx)
        const isCursor = o.cursor === idx

        const middleRow = subRow === Math.floor(ch / 2)
        let cellText = ' '.repeat(cw)
        if (middleRow) {
          if (piece) {
            const glyph = o.colorMode === 'truecolor' ? pieceGlyph(piece.type, piece.color) : pieceLetter(piece.type, piece.color)
            cellText = centerPad(glyph, cw)
          } else if (isLegal) {
            cellText = centerPad('•', cw)
          }
        }

        if (o.colorMode === 'truecolor') {
          const rgb = isSelected
            ? SELECTED_RGB
            : isCheck
              ? CHECK_RGB
              : isLastMove
                ? LAST_MOVE_RGB
                : isLegal
                  ? LEGAL_RGB
                  : isLight
                    ? LIGHT_RGB
                    : DARK_RGB
          line += bg(rgb, isCursor) + cellText + RESET
        } else {
          // basic mode: reverse-video checkering; highlights layer SGR codes
          // on top (pinned, in priority order: selected > check > last-move > legal).
          const codes: string[] = []
          if (!isLight) codes.push('7') // reverse video for dark squares
          if (isSelected) codes.push('43') // yellow bg
          else if (isCheck) codes.push('41') // red bg
          else if (isLastMove) codes.push('42') // green bg
          else if (isLegal) codes.push('4') // underline
          if (isCursor) codes.push('1') // bold
          const prefix = codes.length > 0 ? `${ESC}[${codes.join(';')}m` : ''
          line += prefix + cellText + RESET
        }
      }
      lines.push(line)
    }
  }

  lines.push('')
  lines.push(clockLine(o.state, o.selfColor))
  lines.push(lastMoveLine(o.lastMove))
  lines.push('') // opponent-handle placeholder (not part of RenderOpts)
  lines.push('') // status line placeholder for the Claude-attention text

  return `${ESC}[H` + lines.join('\r\n') + RESET
}
