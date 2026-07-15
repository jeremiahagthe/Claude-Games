import type { ActivePiece, MatchState, PlayerState } from 'blockwait-core'
import { GARBAGE, KINDS, TICK_RATE, SUDDEN_DEATH_TICK, bIdx, cellsAt, collides } from 'blockwait-core'
import type { ColorMode } from 'termwait'

// v1 is k=1 only — no scaling, no centering pad applied yet. Layout carries
// cols/rows so a future revision can center an oversized terminal's fixed
// 80x23 frame; that centering is not implemented here (not exercised by any
// pinned test), only the >=80x24 admission gate is.
export interface Layout {
  cols: number
  rows: number
}

export function chooseLayout(cols: number, rows: number): Layout | null {
  if (cols >= 80 && rows >= 24) return { cols, rows }
  return null
}

const ESC = '\x1b'
const RESET = `${ESC}[0m`

export function tooSmallScreen(cols: number, rows: number): string {
  const msg = 'blockwait needs 80x24'
  const top = Math.max(0, Math.floor((Math.max(rows, 1) - 1) / 2))
  const left = Math.max(0, Math.floor((cols - msg.length) / 2))
  const lines: string[] = []
  for (let i = 0; i < top; i++) lines.push('')
  lines.push(' '.repeat(left) + msg)
  // Same positional framing as renderFrame (see there): ESC[H repaints from
  // the top-left instead of scrolling, leading-of-line ESC[K clears resize
  // residue, trailing ESC[J clears residue below. No SGR here, so no RESET.
  return `${ESC}[H${ESC}[K` + lines.join(`\r\n${ESC}[K`) + `${ESC}[J`
}

// --- hard-drop landing (renderer + bot reuse candidate) ---------------------

export function ghostY(board: number[], piece: ActivePiece): number {
  let y = piece.y
  while (!collides(board, { ...piece, y: y + 1 })) y++
  return y
}

// --- colors ------------------------------------------------------------------

type Rgb = readonly [number, number, number]
type PieceKind = ActivePiece['kind']

const KIND_RGB: Record<PieceKind, Rgb> = {
  I: [0, 255, 255],
  O: [255, 255, 0],
  T: [160, 80, 255],
  S: [0, 220, 80],
  Z: [255, 70, 70],
  L: [255, 160, 0],
  J: [80, 120, 255],
}
const GARBAGE_RGB: Rgb = [130, 130, 130]

// Nearest xterm-256 index for each RGB above, computed once via the same
// quantization as snake-client's rgbTo256 (packages/snake-client/src/render.ts)
// and pinned here as literals per the task-8 brief.
const KIND_256: Record<PieceKind, number> = { I: 51, O: 226, T: 141, S: 42, Z: 203, L: 214, J: 105 }
const GARBAGE_256 = 243

const MONO_GLYPH: Record<PieceKind, string> = { I: 'II', O: 'OO', T: 'TT', S: 'SS', Z: 'ZZ', L: 'LL', J: 'JJ' }
const GARBAGE_GLYPH = '▒▒'
const GHOST_GLYPH = '··'
const EMPTY_GLYPH = '  '

function brighten(rgb: Rgb): Rgb {
  return [Math.min(255, rgb[0] + 60), Math.min(255, rgb[1] + 60), Math.min(255, rgb[2] + 60)]
}

function kindFromBoardValue(v: number): PieceKind | null {
  if (v === 0 || v === GARBAGE) return null
  return KINDS[v - 1] ?? null
}

// --- board cell compositing ---------------------------------------------------

type CellKind = { t: 'piece'; kind: PieceKind } | { t: 'garbage' } | { t: 'locked'; kind: PieceKind } | { t: 'ghost' } | { t: 'empty' }

