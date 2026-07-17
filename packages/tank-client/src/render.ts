import type { MatchState, Shot } from 'tankwait-core'
import { HP_MAX, sanitizeHandle } from 'tankwait-core'
import type { ColorMode } from 'termwait'

// v1 is k=1 only — no scaling. Layout carries cols/rows so renderFrame can
// center the fixed 80x24 frame inside an oversized terminal (left pad +
// leading blank lines); at exactly 80x24 the padding is zero and output is
// byte-identical to the unpadded frame.
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
  const msg = 'tankwait needs 80x24'
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

// --- world → screen -----------------------------------------------------------

// heights[]/trajectories are in world y (up, floor 0, half-row granularity).
// Screen rows 2..22 hold the terrain field; row 22 is the floor.
export function screenRow(y: number): number {
  return 22 - Math.floor(y / 2)
}

const FIELD_TOP_ROW = 2
const FIELD_BOTTOM_ROW = 22
const SHELL_CLIP_Y = 41.5

function clampRow(row: number): number {
  return Math.max(FIELD_TOP_ROW, Math.min(FIELD_BOTTOM_ROW, row))
}

function clampCol(x: number): number {
  return Math.max(0, Math.min(79, Math.round(x)))
}

// --- RenderView ----------------------------------------------------------------

export interface RenderView {
  state: MatchState
  you: 0 | 1
  aim: Shot // your current aim (HUD readout)
  phase: 'aim' | 'anim' | 'wait' // wait = opponent aiming
  shell: [number, number] | null // world coords during playback
  trail: [number, number][] // world coords of the trail so far
  explosion: { x: number; y: number; frame: number } | null // frame 0..5
  clockMsLeft: number | null // shot-clock countdown (null during anim)
  statusLine: string
}

// --- colors ----------------------------------------------------------------

type Rgb = readonly [number, number, number]

// 3 pinned earth-tone bands by screen row (not world depth — deterministic
// regardless of terrain height, split evenly across the field's 21 rows).
const EARTH_RGB: readonly [Rgb, Rgb, Rgb] = [
  [120, 72, 32],
  [90, 54, 24],
  [54, 34, 14],
]
const EARTH_256: readonly [number, number, number] = [94, 58, 22]

function earthBand(row: number): number {
  if (row <= 8) return 0
  if (row <= 15) return 1
  return 2
}

const TANK_RGB: readonly [Rgb, Rgb] = [
  [40, 200, 80],
  [220, 60, 60],
]
const TANK_256: readonly [number, number] = [42, 203]
const HIGHLIGHT_RGB: Rgb = [255, 220, 80]
const HIGHLIGHT_256 = 220

function colorEscape(mode: ColorMode, rgb: Rgb, idx256: number): string {
  if (mode === 'truecolor') return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  return `${ESC}[38;5;${idx256}m`
}

function dimEscape(mode: ColorMode): string {
  return mode === 'mono' ? '' : `${ESC}[2m`
}

function brightEscape(mode: ColorMode): string {
  return mode === 'mono' ? '' : `${ESC}[1m`
}

// --- cell grid: build the 21x80 terrain field, then overlay tanks/anim -------

type Cell = { ch: string; wrap?: (mode: ColorMode) => [string, string] }

function terrainCell(row: number): Cell {
  const band = earthBand(row)
  return {
    ch: '█',
    wrap: (mode) => {
      if (mode === 'mono') return ['', '']
      return [colorEscape(mode, EARTH_RGB[band]!, EARTH_256[band]!), RESET]
    },
  }
}

