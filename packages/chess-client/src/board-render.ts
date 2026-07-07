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
  // Task 9 additions (carried over from Task 8's review): game.ts maintains
  // these and passes them in — the renderer itself is still pure/stateless.
  sanHistory?: string[] // last ~8 SAN moves, oldest first; toSAN is called BEFORE applyMove
  opponentHandle?: string // e.g. 'bot·easy' offline (Task 9's call — see game.ts); real handle online (Task 10)
  statusLine?: string // Claude-attention banner / quit-confirm hint / typed-move buffer
}

const ESC = '\x1b'
const RESET = `${ESC}[0m`

// Mid-tone board pair (feel-1): every square must contrast BOTH piece
// foregrounds below — the original lichess pair (#f0d9b5 light) made white
// pieces invisible on light squares (default terminal fg, no explicit color).
const LIGHT_RGB: readonly [number, number, number] = [181, 136, 99] // #b58863
const DARK_RGB: readonly [number, number, number] = [122, 79, 40] // #7a4f28
const SELECTED_RGB: readonly [number, number, number] = [125, 143, 77] // #7d8f4d olive — mid-tone so a selected white piece stays visible
const LEGAL_RGB: readonly [number, number, number] = [130, 151, 105] // muted green tint
const LAST_MOVE_RGB: readonly [number, number, number] = [163, 168, 79] // #a3a84f
const CHECK_RGB: readonly [number, number, number] = [224, 82, 82] // #e05252
// Piece foregrounds (feel-1): side is carried by color, not glyph shape.
const WHITE_PIECE_RGB: readonly [number, number, number] = [255, 255, 255]
const BLACK_PIECE_RGB: readonly [number, number, number] = [20, 20, 20] // #141414

function bg(rgb: readonly [number, number, number], underline: boolean): string {
  return underline ? `${ESC}[4;48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `${ESC}[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

function fg(rgb: readonly [number, number, number]): string {
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

// Truecolor mode uses the FILLED glyph set for BOTH sides (feel-1): the
// outline set (♔♙…) is thin line-art that renders faint in most terminal
// fonts; solid shapes + explicit fg color carry the side unambiguously.
const FILLED_GLYPHS: Record<PieceType, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }

function pieceGlyph(type: PieceType): string {
  return FILLED_GLYPHS[type]
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
// HUD is 4 lines (clock, san/last-move, opponent, status). WIDE needs
// 8*3 + 4 = 28 rows — the frame must FIT the terminal or the top rank
// scrolls off (feel-1: rank 8 was clipped at the spec-recommended 100x28
// because the old threshold only fell back below 22 rows).
export const HUD_LINES = 4
const FALLBACK_COLS = 60
const FALLBACK_ROWS = 8 * WIDE.ch + HUD_LINES // 28

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

// Coordinate pair (e.g. "last: e2-e4") rather than true SAN — SAN requires
// the pre-move ChessState, which the renderer never receives (it only sees
// a Move). See board-render section of task-8-report.md for the original
// rationale; Task 9's sanHistory field (below) covers the SAN case instead.
function lastMoveLine(lastMove: Move | null): string {
  if (!lastMove) return ''
  return `last: ${sqName(lastMove.from)}-${sqName(lastMove.to)}`
}

// Last ~8 SAN moves, space-separated. Sliced defensively here too, since the
// field's contract ("last ~8") is game.ts's responsibility, not a hard type
// invariant.
function sanHistoryLine(sanHistory: string[]): string {
  return sanHistory.slice(-8).join(' ')
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
            const glyph = o.colorMode === 'truecolor' ? pieceGlyph(piece.type) : pieceLetter(piece.type, piece.color)
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
          const pieceFg = middleRow && piece ? fg(piece.color === 'w' ? WHITE_PIECE_RGB : BLACK_PIECE_RGB) : ''
          line += bg(rgb, isCursor) + pieceFg + cellText + RESET
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

  // Compact 4-line HUD (feel-1): SAN history when available, else the
  // coordinate last-move line — never both, so WIDE + HUD fits 28 rows.
  lines.push(clockLine(o.state, o.selfColor))
  lines.push(o.sanHistory && o.sanHistory.length > 0 ? sanHistoryLine(o.sanHistory) : lastMoveLine(o.lastMove))
  lines.push(o.opponentHandle ? `vs ${o.opponentHandle}` : '')
  lines.push(o.statusLine ?? '')

  // Never emit more lines than the terminal has — overflow scrolls the TOP
  // rank off (feel-1). Drop HUD tail lines, never board rows.
  const fitted = lines.slice(0, Math.max(1, o.rows))

  // Trailing clear-below kills residue when the frame shrinks (resize,
  // WIDE→NARROW) — the renderer never scrolls, so this is always safe.
  return `${ESC}[H` + fitted.join('\r\n') + RESET + `${ESC}[J`
}
