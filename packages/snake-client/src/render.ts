import type { MatchState, SnakeState } from 'snakewait-core'
import {
  GRID_H,
  GRID_W,
  SHRINK_START_TICK,
  TICK_RATE,
  idx,
  isWall,
  sanitizeHandle,
  stepTicksAt,
} from 'snakewait-core'
import type { ColorMode } from 'termwait'

export interface Layout {
  k: number
  cols: number
  rows: number
}

// k=2 only when the window comfortably fits the doubled arena PLUS HUD/status
// rows; k=1 is the baseline 80x24 terminal default. Below 80x24 there is no
// layout that fits at all.
// k=2 arithmetic: a k=2 frame is GRID_W*k + 2 (border) + HUD_WIDTH visible cols
// = 56*2 + 2 + 22 = 136, and GRID_H*k/2 + 2 (border) + 1 (status row) = 40 + 2 + 1
// = 43 visible rows. The original "114x43+" pin computed cols as GRID_W*k + 2
// only (114) and forgot to add HUD_WIDTH (22) — every terminal from 114 to 135
// cols wide was wide enough to pass the gate but too narrow to hold the actual
// frame, so every line wrapped and the screen garbled. The rows side of that
// same pin (43) was NOT defective: it already equals the frame's real vertical
// need exactly, so it is unchanged here.
export function chooseLayout(cols: number, rows: number): Layout | null {
  if (cols >= 136 && rows >= 43) return { k: 2, cols, rows }
  if (cols >= 80 && rows >= 24) return { k: 1, cols, rows }
  return null
}

export function tooSmallScreen(cols: number, rows: number): string {
  const msg = 'snakewait needs 80x24'
  const top = Math.max(0, Math.floor((Math.max(rows, 1) - 1) / 2))
  const left = Math.max(0, Math.floor((cols - msg.length) / 2))
  const lines: string[] = []
  for (let i = 0; i < top; i++) lines.push('')
  lines.push(' '.repeat(left) + msg)
  // Same cursor-positioning framing as renderFrame (see there for the
  // scroll-bug root cause): ESC[H repaints from the top-left instead of
  // scrolling, per-line ESC[K clears resize residue, trailing ESC[J clears
  // residue below. Plain text only — no SGR is ever emitted here, so unlike
  // renderFrame there is no RESET to trail.
  return `${ESC}[H` + lines.join(`${ESC}[K\r\n`) + `${ESC}[J`
}

// --- colors ----------------------------------------------------------------

type Rgb = readonly [number, number, number]

const ESC = '\x1b'
const RESET = `${ESC}[0m`

// [green, pink, blue, gold] — matches the ANSI 32/31/34/33 basic order below.
const SNAKE_RGB: readonly Rgb[] = [
  [80, 250, 120],
  [255, 95, 135],
  [95, 175, 255],
  [255, 215, 95],
]
// Basic ANSI codes are used only for the HUD swatch in '256' mode (see
// swatchText) — the arena's own '256' rendering always goes through
// rgbTo256 for full-fidelity nearest-index colors instead.
const SNAKE_BASIC: readonly number[] = [32, 31, 34, 33]
const FOOD_RGB: Rgb = [150, 150, 150] // dim white
const WALL_RGB: Rgb = [90, 90, 100] // border + closed-ring cells

const BODY_GLYPH: readonly string[] = ['o', 'x', '+', '#']
const HEAD_GLYPH: readonly string[] = ['O', 'X', '*', '@']
const FOOD_GLYPH = '.'
const WALL_GLYPH = '█'

function headRgb(rgb: Rgb): Rgb {
  return [Math.min(255, rgb[0] + 60), Math.min(255, rgb[1] + 60), Math.min(255, rgb[2] + 60)]
}

// Copied from packages/client/src/framebuffer.ts's rgbTo256 (same repo,
// <100 lines — copy over cross-package import per project convention).
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return 232 + Math.round(((r - 8) / 247) * 23)
  }
  const q = (v: number) => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

// --- occupancy ---------------------------------------------------------------