function buildField(v: RenderView, mode: ColorMode): string[][] {
  const { state } = v
  const grid: (Cell | null)[][] = []
  for (let row = FIELD_TOP_ROW; row <= FIELD_BOTTOM_ROW; row++) grid.push(new Array(80).fill(null))
  const rowIdx = (row: number) => row - FIELD_TOP_ROW

  // terrain
  for (let col = 0; col < 80; col++) {
    const y = state.heights[col]!
    const top = clampRow(screenRow(y))
    for (let row = top; row <= FIELD_BOTTOM_ROW; row++) grid[rowIdx(row)]![col] = terrainCell(row)
  }

  // tanks
  for (const tank of state.tanks) {
    const row = clampRow(screenRow(state.heights[tank.col]!))
    const c0 = tank.col
    const c1 = Math.min(79, tank.col + 1)
    const alive = tank.alive
    const glyph = alive ? '▟▙' : '✕✕'
    const monoGlyph = alive ? (tank.id === 0 ? '▟▙' : '◢◣') : '✕✕'
    const cell = (ch: string): Cell => ({
      ch,
      wrap: (m) => {
        if (m === 'mono') return ['', '']
        return [colorEscape(m, TANK_RGB[tank.id]!, TANK_256[tank.id]!), RESET]
      },
    })
    if (row >= FIELD_TOP_ROW && row <= FIELD_BOTTOM_ROW) {
      grid[rowIdx(row)]![c0] = cell(mode === 'mono' ? monoGlyph[0]! : glyph[0]!)
      if (c1 !== c0) grid[rowIdx(row)]![c1] = cell(mode === 'mono' ? monoGlyph[1]! : glyph[1]!)
    }
  }

  // anim overlays: trail (dim ·), shell (bright ●), explosion (✶ ring)
  if (v.phase === 'anim') {
    for (const [x, y] of v.trail) {
      const row = screenRow(y)
      if (row < FIELD_TOP_ROW || row > FIELD_BOTTOM_ROW) continue
      const col = clampCol(x)
      grid[rowIdx(row)]![col] = {
        ch: '·',
        wrap: (m) => (m === 'mono' ? ['', ''] : [dimEscape(m), RESET]),
      }
    }
    if (v.shell) {
      const [x, y] = v.shell
      if (y <= SHELL_CLIP_Y) {
        const row = screenRow(y)
        if (row >= FIELD_TOP_ROW && row <= FIELD_BOTTOM_ROW) {
          const col = clampCol(x)
          grid[rowIdx(row)]![col] = {
            ch: '●',
            wrap: (m) => (m === 'mono' ? ['', ''] : [brightEscape(m), RESET]),
          }
        }
      }
    }
    if (v.explosion) {
      const { x, y, frame } = v.explosion
      const radius = frame / 2
      const r = Math.round(radius)
      const points: [number, number][] =
        r === 0
          ? [[x, y]]
          : [
              [x - r, y],
              [x + r, y],
              [x, y + r * 2], // world y is half-row granular; vertical ring step matches col step visually
              [x, y - r * 2],
            ]
      for (const [px, py] of points) {
        const row = clampRow(screenRow(py))
        const col = clampCol(px)
        grid[rowIdx(row)]![col] = {
          ch: '✶',
          wrap: (m) => (m === 'mono' ? ['', ''] : [brightEscape(m), RESET]),
        }
      }
    }
  }

  const lines: string[] = []
  for (let row = FIELD_TOP_ROW; row <= FIELD_BOTTOM_ROW; row++) {
    let line = ''
    for (let col = 0; col < 80; col++) {
      const cell = grid[rowIdx(row)]![col]
      if (!cell) {
        line += ' '
        continue
      }
      if (cell.wrap) {
        const [pre, post] = cell.wrap(mode)
        line += `${pre}${cell.ch}${post}`
      } else {
        line += cell.ch
      }
    }
    lines.push(line)
  }
  return [lines]
}

// --- HUD lines 0-1 --------------------------------------------------------------

const SIDE_WIDTH = 34
const CENTER_WIDTH = 12

