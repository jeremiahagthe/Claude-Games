import { GRID_H, GRID_W, MAX_PLAYERS } from './constants.js'
import type { Cellxy, Dir, Food, Input, MatchState, Result, SnakeState } from './state.js'

export const MAX_RAW = 4096 // inbound size cap (matches fragwait/bomber-core), applied both directions

export interface HelloMsg {
  t: 'hello'
  name: string
} // client→server

export interface InputMsg {
  t: 'input'
  dir: Dir // sent only on change; no null/keep
} // client→server

export interface StartMsg {
  t: 'start'
  you: number
  seed: number
  names: string[]
  bots: boolean[]
} // server→client

export interface SnapMsg {
  t: 'snap'
  state: WireState
} // server→client, every tick

export interface EndMsg {
  t: 'end'
  result: [0, number] | [1] // [0,winner] | [1]=draw
} // server→client

export type SnakeClientMsg = HelloMsg | InputMsg
export type SnakeServerMsg = StartMsg | SnapMsg | EndMsg

// --- Compact wire form -------------------------------------------------
// dirCode: 1=up 2=down 3=left 4=right; 0 = pendingDir null (never a valid
// heading/segment direction, only used for pendCode).
//
// [id, name, bot(0|1), alive(0|1), dirCode, pendCode, growth, headX, headY, segments]
// segments: (dirCode, count)[] — RLE over the body cells AFTER the head,
// walking HEAD → TAIL. Each segment's dir points from a cell to the NEXT
// cell toward the tail.
export type WireSnake = [number, string, number, number, number, number, number, number, number, [number, number][]]

export interface WireState {
  tick: number
  cd: number
  rng: number
  rings: number
  food: [number, number][]
  snakes: WireSnake[]
  result: [0, number] | [1] | null
}

// Copied verbatim from bomber-core's packages/bomber-core/src/protocol.ts
// sanitizeHandle (itself copied from fragwait's packages/core/src/protocol.ts):
// lowercase, strip everything outside [a-z0-9-] (this also strips the '·'
// glyph reserved for bot names), cap at 24 chars, fall back to 'anon' if empty.
export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

const DIR_LIST: Dir[] = ['up', 'down', 'left', 'right']
const DELTA: Record<Dir, Cellxy> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}
const GRID_CELLS = GRID_W * GRID_H
const MAX_NAME_LEN = 24
// Generous-but-finite cap on wire growth magnitude — no legitimate value comes
// close (bounded by GROWTH_PER_FOOD * total food eaten in a match). The cap
// exists so a hostile snap that passes parse can never decode into an absurd
// magnitude.
const MAX_WIRE_STAT = 255
// Sudden-death rings shrink from all four edges inward; the grid is fully
// closed once rings reaches half the smaller grid dimension.
const MAX_RINGS = Math.min(GRID_W, GRID_H) / 2

function dirToCode(d: Dir): number {
  return DIR_LIST.indexOf(d) + 1
}

function codeToDir(c: number): Dir | null {
  if (c === 0) return null
  return DIR_LIST[c - 1] ?? null
}

function deltaToDir(dx: number, dy: number): Dir {
  for (const d of DIR_LIST) {
    if (DELTA[d].x === dx && DELTA[d].y === dy) return d
  }
  // Unreachable for valid adjacent snake cells (every consecutive cell pair
  // differs by exactly one grid step).
  throw new Error(`non-adjacent cells: dx=${dx} dy=${dy}`)
}

// --- toWire / fromWire ---------------------------------------------------

export function toWire(s: MatchState): WireState {
  const snakes: WireSnake[] = s.snakes.map((sn) => {
    const segments: [number, number][] = []
    for (let i = 0; i < sn.cells.length - 1; i++) {
      const a = sn.cells[i]!
      const b = sn.cells[i + 1]!
      const dirCode = dirToCode(deltaToDir(b.x - a.x, b.y - a.y))
      const last = segments[segments.length - 1]
      if (last && last[0] === dirCode) {
        last[1] += 1
      } else {
        segments.push([dirCode, 1])
      }
    }
    const head = sn.cells[0]
    return [
      sn.id,
      sn.name,
      sn.bot ? 1 : 0,
      sn.alive ? 1 : 0,
      dirToCode(sn.dir),
      sn.pendingDir === null ? 0 : dirToCode(sn.pendingDir),
      sn.growth,
      head ? head.x : 0,
      head ? head.y : 0,
      segments,
    ]
  })

  const food: [number, number][] = s.food.map((f) => [f.x, f.y])
  const result: WireState['result'] =
    s.result === null ? null : s.result.kind === 'win' ? [0, s.result.winner] : [1]

  return { tick: s.tick, cd: s.stepCooldown, rng: s.rng, rings: s.rings, food, snakes, result }
}

export function fromWire(w: WireState): MatchState {
  const snakes: SnakeState[] = w.snakes.map((sn) => {
    const [id, name, bot, alive, dirCode, pendCode, growth, headX, headY, segments] = sn
    const cells: Cellxy[] = []
    if (alive === 1) {
      let cur: Cellxy = { x: headX, y: headY }
      cells.push(cur)
      for (const [segDir, count] of segments) {
        const delta = DELTA[codeToDir(segDir)!]
        for (let k = 0; k < count; k++) {
          cur = { x: cur.x + delta.x, y: cur.y + delta.y }
          cells.push(cur)
        }
      }
    }
    return {
      id,
      name,
      bot: bot === 1,
      alive: alive === 1,
      dir: codeToDir(dirCode)!,
      pendingDir: codeToDir(pendCode),
      cells,
      growth,
    }
  })

  const food: Food[] = w.food.map(([x, y]) => ({ x, y }))
  const result: Result | null = w.result === null ? null : w.result[0] === 0 ? { kind: 'win', winner: w.result[1] } : { kind: 'draw' }

  return {
    tick: w.tick,
    stepCooldown: w.cd,
    rng: w.rng,
    rings: w.rings,
    snakes,
    food,
    result,
  }
}