type CellKind =
  | { t: 'empty' }
  | { t: 'wall' }
  | { t: 'food' }
  | { t: 'snake'; id: number; head: boolean }

interface Occupancy {
  snakeAt: Map<number, { id: number; head: boolean }>
  foodAt: Set<number>
}

function buildOccupancy(s: MatchState): Occupancy {
  const snakeAt = new Map<number, { id: number; head: boolean }>()
  for (const sn of s.snakes) {
    if (!sn.alive) continue
    sn.cells.forEach((c, i) => snakeAt.set(idx(c.x, c.y), { id: sn.id, head: i === 0 }))
  }
  const foodAt = new Set<number>()
  for (const f of s.food) foodAt.add(idx(f.x, f.y))
  return { snakeAt, foodAt }
}

// Draw priority: snake (head/body) > wall (border/closed ring) > food > empty
// — a snake can never legally occupy a wall or food cell mid-step, but this
// keeps the lookup unambiguous regardless.
function cellKind(s: MatchState, occ: Occupancy, x: number, y: number): CellKind {
  const i = idx(x, y)
  const sn = occ.snakeAt.get(i)
  if (sn) return { t: 'snake', id: sn.id, head: sn.head }
  if (isWall(x, y, s.rings)) return { t: 'wall' }
  if (occ.foodAt.has(i)) return { t: 'food' }
  return { t: 'empty' }
}

function kindRgb(kind: CellKind): Rgb | null {
  switch (kind.t) {
    case 'snake':
      return kind.head ? headRgb(SNAKE_RGB[kind.id]!) : SNAKE_RGB[kind.id]!
    case 'wall':
      return WALL_RGB
    case 'food':
      return FOOD_RGB
    case 'empty':
      return null
  }
}

function kindGlyph(kind: CellKind): string {
  switch (kind.t) {
    case 'snake':
      return kind.head ? HEAD_GLYPH[kind.id]! : BODY_GLYPH[kind.id]!
    case 'wall':
      return WALL_GLYPH
    case 'food':
      return FOOD_GLYPH
    case 'empty':
      return ' '
  }
}

// --- arena (half-block compositing) -----------------------------------------

interface PixelToken {
  glyph: string
  fg: Rgb | null // top pixel color
  bg: Rgb | null // bottom pixel color
}

// The drawn frame border carries WALL_RGB — the brief's "closed rings = the
// border color" means the in-arena ring cells REUSE this color, so the border
// itself must be painted with it (dim neutral, consistent with
// bomber-client's wall palette). Mono stays escape-free: composeLine's mono
// branch renders glyphs only and never reads fg/bg.
const BORDER_TOKEN: PixelToken = { glyph: WALL_GLYPH, fg: WALL_RGB, bg: null }

// One half-block char per (top, bottom) logical-pixel pair. Mono has no
// concept of stacked fg/bg, so it picks whichever of the pair carries content
// (top preferred) and renders that one glyph — space only when both are
// background, keeping row/col geometry identical across every color mode.
function composePixel(top: CellKind, bot: CellKind, mode: ColorMode): PixelToken {
  if (mode === 'mono') {
    const chosen = top.t !== 'empty' ? top : bot.t !== 'empty' ? bot : null
    return { glyph: chosen ? kindGlyph(chosen) : ' ', fg: null, bg: null }
  }
  const fg = kindRgb(top)
  const bg = kindRgb(bot)
  if (!fg && !bg) return { glyph: ' ', fg: null, bg: null }
  return { glyph: '▀', fg, bg }
}

function arenaRow(s: MatchState, occ: Occupancy, k: number, charRow: number, mode: ColorMode): PixelToken[] {
  const pxW = GRID_W * k
  const tokens: PixelToken[] = []
  for (let cx = 0; cx < pxW; cx++) {
    const lx = Math.floor(cx / k)
    const topLy = Math.floor((charRow * 2) / k)
    const botLy = Math.floor((charRow * 2 + 1) / k)
    const top = cellKind(s, occ, lx, topLy)
    const bot = cellKind(s, occ, lx, botLy)
    tokens.push(composePixel(top, bot, mode))
  }
  return tokens
}

