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
const DOT_RGB: readonly [number, number, number] = [235, 235, 235] // legal-move dot on empty squares

// Keyboard cursor in sprite mode: a lifted square background instead of the
// underline attribute — underlining a square full of spaces/half-blocks
// draws stray horizontal streaks through the sprite (feel chess-4).
const CURSOR_LIFT = 36
function lift(rgb: readonly [number, number, number]): readonly [number, number, number] {
  return [Math.min(255, rgb[0] + CURSOR_LIFT), Math.min(255, rgb[1] + CURSOR_LIFT), Math.min(255, rgb[2] + CURSOR_LIFT)]
}

function bg(rgb: readonly [number, number, number], underline: boolean): string {
  return underline ? `${ESC}[4;48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `${ESC}[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

function fg(rgb: readonly [number, number, number]): string {
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

// feel chess-3: truecolor WIDE cells draw pieces as PIXEL SPRITES — half-block
// characters (▀▄█) over the square background — instead of single font glyphs.
// A glyph can never be bigger than the font; a sprite fills the whole square.
// Each piece is an 8x8 bitmask, scaled nearest-neighbor to the square's
// cw x 2*ch pixel grid (one terminal cell = two vertically stacked pixels).
// The masks carry their own ~1px border so scaled sprites stay centered.
const SPRITE_MASKS: Record<PieceType, readonly string[]> = {
  p: [
    '........', //
    '...##...', //
    '..####..', //
    '..####..', //
    '...##...', //
    '...##...', //
    '..####..', //
    '.######.', //
  ],
  r: [
    '........', //
    '.#.##.#.', //
    '.######.', //
    '..####..', //
    '..####..', //
    '..####..', //
    '..####..', //
    '.######.', //
  ],
  n: [
    '........', //
    '..##.#..', //
    '.#####..', //
    '######..', //
    '##.###..', //
    '...###..', //
    '..####..', //
    '.######.', //
  ],
  b: [
    '........', //
    '...##...', //
    '..####..', //
    '..##.#..', //
    '..####..', //
    '...##...', //
    '..####..', //
    '.######.', //
  ],
  q: [
    '........', //
    '#.#..#.#', //
    '########', //
    '.######.', //
    '..####..', //
    '...##...', //
    '..####..', //
    '.######.', //
  ],
  k: [
    '...##...', //
    '..####..', //
    '...##...', //
    '..####..', //
    '.######.', //
    '..####..', //
    '..####..', //
    '.######.', //
  ],
}

// Small centered dot marking a legal move on an empty square.
const DOT_MASK: readonly string[] = [
  '........', //
  '........', //
  '........', //
  '...##...', //
  '...##...', //
  '........', //
  '........', //
  '........', //
]

function scaleMask(mask: readonly string[], w: number, h: number): boolean[][] {
  const out: boolean[][] = []
  for (let y = 0; y < h; y++) {
    const sy = Math.min(7, Math.floor((y * 8) / h))
    const row: boolean[] = []
    for (let x = 0; x < w; x++) {
      const sx = Math.min(7, Math.floor((x * 8) / w))
      row.push(mask[sy]?.[sx] === '#')
    }
    out.push(row)
  }
  return out
}

const spriteCache = new Map<string, boolean[][]>()

function sprite(key: string, mask: readonly string[], cw: number, ch: number): boolean[][] {
  const cacheKey = `${key}:${cw}x${ch}`
  let s = spriteCache.get(cacheKey)
  if (!s) {
    s = scaleMask(mask, cw, 2 * ch)
    spriteCache.set(cacheKey, s)
  }
  return s
}

// Truecolor NARROW cells (4x2 — too coarse for sprites) still use the filled
// glyph set for BOTH sides (feel-1): the outline set (♔♙…) is thin line-art
// that renders faint in most terminal fonts; solid shapes + explicit fg color
// carry the side unambiguously.
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
  hudLines: number // 4 = full HUD; 2/1 = compact rungs (below-board layouts only)
  sideHud: boolean // HUD beside the board (top-right) instead of below it
}

// Full HUD is 4 lines (clock, san/last-move, opponent, status); the compact
// HUD is 2 (clock + opponent combined, then status/san). The frame must FIT
// the terminal or the top rank scrolls off (feel-1: rank 8 was clipped at
// the spec-recommended 100x28 because the old threshold only fell back
// below 22 rows).
export const HUD_LINES = 4
// The below-board HUD ladder: full 4 lines, then 2, then 1 — each rung tried
// only when the previous can't fit sprite-size squares (feel chess-4b/4c).
const HUD_LADDER = [HUD_LINES, 2, 1] as const
const NARROW: CellGeometry = { cw: 4, ch: 2, hudLines: HUD_LINES, sideHud: false }
const MIN_WIDE_CH = 3 // below this, cells are too coarse for sprites → NARROW glyphs
const MAX_CH = 8 // squares stop growing at 16x8 cells — beyond this the board dwarfs the HUD
const SIDE_HUD_MIN_COLS = 26 // room the side HUD needs right of the board

// Adaptive square size (feel chess-3): pick the largest square that fits the
// terminal, keeping cw = 2*ch (terminal cells are ~1:2, so the square — and
// its cw x 2*ch pixel grid — stays visually square). Bigger window = bigger
// squares = bigger piece sprites.
//
// Layout choice (feel chess-4d): default terminals are WIDE but SHORT —
// iTerm2 opens at 80x24, where the 24-row sprite board plus ANY below-board
// HUD line can never fit. So when there's horizontal room, the HUD moves
// BESIDE the board (top-right) and the board gets every row. The below-board
// ladder remains for narrow-but-tall windows.
export function cellSize(cols: number, rows: number): CellGeometry {
  const side = Math.min(Math.floor(rows / 8), Math.floor((cols - SIDE_HUD_MIN_COLS) / 16), MAX_CH)
  if (side >= MIN_WIDE_CH) return { cw: 2 * side, ch: side, hudLines: HUD_LINES, sideHud: true }
  for (const hud of HUD_LADDER) {
    const ch = Math.min(Math.floor((rows - hud) / 8), Math.floor(cols / 16), MAX_CH)
    if (ch >= MIN_WIDE_CH) return { cw: 2 * ch, ch, hudLines: hud, sideHud: false }
  }
  return NARROW
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
  const { cw, ch, hudLines, sideHud } = cellSize(o.cols, o.rows)
  const ranks = boardRanks(o.selfColor)
  const files = boardFiles(o.selfColor)
  const legalSet = new Set(o.legalTargets)
  const inCheck = isInCheck(o.state, o.state.turn)
  const kingSquare = inCheck ? findKingSquare(o.state, o.state.turn) : null
  // Sprite pieces need truecolor (half-blocks composite piece fg over square
  // bg) and a cell big enough to carry a readable bitmap.
  const sprites = o.colorMode === 'truecolor' && ch >= MIN_WIDE_CH

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
          if (sprites) {
            // Two pixel rows per terminal row: ▀ paints the top pixel in fg
            // over the bg, ▄ the bottom, █ both, space neither.
            let spr: boolean[][] | null = null
            let sprFg = ''
            if (piece) {
              spr = sprite(piece.type, SPRITE_MASKS[piece.type], cw, ch)
              sprFg = fg(piece.color === 'w' ? WHITE_PIECE_RGB : BLACK_PIECE_RGB)
            } else if (isLegal) {
              spr = sprite('dot', DOT_MASK, cw, ch)
              sprFg = fg(DOT_RGB)
            }
            let cell = bg(isCursor ? lift(rgb) : rgb, false)
            const topRow = spr?.[2 * subRow]
            const botRow = spr?.[2 * subRow + 1]
            for (let x = 0; x < cw; x++) {
              const top = topRow?.[x] === true
              const bot = botRow?.[x] === true
              if (!top && !bot) cell += ' '
              else cell += sprFg + (top && bot ? '█' : top ? '▀' : '▄')
            }
            line += cell + RESET
          } else {
            const middleRow = subRow === Math.floor(ch / 2)
            let cellText = ' '.repeat(cw)
            if (middleRow) {
              if (piece) cellText = centerPad(pieceGlyph(piece.type), cw)
              else if (isLegal) cellText = centerPad('•', cw)
            }
            const pieceFg = middleRow && piece ? fg(piece.color === 'w' ? WHITE_PIECE_RGB : BLACK_PIECE_RGB) : ''
            line += bg(rgb, isCursor) + pieceFg + cellText + RESET
          }
        } else {
          const middleRow = subRow === Math.floor(ch / 2)
          let cellText = ' '.repeat(cw)
          if (middleRow) {
            if (piece) cellText = centerPad(pieceLetter(piece.type, piece.color), cw)
            else if (isLegal) cellText = centerPad('•', cw)
          }
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

  // HUD content (feel-1): SAN history when available, else the coordinate
  // last-move line — never both. Every placed line is truncated — a wrapped
  // line would scroll the whole frame (feel chess-4). When the window is too
  // small for sprite pieces, the status line doubles as the how-to-fix hint.
  const hint = o.colorMode === 'truecolor' && !sprites ? 'enlarge the window for bigger pieces' : ''
  const movesLine = o.sanHistory && o.sanHistory.length > 0 ? sanHistoryLine(o.sanHistory) : lastMoveLine(o.lastMove)
  const clock = clockLine(o.state, o.selfColor)
  const who = o.opponentHandle ? `vs ${o.opponentHandle}` : ''
  const status = o.statusLine || hint

  if (sideHud) {
    // Side HUD (feel chess-4d): appended right of the board's top rows, so
    // the board can use every terminal row. Board lines end in RESET, so
    // plain text composes cleanly; the ESC[K join clears the rest.
    const sideWidth = Math.max(1, o.cols - 8 * cw - 2)
    const hud = [clock, movesLine, who, status]
    for (let i = 0; i < hud.length && i < lines.length; i++) {
      const text = hud[i] ?? ''
      if (text) lines[i] += ' ' + text.slice(0, sideWidth)
    }
  } else {
    const hudWidth = Math.max(1, o.cols - 1)
    if (hudLines === HUD_LINES) {
      lines.push(clock.slice(0, hudWidth))
      lines.push(movesLine.slice(0, hudWidth))
      lines.push(who.slice(0, hudWidth))
      lines.push(status.slice(0, hudWidth))
    } else if (hudLines === 2) {
      // Compact HUD (feel chess-4b): the two lines that matter — clocks+who,
      // then the interactive line (status beats SAN history when both exist).
      lines.push((clock + (who ? `  ${who}` : '')).slice(0, hudWidth))
      lines.push((o.statusLine || movesLine).slice(0, hudWidth))
    } else {
      // 1-line HUD (feel chess-4c): clocks always, then whichever of
      // status/opponent matters more right now.
      const tail = o.statusLine || who
      lines.push((clock + (tail ? `  ${tail}` : '')).slice(0, hudWidth))
    }
  }

  // Never emit more lines than the terminal has — overflow scrolls the TOP
  // rank off (feel-1). Drop HUD tail lines, never board rows.
  const fitted = lines.slice(0, Math.max(1, o.rows))

  // Per-line clear-to-EOL (ESC[K) kills residue to the RIGHT of each line
  // when the frame narrows mid-resize; trailing clear-below (ESC[J) kills
  // residue when it shrinks vertically — the renderer never scrolls, so
  // both are always safe (feel chess-4: mixed-size frame corruption).
  return `${ESC}[H` + fitted.join(`${ESC}[K\r\n`) + RESET + `${ESC}[J`
}