function cellToken(kind: CellKind, mode: ColorMode): string {
  if (kind.t === 'empty') return EMPTY_GLYPH
  if (mode === 'mono') {
    switch (kind.t) {
      case 'piece':
        return MONO_GLYPH[kind.kind]
      case 'locked':
        return MONO_GLYPH[kind.kind]
      case 'garbage':
        return GARBAGE_GLYPH
      case 'ghost':
        return GHOST_GLYPH
    }
  }
  if (kind.t === 'ghost') {
    // Dim, no color — the ghost is a positional hint, not a piece color.
    return `${ESC}[2m${GHOST_GLYPH}${RESET}`
  }
  const bright = kind.t === 'piece'
  const rgb = kind.t === 'garbage' ? GARBAGE_RGB : KIND_RGB[kind.kind]
  const idx256 = kind.t === 'garbage' ? GARBAGE_256 : KIND_256[kind.kind]
  const glyph = kind.t === 'garbage' ? GARBAGE_GLYPH : MONO_GLYPH[kind.kind]
  if (mode === 'truecolor') {
    const [r, g, b] = bright ? brighten(rgb) : rgb
    return `${ESC}[38;2;${r};${g};${b}m${glyph}${RESET}`
  }
  const boldPrefix = bright ? '1;' : ''
  return `${ESC}[${boldPrefix}38;5;${idx256}m${glyph}${RESET}`
}

interface CellSets {
  pieceCells: Set<number>
  ghostCells: Set<number>
}

function buildCellSets(player: PlayerState): CellSets {
  const pieceCells = new Set<number>()
  const ghostCells = new Set<number>()
  if (player.piece) {
    for (const [x, y] of cellsAt(player.piece.kind, player.piece.rot, player.piece.x, player.piece.y)) {
      pieceCells.add(bIdx(x, y))
    }
    const gy = ghostY(player.board, player.piece)
    for (const [x, y] of cellsAt(player.piece.kind, player.piece.rot, player.piece.x, gy)) {
      const i = bIdx(x, y)
      if (!pieceCells.has(i)) ghostCells.add(i)
    }
  }
  return { pieceCells, ghostCells }
}

function boardCellKind(player: PlayerState, sets: CellSets, x: number, y: number): CellKind {
  const i = bIdx(x, y)
  if (sets.pieceCells.has(i) && player.piece) return { t: 'piece', kind: player.piece.kind }
  const v = player.board[i] ?? 0
  if (v === GARBAGE) return { t: 'garbage' }
  const k = kindFromBoardValue(v)
  if (k) return { t: 'locked', kind: k }
  if (sets.ghostCells.has(i)) return { t: 'ghost' }
  return { t: 'empty' }
}

// --- board frame (22 lines: top border, 20 rows, bottom border) --------------

const BOARD_W = 10
const BOARD_H = 20
const HIDDEN_ROWS = 4 // rows 0-3 hidden; visible board rows are 4-23

function boardLines(player: PlayerState, mode: ColorMode): string[] {
  const sets = buildCellSets(player)
  const lines: string[] = []
  lines.push(`┌${'─'.repeat(BOARD_W * 2)}┐`)
  for (let ry = 0; ry < BOARD_H; ry++) {
    const y = HIDDEN_ROWS + ry
    let row = '│'
    for (let x = 0; x < BOARD_W; x++) row += cellToken(boardCellKind(player, sets, x, y), mode)
    row += '│'
    lines.push(row)
  }
  lines.push(`└${'─'.repeat(BOARD_W * 2)}┘`)
  return lines
}

// --- HUD (36 cols, 22 rows) ---------------------------------------------------

const HUD_WIDTH = 36
const HUD_ROWS = BOARD_H + 2 // top border row + 20 board rows + bottom border row

function padHudText(text: string): string {
  return text.length > HUD_WIDTH ? text.slice(0, HUD_WIDTH) : text.padEnd(HUD_WIDTH)
}

function centerHudText(text: string): string {
  const left = Math.max(0, Math.floor((HUD_WIDTH - text.length) / 2))
  return padHudText(' '.repeat(left) + text)
}