// Delta-encodes fg/bg color state across the token stream — only emits an SGR
// escape when either channel actually changes from the previous cell, so a
// mostly-empty arena row (or a solid-color border row) costs a couple of
// escapes rather than one per pixel.
function composeLine(tokens: readonly PixelToken[], mode: ColorMode): string {
  if (mode === 'mono') return tokens.map((t) => t.glyph).join('')

  let out = ''
  let curFgKey: string | null = null
  let curBgKey: string | null = null

  const fgKey = (t: PixelToken): string | null => {
    if (!t.fg) return null
    return mode === 'truecolor' ? `38;2;${t.fg[0]};${t.fg[1]};${t.fg[2]}` : `38;5;${rgbTo256(...t.fg)}`
  }
  const bgKey = (t: PixelToken): string | null => {
    if (!t.bg) return null
    return mode === 'truecolor' ? `48;2;${t.bg[0]};${t.bg[1]};${t.bg[2]}` : `48;5;${rgbTo256(...t.bg)}`
  }

  for (const t of tokens) {
    const fk = fgKey(t)
    const bk = bgKey(t)
    if (fk !== curFgKey || bk !== curBgKey) {
      const parts = [fk ?? '39', bk ?? '49']
      out += `${ESC}[${parts.join(';')}m`
      curFgKey = fk
      curBgKey = bk
    }
    out += t.glyph
  }
  // Only trail a reset if the stream ended in a non-default color state — a
  // row that already returned to default mid-stream (e.g. the plain border
  // token after a colored arena run) needs no second, redundant reset.
  if (curFgKey !== null || curBgKey !== null) out += RESET
  return out
}

// --- HUD ---------------------------------------------------------------------

const HUD_WIDTH = 22

