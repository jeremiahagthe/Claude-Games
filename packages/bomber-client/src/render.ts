import type { Bomb, BomberState, Drop, Flame, PlayerState, PowerupKind } from 'boomwait-core'
import { GRID_H, GRID_W, FUSE_TICKS, SHRINK_START_TICK, TICK_RATE, idx } from 'boomwait-core'
import type { ColorMode } from 'termwait'
import { SPRITES, scaleMask } from './sprites.js'

export interface Layout {
  r: number
  sideHud: boolean
  glyph: boolean
}

// Board = 26r cols x 11r rows (tile = 2r cols x r rows; GRID_W=13 tiles wide,
// GRID_H=11 tall). Largest r wins, preferring a side HUD (board gets every
// row — the checkwait/chess-4d lesson: default terminals are wide but short,
// so a below-board HUD line can starve the board of rows before the board
// ever needs the extra width) whenever it fits; the below-board ladder only
// matters for narrow-but-tall windows. r<2 or non-truecolor drops to glyph
// mode (2 cols/tile letters — an 8x8 pixel sprite scaled into <2 rows is
// illegible, and non-truecolor terminals can't composite the half-block fg/bg
// pairs sprites rely on).
function fitsSideHud(r: number, cols: number, rows: number): boolean {
  return 11 * r + 1 <= rows && 26 * r + 27 <= cols
}
function fitsBelowHud(r: number, cols: number, rows: number): boolean {
  return 11 * r + 1 <= rows && 26 * r <= cols && 11 * r + 8 <= rows
}

export function chooseLayout(cols: number, rows: number, mode: ColorMode): Layout {
  const upperBound = Math.floor((rows - 1) / 11)
  let foundR = 0
  let foundSideHud = false
  for (let r = Math.max(upperBound, 1); r >= 1; r--) {
    const sideOk = fitsSideHud(r, cols, rows)
    const belowOk = fitsBelowHud(r, cols, rows)
    if (sideOk || belowOk) {
      foundR = r
      foundSideHud = sideOk // side HUD preferred whenever it fits
      break
    }
  }
  const glyph = mode !== 'truecolor' || foundR < 2
  return { r: Math.max(foundR, 1), sideHud: foundSideHud, glyph }
}