function fmtClock(tick: number): string {
  const totalSec = Math.max(0, Math.floor(tick / TICK_RATE))
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

// A "4x2-cell" mini is two cells wide (4 chars); the HUD only has room for a
// single-row summary glyph pair per hold/preview slot in v1. Plain glyph
// text only (no escapes) — HUD lines are built as fixed-width plain text
// FIRST and colorized as a whole afterward (see colorizeLine), because
// padHudText/centerHudText do raw (escape-blind) length slicing/padding —
// embedding escapes before that point corrupts them mid-sequence.
function miniGlyph(kind: PieceKind | null): string {
  if (!kind) return EMPTY_GLYPH.repeat(2)
  const g = MONO_GLYPH[kind]
  return g + g
}

// Wraps an already-padded, escape-free HUD line in a single color escape —
// safe because it never re-slices the string, only surrounds it.
function colorizeLine(paddedPlain: string, mode: ColorMode, rgb: Rgb, idx256: number): string {
  if (mode === 'mono') return paddedPlain
  if (mode === 'truecolor') return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${paddedPlain}${RESET}`
  return `${ESC}[38;5;${idx256}m${paddedPlain}${RESET}`
}

function gravityLevel(tick: number): number {
  // Mirrors block-core's GRAVITY_SCHEDULE thresholds — a simple ordinal level
  // number for HUD display (1 = slowest/starting tier).
  const thresholds = [0, 400, 800, 1200, 1600, 2000, 2400]
  let level = 1
  for (const t of thresholds) if (tick >= t) level++
  return level - 1 || 1
}

function buildHudLines(state: MatchState, you: number, mode: ColorMode): string[] {
  const hud: string[] = new Array(HUD_ROWS).fill(' '.repeat(HUD_WIDTH))
  const me = state.players[you]!
  const opp = state.players[you === 0 ? 1 : 0]!

  hud[0] = centerHudText('BLOCKWAIT')
  hud[1] = padHudText(`▸${me.name}${me.alive ? '' : ' †'}`)
  hud[2] = padHudText(` ${opp.name}${opp.alive ? '' : ' †'}`)
  const holdPlain = padHudText(`hold: ${me.hold ? miniGlyph(me.hold) : '--'}`)
  hud[4] = me.hold ? colorizeLine(holdPlain, mode, KIND_RGB[me.hold], KIND_256[me.hold]) : holdPlain
  hud[6] = padHudText('next:')
  const previews = me.queue.slice(0, 3)
  for (let i = 0; i < 3; i++) {
    const p = previews[i]
    if (!p) continue
    const plain = padHudText(`  ${miniGlyph(p)}`)
    hud[7 + i] = colorizeLine(plain, mode, KIND_RGB[p], KIND_256[p])
  }

  const incoming = me.pendingGarbage.reduce((sum, g) => sum + g.rows, 0)
  const incomingText = padHudText(`incoming: ${incoming}`)
  hud[11] = mode !== 'mono' && incoming > 0 ? `${ESC}[31m${incomingText}${RESET}` : incomingText

  hud[12] = padHudText(`lines: ${me.linesCleared}  sent: ${me.linesSent}`)
  hud[13] = padHudText(`clock ${fmtClock(me.tick)}`)
  hud[14] = padHudText(`gravity Lv ${gravityLevel(me.tick)}`)
  hud[15] = padHudText(me.tick >= SUDDEN_DEATH_TICK ? 'SUDDEN DEATH' : '')

  hud[HUD_ROWS - 1] = padHudText('←→ move ↓ soft ↑ rot space drop c hold')

  return hud
}

// --- frame assembly -----------------------------------------------------------

function padStatusLine(statusLine: string): string {
  return statusLine.length > 80 ? statusLine.slice(0, 80) : statusLine.padEnd(80)
}

export function renderFrame(state: MatchState, you: number, _layout: Layout, statusLine: string, mode: ColorMode): string {
  const opp = you === 0 ? 1 : 0
  const meLines = boardLines(state.players[you]!, mode)
  const oppLines = boardLines(state.players[opp]!, mode)
  const hudLines = buildHudLines(state, you, mode)

  const lines: string[] = []
  for (let i = 0; i < HUD_ROWS; i++) {
    lines.push(`${meLines[i]}${hudLines[i]}${oppLines[i]}`)
  }
  lines.push(padStatusLine(statusLine))

  // Positional framing (transcribed from packages/snake-client/src/render.ts,
  // frozen post-813d2a9/8f417db): ESC[H repaints from the top-left instead of
  // scrolling every frame; ESC[K sits at the START of each line (not the end
  // — a trailing ESC[K on an exactly-80-column line lands the cursor in the
  // VT pending-wrap state at column 80, and an erase from there deletes the
  // line's own just-written last column); trailing ESC[J clears residue
  // below since the renderer never scrolls. Mono carries no SGR, so no
  // trailing RESET is needed for it.
  const tail = mode === 'mono' ? '' : RESET
  return `${ESC}[H${ESC}[K` + lines.join(`\r\n${ESC}[K`) + tail + `${ESC}[J`
}