function fmtClock(tick: number): string {
  const totalSec = Math.max(0, Math.floor(tick / TICK_RATE))
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function speedNow(tick: number): number {
  return Math.round(TICK_RATE / stepTicksAt(tick))
}

// Countdown window: the last 15 in-game seconds before SHRINK_START_TICK.
const COUNTDOWN_WINDOW_TICKS = TICK_RATE * 15

function wallsCountdown(tick: number): string | null {
  if (tick >= SHRINK_START_TICK) return null
  const remainTicks = SHRINK_START_TICK - tick
  if (remainTicks > COUNTDOWN_WINDOW_TICKS) return null
  const remainSec = Math.ceil(remainTicks / TICK_RATE)
  return `walls close in ${remainSec}s!`
}

function swatchText(id: number, mode: ColorMode): string {
  if (mode === 'truecolor') {
    const rgb = SNAKE_RGB[id]!
    return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m██${RESET}`
  }
  if (mode === '256') {
    return `${ESC}[${SNAKE_BASIC[id]}m██${RESET}`
  }
  const g = BODY_GLYPH[id]!
  return g + g
}

// The swatch carries its own color escape (visible width 2), so it is never
// handed to a generic raw-length slice/pad — that would cut straight through
// the escape sequence. Instead the plain-text remainder is budgeted to
// exactly fill out HUD_WIDTH on its own (swatch(2) + plain(20) = HUD_WIDTH),
// giving the whole line a known visible width without ever re-slicing the
// swatch's raw string.
const PLAYER_PLAIN_WIDTH = HUD_WIDTH - 2

function playerHudLine(sn: SnakeState, isYou: boolean, mode: ColorMode): string {
  const swatch = swatchText(sn.id, mode)
  const mark = isYou ? '▸' : ' '
  const name = sanitizeHandle(sn.name).padEnd(8).slice(0, 8)
  const len = String(sn.cells.length).padStart(3)
  const dead = sn.alive ? '' : '†'
  const plain = `${mark}${name}${len}${dead}`.padEnd(PLAYER_PLAIN_WIDTH).slice(0, PLAYER_PLAIN_WIDTH)
  return `${swatch}${plain}`
}

// Plain (no-escape) HUD rows are always raw-sliced/padded to exactly
// HUD_WIDTH — safe because they never carry color escapes.
function padPlain(text: string): string {
  return text.length > HUD_WIDTH ? text.slice(0, HUD_WIDTH) : text.padEnd(HUD_WIDTH)
}

const BOTTOM_HINT = 'wasd/arrows steer · esc quit'

function buildHudRows(s: MatchState, you: number, mode: ColorMode, totalRows: number): string[] {
  const hud: string[] = new Array(totalRows).fill(' '.repeat(HUD_WIDTH))
  let r = 0
  for (const sn of s.snakes) {
    if (r >= totalRows) break
    hud[r++] = playerHudLine(sn, sn.id === you, mode)
  }
  r++ // blank spacer row
  if (r < totalRows) hud[r++] = padPlain(fmtClock(s.tick))
  if (r < totalRows) hud[r++] = padPlain(`spd ${speedNow(s.tick)}/s`)
  const countdown = wallsCountdown(s.tick)
  if (countdown && r < totalRows) hud[r++] = padPlain(countdown)
  hud[totalRows - 1] = padPlain(BOTTOM_HINT)
  return hud
}

// --- frame assembly -----------------------------------------------------------

export function renderFrame(state: MatchState, you: number, layout: Layout, statusLine: string, mode: ColorMode): string {
  const { k } = layout
  const occ = buildOccupancy(state)
  const pxW = GRID_W * k
  const pxH = GRID_H * k
  const charCols = pxW
  const charRows = pxH / 2
  const totalBorderRows = charRows + 2 // top border + arena rows + bottom border

  const hud = buildHudRows(state, you, mode, totalBorderRows)

  const lines: string[] = []

  // top border
  const topTokens: PixelToken[] = new Array(charCols + 2).fill(BORDER_TOKEN)
  lines.push(padHud(composeLine(topTokens, mode), hud[0] ?? ''))

  // arena rows, each flanked by a left/right border pixel
  for (let cy = 0; cy < charRows; cy++) {
    const row = arenaRow(state, occ, k, cy, mode)
    const tokens: PixelToken[] = [BORDER_TOKEN, ...row, BORDER_TOKEN]
    lines.push(padHud(composeLine(tokens, mode), hud[cy + 1] ?? ''))
  }

  // bottom border
  const bottomTokens: PixelToken[] = new Array(charCols + 2).fill(BORDER_TOKEN)
  lines.push(padHud(composeLine(bottomTokens, mode), hud[totalBorderRows - 1] ?? ''))

  // status row
  lines.push(statusLine.slice(0, charCols + 2 + HUD_WIDTH))

  // Per-line clear-to-EOL (ESC[K) kills resize residue to the right of every
  // line (checkwait/chess-4 lesson, see bomber-client's renderFrame); leading
  // ESC[H repaints from the top-left every frame instead of scrolling, and
  // trailing ESC[J kills residue below — the renderer never scrolls, so both
  // are always safe. composeLine already RESETs at the end of any border/
  // arena row that ended in a non-default color (see composeLine above), so
  // this trailing RESET is a final belt-and-suspenders guarantee that the
  // whole frame — including the caller-supplied statusLine — hands the
  // terminal back in a default color state; matches bomber-client's tail
  // exactly. Mono frames carry no SGR at all, so there is nothing to reset.
  const tail = mode === 'mono' ? '' : RESET
  return `${ESC}[H` + lines.join(`${ESC}[K\r\n`) + tail + `${ESC}[J`
}

// Right HUD sidebar: hudText arrives already budgeted to exactly HUD_WIDTH
// visible columns (see buildHudRows/playerHudLine/padPlain) — appended
// directly after the border/arena content with NO separator, so every
// composed line is structurally exactly (GRID_W*k + 2) + HUD_WIDTH visible
// columns (58 + 22 = 80 at k=1). No trailing trim: the plan mandates the HUD
// pads every line to exactly 80 visible cols, and both halves are built to
// fixed visible widths, so simple concatenation IS the padding contract.
function padHud(border: string, hudText: string): string {
  return `${border}${hudText}`
}