const ESC = '\x1b'
const RESET = `${ESC}[0m`
function bg(rgb: readonly [number, number, number]): string {
  return `${ESC}[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}
function fg(rgb: readonly [number, number, number]): string {
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

const HARD_RGB: readonly [number, number, number] = [92, 92, 100]
const SOFT_RGB: readonly [number, number, number] = [163, 116, 58]
const SOFT_TEXTURE_RGB: readonly [number, number, number] = [110, 78, 38]
const EMPTY_RGB: readonly [number, number, number] = [40, 92, 48]
const FLAME_BG_RGB: readonly [number, number, number] = [120, 30, 20]
const FLAME_FG_RGB: readonly [number, number, number] = [255, 200, 60]
const BOMB_SPARK_RGB: readonly (readonly [number, number, number])[] = [
  [255, 255, 255],
  [255, 210, 60],
  [255, 60, 40],
]
// 4 distinct, high-contrast team colors (feel-1 lesson: every fg must
// contrast every bg it can land on — floor/soft/hard are all mid-dark, so
// bright saturated hues stay legible on all three).
const TEAM_RGB: readonly (readonly [number, number, number])[] = [
  [230, 70, 70], // p0 red
  [70, 150, 235], // p1 blue
  [110, 220, 110], // p2 green
  [235, 205, 70], // p3 gold
]
const DROP_RGB: Record<PowerupKind, readonly [number, number, number]> = {
  bomb: [210, 210, 220],
  range: [80, 225, 225],
  speed: [255, 230, 90],
}

function bombFuseStage(fuse: number): 0 | 1 | 2 {
  if (fuse > (2 * FUSE_TICKS) / 3) return 0
  if (fuse > FUSE_TICKS / 3) return 1
  return 2
}

interface Occupancy {
  flameAt: Map<number, Flame>
  bombAt: Map<number, Bomb>
  playerAt: Map<number, number> // tile idx -> player id (last-in-order wins)
  dropAt: Map<number, Drop>
}

function buildOccupancy(s: BomberState): Occupancy {
  const flameAt = new Map<number, Flame>()
  for (const f of s.flames) flameAt.set(idx(f.x, f.y), f)
  const bombAt = new Map<number, Bomb>()
  for (const b of s.bombs) bombAt.set(idx(b.x, b.y), b)
  const playerAt = new Map<number, number>()
  for (const p of s.players) if (p.alive) playerAt.set(idx(p.x, p.y), p.id)
  const dropAt = new Map<number, Drop>()
  for (const d of s.drops) dropAt.set(idx(d.x, d.y), d)
  return { flameAt, bombAt, playerAt, dropAt }
}

interface TileVisual {
  bgRgb: readonly [number, number, number]
  maskKey: string | null
  fgRgb: readonly [number, number, number]
}

// Draw priority: flame > player > bomb > drop > bare cell — a flame front
// visually consumes whatever was under it, and a player standing on their own
// (or anyone's) bomb/drop is the thing you're tracking, not the tile.
function tileVisual(s: BomberState, occ: Occupancy, x: number, y: number): TileVisual {
  const i = idx(x, y)
  const cell = s.grid[i]
  const baseBg = cell === 'hard' ? HARD_RGB : cell === 'soft' ? SOFT_RGB : EMPTY_RGB

  if (occ.flameAt.has(i)) return { bgRgb: FLAME_BG_RGB, maskKey: 'flame', fgRgb: FLAME_FG_RGB }

  const playerId = occ.playerAt.get(i)
  if (playerId !== undefined) return { bgRgb: baseBg, maskKey: `p${playerId}`, fgRgb: TEAM_RGB[playerId]! }

  const bomb = occ.bombAt.get(i)
  if (bomb) {
    const stage = bombFuseStage(bomb.fuse)
    return { bgRgb: baseBg, maskKey: `bomb${stage}`, fgRgb: BOMB_SPARK_RGB[stage]! }
  }

  const drop = occ.dropAt.get(i)
  if (drop) return { bgRgb: baseBg, maskKey: `drop-${drop.kind}`, fgRgb: DROP_RGB[drop.kind] }

  if (cell === 'soft') return { bgRgb: baseBg, maskKey: 'soft', fgRgb: SOFT_TEXTURE_RGB }
  return { bgRgb: baseBg, maskKey: null, fgRgb: baseBg }
}

// Sprite-mode arena: half-block ▀▄ pixel compositing (chess-4's
// board-render.ts pipeline), one 2r x 2r pixel grid per tile.
function spriteArena(s: BomberState, occ: Occupancy, r: number): string[] {
  const px = 2 * r
  const scaleCache = new Map<string, boolean[][]>()
  const scaled = (key: string): boolean[][] => {
    let m = scaleCache.get(key)
    if (!m) {
      m = scaleMask(SPRITES[key]!, px)
      scaleCache.set(key, m)
    }
    return m
  }

  const lines: string[] = []
  for (let ty = 0; ty < GRID_H; ty++) {
    for (let subRow = 0; subRow < r; subRow++) {
      let line = ''
      for (let tx = 0; tx < GRID_W; tx++) {
        const v = tileVisual(s, occ, tx, ty)
        let cell = bg(v.bgRgb)
        if (v.maskKey) {
          const mask = scaled(v.maskKey)
          const topRow = mask[2 * subRow]
          const botRow = mask[2 * subRow + 1]
          const sprFg = fg(v.fgRgb)
          for (let px_ = 0; px_ < px; px_++) {
            const top = topRow?.[px_] === true
            const bot = botRow?.[px_] === true
            if (!top && !bot) cell += ' '
            else cell += sprFg + (top && bot ? '█' : top ? '▀' : '▄')
          }
        } else {
          cell += ' '.repeat(px)
        }
        line += cell + RESET
      }
      lines.push(line)
    }
  }
  return lines
}

// Basic-SGR (30-107 range) fallbacks for the truecolor palette above — glyph
// mode usually exists BECAUSE the terminal isn't truecolor (Apple Terminal
// detects as '256'), so it must not emit 24-bit escapes there. Mirrors chess
// board-render.ts's dedicated basic-mode branch.
const TEAM_BASIC: readonly number[] = [91, 94, 92, 93] // bright red/blue/green/yellow
const FLAME_BASIC = 93
const BOMB_SPARK_BASIC: readonly number[] = [97, 93, 91] // white → yellow → red, matching the RGB fuse ramp
const DROP_BASIC: Record<PowerupKind, number> = { bomb: 97, range: 96, speed: 93 }
const SOFT_BASIC = 33

// Glyph-mode arena: 2 cols/tile letters — legible with no truecolor
// compositing and no minimum cell height. Color budget follows the terminal:
// truecolor keeps 24-bit fg (the r<2 tiny-window case), '256' uses basic SGR,
// mono emits no escapes at all (letters carry everything; soft's ▒ shade
// glyph also drops to ASCII there — some mono terminals are ASCII-only).
function glyphArena(s: BomberState, occ: Occupancy, mode: ColorMode): string[] {
  const paint = (text: string, rgb: readonly [number, number, number], basic: number): string =>
    mode === 'truecolor' ? fg(rgb) + text + RESET : mode === '256' ? `${ESC}[${basic}m` + text + RESET : text

  const lines: string[] = []
  for (let ty = 0; ty < GRID_H; ty++) {
    let line = ''
    for (let tx = 0; tx < GRID_W; tx++) {
      const i = idx(tx, ty)
      if (occ.flameAt.has(i)) {
        line += paint('* ', FLAME_FG_RGB, FLAME_BASIC)
        continue
      }
      const playerId = occ.playerAt.get(i)
      if (playerId !== undefined) {
        line += paint('@' + String(playerId + 1), TEAM_RGB[playerId]!, TEAM_BASIC[playerId]!)
        continue
      }
      const bomb = occ.bombAt.get(i)
      if (bomb) {
        const stage = bombFuseStage(bomb.fuse)
        line += paint('o ', BOMB_SPARK_RGB[stage]!, BOMB_SPARK_BASIC[stage]!)
        continue
      }
      const drop = occ.dropAt.get(i)
      if (drop) {
        line += paint(drop.kind[0]!.toUpperCase() + ' ', DROP_RGB[drop.kind], DROP_BASIC[drop.kind])
        continue
      }
      const cell = s.grid[i]
      if (cell === 'hard') line += '##'
      else if (cell === 'soft') line += mode === 'mono' ? 'xx' : paint('▒▒', SOFT_RGB, SOFT_BASIC)
      else line += '  '
    }
    lines.push(line)
  }
  return lines
}

function fmtClock(tick: number): string {
  const totalSec = Math.max(0, Math.floor(tick / TICK_RATE))
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

// Sudden-death shrink starts at SHRINK_START_TICK; the HUD counts down to it,
// then flags it active once the spiral starts closing tiles.
function shrinkStatus(tick: number): string {
  if (tick >= SHRINK_START_TICK) return '⚠ shrinking'
  const remainSec = Math.ceil((SHRINK_START_TICK - tick) / TICK_RATE)
  return `shrink in ${remainSec}s`
}

function playerLine(p: PlayerState, isYou: boolean): string {
  const mark = isYou ? '▸' : ' '
  const dead = p.alive ? '' : ' †'
  return `${mark}${p.name}${dead}`
}

// Fixed side-HUD text budget (matches the `+ 27` in fitsSideHud — constant
// regardless of r, so renderFrame doesn't need cols/rows: chooseLayout only
// ever returns a Layout whose canonical rendered size already fits whatever
// terminal it was computed against).
const SIDE_TEXT_WIDTH = 26

// Spec HUD row: color swatch, name, alive/dead, bomb/range/speed counts. The
// swatch carries a color escape, so it is built and width-budgeted here
// (never handed to renderFrame's generic `text.slice(0, SIDE_TEXT_WIDTH)`,
// which operates on raw chars and would slice straight through an escape
// sequence, corrupting the terminal for every line after it) — 1 visible col
// for the swatch, the rest of the budget for the plain-text remainder.
function playerHudRow(p: PlayerState, isYou: boolean, mode: ColorMode): string {
  const swatch =
    mode === 'truecolor'
      ? fg(TEAM_RGB[p.id]!) + '■' + RESET
      : mode === '256'
        ? `${ESC}[${TEAM_BASIC[p.id]!}m■${RESET}`
        : '#'
  const mark = isYou ? '▸' : ' '
  const dead = p.alive ? ' †' : ''
  const stats = p.alive ? ` b${p.bombCap}r${p.range}s${p.speed}` : ''
  const plain = `${mark}${p.name}${dead}${stats}`
  return swatch + plain.slice(0, SIDE_TEXT_WIDTH - 1)
}

// Two lines so each stays within SIDE_TEXT_WIDTH (26 cols) — matches the
// README's boomwait-controls table wording.
const KEY_HINT_ROWS: readonly string[] = ['wasd/arrows move', 'space bomb, q-q quit']

export function renderFrame(s: BomberState, you: number, layout: Layout, claude: string, mode: ColorMode = 'truecolor'): string {
  const { r, sideHud, glyph } = layout
  const occ = buildOccupancy(s)
  const arenaLines = glyph ? glyphArena(s, occ, mode) : spriteArena(s, occ, r)
  const boardCols = glyph ? GRID_W * 2 : GRID_W * 2 * r

  const clock = fmtClock(s.tick)
  const shrink = shrinkStatus(s.tick)
  const names = s.players.map((p) => playerLine(p, p.id === you))

  const lines: string[] = []

  if (sideHud) {
    // Per spec: player rows (color swatch, name, alive/dead, bomb/range/speed
    // counts), round timer, shrink warning, Claude status (appended by the
    // caller as `claude` below — already present), key hints. Player rows
    // carry their own pre-budgeted color escape (see playerHudRow) and are
    // appended verbatim; every other row here is plain text and goes through
    // the same generic width slice as before.
    const plainRows = [clock, shrink]
    const playerRows = s.players.map((p) => playerHudRow(p, p.id === you, mode))
    const hintRows = KEY_HINT_ROWS
    for (let i = 0; i < arenaLines.length; i++) {
      let line = arenaLines[i]!
      if (i < plainRows.length) {
        const text = plainRows[i]
        if (text) line += ' ' + text.slice(0, SIDE_TEXT_WIDTH)
      } else if (i < plainRows.length + playerRows.length) {
        line += ' ' + playerRows[i - plainRows.length]!
      } else if (i < plainRows.length + playerRows.length + hintRows.length) {
        const text = hintRows[i - plainRows.length - playerRows.length]
        if (text) line += ' ' + text.slice(0, SIDE_TEXT_WIDTH)
      }
      lines.push(line)
    }
  } else {
    lines.push(...arenaLines)
    const belowText = `${clock}  ${shrink}  ${names.join('  ')}`
    lines.push(belowText.slice(0, boardCols))
  }

  const statusWidth = boardCols + (sideHud ? SIDE_TEXT_WIDTH + 1 : 0)
  lines.push(claude.slice(0, statusWidth))

  // Per-line clear-to-EOL (ESC[K) kills resize residue to the right of every
  // line (checkwait/chess-4 lesson); trailing ESC[J kills residue below —
  // the renderer never scrolls, so both are always safe. Mono frames carry no
  // SGR at all, so there is nothing to reset there.
  const tail = mode === 'mono' ? '' : RESET
  return `${ESC}[H` + lines.join(`${ESC}[K\r\n`) + tail + `${ESC}[J`
}