// --- validation helpers ---------------------------------------------------

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isPlayerId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_PLAYERS
}

function isCoordX(v: unknown): v is number {
  return isNonNegInt(v) && v < GRID_W
}

function isCoordY(v: unknown): v is number {
  return isNonNegInt(v) && v < GRID_H
}

function isStat(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_WIRE_STAT
}

function isDirCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= DIR_LIST.length
}

function isPendCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DIR_LIST.length
}

function isRings(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_RINGS
}

function isRng(v: unknown): v is number {
  return isNonNegInt(v) && v <= 0xffffffff
}

function isDirLiteral(v: unknown): v is Dir {
  return typeof v === 'string' && (DIR_LIST as string[]).includes(v)
}

function isFoodItem(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isCoordX(v[0]) && isCoordY(v[1])
}

function isSegment(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isDirCode(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isInteger(v[1]) &&
    v[1] >= 1 &&
    v[1] <= GRID_CELLS
  )
}

function isWireSnake(v: unknown): v is WireSnake {
  if (!Array.isArray(v) || v.length !== 10) return false
  const [id, name, bot, alive, dirCode, pendCode, growth, headX, headY, segments] = v
  return (
    isPlayerId(id) &&
    typeof name === 'string' &&
    name.length <= MAX_NAME_LEN &&
    (bot === 0 || bot === 1) &&
    (alive === 0 || alive === 1) &&
    isDirCode(dirCode) &&
    isPendCode(pendCode) &&
    isStat(growth) &&
    isCoordX(headX) &&
    isCoordY(headY) &&
    Array.isArray(segments) &&
    segments.length <= GRID_CELLS &&
    segments.every(isSegment)
  )
}

function isWireResult(v: unknown): v is WireState['result'] {
  if (v === null) return true
  if (!Array.isArray(v)) return false
  if (v.length === 1) return v[0] === 1
  if (v.length === 2) return v[0] === 0 && isPlayerId(v[1])
  return false
}

function isWireState(v: unknown): v is WireState {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!isNonNegInt(o['tick'])) return false
  if (!isNonNegInt(o['cd'])) return false
  if (!isRng(o['rng'])) return false
  if (!isRings(o['rings'])) return false
  if (!Array.isArray(o['food']) || o['food'].length > GRID_CELLS || !o['food'].every(isFoodItem)) return false
  if (!Array.isArray(o['snakes']) || o['snakes'].length > MAX_PLAYERS || !o['snakes'].every(isWireSnake)) return false
  if (!isWireResult(o['result'])) return false
  return true
}

// Rebuilds a fresh WireState literal from an already-validated object —
// never hands back a reference into attacker-controlled JSON (no field
// smuggling of extra properties riding along on the wire).
function freshWireState(o: WireState): WireState {
  return {
    tick: o.tick,
    cd: o.cd,
    rng: o.rng,
    rings: o.rings,
    food: o.food.map(([x, y]): [number, number] => [x, y]),
    snakes: o.snakes.map((sn): WireSnake => [...sn.slice(0, 9), sn[9].map((seg) => [...seg] as [number, number])] as WireSnake),
    result: o.result === null ? null : o.result.length === 1 ? [1] : [0, o.result[1]],
  }
}

function freshEndResult(r: [0, number] | [1]): [0, number] | [1] {
  return r.length === 1 ? [1] : [0, r[1]]
}

// --- parse -----------------------------------------------------------------

export function parseSnakeClientMsg(raw: unknown): SnakeClientMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>

  if (o['t'] === 'hello' && typeof o['name'] === 'string') {
    return { t: 'hello', name: sanitizeHandle(o['name']) }
  }
  if (o['t'] === 'input' && isDirLiteral(o['dir'])) {
    return { t: 'input', dir: o['dir'] }
  }
  return null
}

export function parseSnakeServerMsg(raw: unknown): SnakeServerMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>

  if (o['t'] === 'start') {
    const you = o['you']
    const seed = o['seed']
    const names = o['names']
    const bots = o['bots']
    if (!isPlayerId(you)) return null
    if (!isFiniteNum(seed)) return null
    if (!Array.isArray(names) || names.length !== MAX_PLAYERS || !names.every((n) => typeof n === 'string' && n.length <= MAX_NAME_LEN)) return null
    if (!Array.isArray(bots) || bots.length !== MAX_PLAYERS || !bots.every((b) => typeof b === 'boolean')) return null
    return { t: 'start', you, seed, names: [...(names as string[])], bots: [...(bots as boolean[])] }
  }
  if (o['t'] === 'snap' && isWireState(o['state'])) {
    return { t: 'snap', state: freshWireState(o['state']) }
  }
  if (o['t'] === 'end' && isWireResult(o['result']) && o['result'] !== null) {
    return { t: 'end', result: freshEndResult(o['result'] as [0, number] | [1]) }
  }
  return null
}