function hpBar(hp: number): string {
  const filled = Math.max(0, Math.min(10, Math.round((hp / HP_MAX) * 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function padPlain(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text.padEnd(width)
}

function padPlainRight(text: string, width: number): string {
  return text.length > width ? text.slice(text.length - width) : text.padStart(width)
}

function centerPlain(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - text.length) / 2))
  return padPlain(' '.repeat(left) + text, width)
}

function wrapColor(text: string, mode: ColorMode, rgb: Rgb, idx256: number): string {
  if (mode === 'mono') return text
  return `${colorEscape(mode, rgb, idx256)}${text}${RESET}`
}

// Name display cap: the hp bar and hp number must NEVER truncate — the name
// yields instead. Residual budget = SIDE_WIDTH minus marker(1) + space(1) +
// bar(10) + space(1) + 3-digit hp reserve(3) = 34 - 16 = 18.
const NAME_DISPLAY_MAX = SIDE_WIDTH - (1 + 1 + 10 + 1 + 3)

function displayName(raw: string): string {
  return sanitizeHandle(raw).slice(0, NAME_DISPLAY_MAX)
}

function buildHudLine0(v: RenderView, mode: ColorMode): string {
  const { state } = v
  const t0 = state.tanks[0]!
  const t1 = state.tanks[1]!

  const marker0 = state.turn === 0 ? '▸' : ' '
  const leftPlain = padPlain(`${marker0}${displayName(t0.name)} ${hpBar(t0.hp)} ${t0.hp}`, SIDE_WIDTH)
  const leftSeg = state.turn === 0 ? wrapColor(leftPlain, mode, HIGHLIGHT_RGB, HIGHLIGHT_256) : leftPlain

  const marker1 = state.turn === 1 ? '◂' : ' '
  const rightPlain = padPlainRight(`${t1.hp} ${hpBar(t1.hp)} ${displayName(t1.name)}${marker1}`, SIDE_WIDTH)
  const rightSeg = state.turn === 1 ? wrapColor(rightPlain, mode, HIGHLIGHT_RGB, HIGHLIGHT_256) : rightPlain

  const centerSeg = centerPlain(`round ${state.round}`, CENTER_WIDTH)

  return `${leftSeg}${centerSeg}${rightSeg}`
}

const WIND_WIDTH = 20
const AIM_WIDTH = 40
const CLOCK_WIDTH = 20

function windSegment(wind: number): string {
  if (wind === 0) return centerPlain('— calm —', WIND_WIDTH)
  const arrows = Math.max(1, Math.min(5, Math.round((Math.abs(wind) * 5) / 10)))
  const text = wind < 0 ? `${'◀'.repeat(arrows)} ${Math.abs(wind)}` : `${Math.abs(wind)} ${'▶'.repeat(arrows)}`
  return padPlain(text, WIND_WIDTH)
}

function fmtClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function buildHudLine1(v: RenderView): string {
  const wind = windSegment(v.state.wind)
  const aim = centerPlain(`angle ${v.aim.angle}° power ${v.aim.power}`, AIM_WIDTH)
  const clock = padPlainRight(v.clockMsLeft == null ? '' : fmtClock(v.clockMsLeft), CLOCK_WIDTH)
  return `${wind}${aim}${clock}`
}

// --- status line 23 --------------------------------------------------------------

const KEY_HINTS = '←→ angle  ↑↓ power  A/D W/S ±5  space fire  esc quit'

function buildStatusLine(statusLine: string): string {
  const left = KEY_HINTS.length > 78 ? KEY_HINTS.slice(0, 78) : KEY_HINTS
  const maxRight = Math.max(0, 80 - left.length - 1)
  const right = statusLine.length > maxRight ? statusLine.slice(0, maxRight) : statusLine
  const gap = 80 - left.length - right.length
  return `${left}${' '.repeat(Math.max(0, gap))}${right}`.slice(0, 80).padEnd(80)
}

// --- frame assembly -----------------------------------------------------------

export function renderFrame(v: RenderView, layout: Layout, mode: ColorMode): string {
  const [fieldLines] = buildField(v, mode)

  const content: string[] = []
  content.push(buildHudLine0(v, mode))
  content.push(buildHudLine1(v))
  for (const l of fieldLines!) content.push(l)
  content.push(buildStatusLine(v.statusLine))

  // Centering pad for oversized terminals: floor((cols-80)/2) spaces before
  // each content line and floor((rows-24)/2) blank leading lines. Both are
  // zero at exactly 80x24, leaving the canonical frame byte-identical.
  const leftPad = ' '.repeat(Math.max(0, Math.floor((layout.cols - 80) / 2)))
  const topPad = Math.max(0, Math.floor((layout.rows - 24) / 2))

  const lines: string[] = []
  for (let i = 0; i < topPad; i++) lines.push('')
  for (const l of content) lines.push(`${leftPad}${l}`)

  // Positional framing (transcribed from packages/block-client/src/render.ts,
  // frozen reference): ESC[H repaints from the top-left instead of scrolling
  // every frame; ESC[K sits at the START of each line (not the end — a
  // trailing ESC[K on an exactly-80-column line lands the cursor in the VT
  // pending-wrap state at column 80, and an erase from there deletes the
  // line's own just-written last column); trailing ESC[J clears residue
  // below since the renderer never scrolls. Mono carries no SGR, so no
  // trailing RESET is needed for it.
  const tail = mode === 'mono' ? '' : RESET
  return `${ESC}[H${ESC}[K` + lines.join(`\r\n${ESC}[K`) + tail + `${ESC}[J`
}
