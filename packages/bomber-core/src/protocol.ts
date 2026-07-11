import { GRID_H, GRID_W, MAX_PLAYERS } from './constants.js'
import type { BomberState, Bomb, Cell, Dir, Drop, Flame, PlayerState, PowerupKind, Result } from './state.js'

export const MAX_RAW = 4096 // inbound size cap (matches fragwait), applied both directions

export interface HelloMsg {
  t: 'hello'
  name: string
} // client→server

export interface InputMsg {
  t: 'input'
  dir: Dir | null | 'keep' // 'keep' = don't touch the latch
  bomb: boolean
} // client→server

export interface StartMsg {
  t: 'start'
  you: number
  seed: number
  names: string[]
  bots: boolean[]
  startTick: number
} // server→client

export interface SnapMsg {
  t: 'snap'
  state: WireState
} // server→client, every tick

export interface EndMsg {
  t: 'end'
  result: Result
} // server→client

export type BomberClientMsg = HelloMsg | InputMsg
export type BomberServerMsg = StartMsg | SnapMsg | EndMsg

// --- Compact wire form -------------------------------------------------
// grid/hidden as digit strings, entity arrays as tuples. `hidden` is NOT
// sent (no map-hack) — fromWire reconstructs it as all-null; clients only
// render, the server owns truth.

// [id, name, bot(0|1), x, y, alive(0|1), bombCap, range, speed, dirCode, stepCooldown, activeBombs]
export type WirePlayer = [number, string, number, number, number, number, number, number, number, number, number, number]
// [owner, x, y, fuse, range]
export type WireBomb = [number, number, number, number, number]
// [x, y, ticks]
export type WireFlame = [number, number, number]
// [x, y, kindCode]
export type WireDrop = [number, number, number]
// null = ongoing, [0, winner] = win, [1] = draw
export type WireResult = [0, number] | [1] | null

export interface WireState {
  tick: number
  g: string // grid digits, length GRID_W*GRID_H
  players: WirePlayer[]
  bombs: WireBomb[]
  flames: WireFlame[]
  drops: WireDrop[]
  shrinkIndex: number
  result: WireResult
}

// Copied verbatim from fragwait's packages/core/src/protocol.ts sanitizeHandle:
// lowercase, strip everything outside [a-z0-9-] (this also strips the '·'
// glyph reserved for bot names), cap at 24 chars, fall back to 'anon' if empty.
export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

const CELL_CODE: Record<Cell, string> = { empty: '0', hard: '1', soft: '2' }
const CODE_CELL: Cell[] = ['empty', 'hard', 'soft']
const DIR_LIST: Dir[] = ['up', 'down', 'left', 'right']
const KIND_LIST: PowerupKind[] = ['bomb', 'range', 'speed']
const GRID_CELLS = GRID_W * GRID_H
const GRID_DIGITS_RE = new RegExp(`^[0-2]{${GRID_CELLS}}$`)

function dirToCode(d: Dir | null): number {
  if (d === null) return 0
  const i = DIR_LIST.indexOf(d)
  return i + 1
}

function codeToDir(c: number): Dir | null {
  if (c === 0) return null
  return DIR_LIST[c - 1] ?? null
}

// --- toWire / fromWire ---------------------------------------------------

export function toWire(s: BomberState): WireState {
  let g = ''
  for (const c of s.grid) g += CELL_CODE[c]

  const players: WirePlayer[] = s.players.map((p) => [
    p.id,
    p.name,
    p.bot ? 1 : 0,
    p.x,
    p.y,
    p.alive ? 1 : 0,
    p.bombCap,
    p.range,
    p.speed,
    dirToCode(p.dir),
    p.stepCooldown,
    p.activeBombs,
  ])

  const bombs: WireBomb[] = s.bombs.map((b) => [b.owner, b.x, b.y, b.fuse, b.range])
  const flames: WireFlame[] = s.flames.map((f) => [f.x, f.y, f.ticks])
  const drops: WireDrop[] = s.drops.map((d) => [d.x, d.y, KIND_LIST.indexOf(d.kind)])

  const result: WireResult = s.result === null ? null : s.result.kind === 'win' ? [0, s.result.winner] : [1]

  return { tick: s.tick, g, players, bombs, flames, drops, shrinkIndex: s.shrinkIndex, result }
}

export function fromWire(w: WireState): BomberState {
  const grid: Cell[] = []
  for (const ch of w.g) grid.push(CODE_CELL[Number(ch)] ?? 'empty')

  const hidden: (PowerupKind | null)[] = new Array(grid.length).fill(null)

  const players: PlayerState[] = w.players.map((p) => ({
    id: p[0],
    name: p[1],
    bot: p[2] === 1,
    x: p[3],
    y: p[4],
    alive: p[5] === 1,
    bombCap: p[6],
    range: p[7],
    speed: p[8],
    dir: codeToDir(p[9]),
    stepCooldown: p[10],
    activeBombs: p[11],
  }))

  const bombs: Bomb[] = w.bombs.map((b) => ({ owner: b[0], x: b[1], y: b[2], fuse: b[3], range: b[4] }))
  const flames: Flame[] = w.flames.map((f) => ({ x: f[0], y: f[1], ticks: f[2] }))
  const drops: Drop[] = w.drops.map((d) => ({ x: d[0], y: d[1], kind: KIND_LIST[d[2]] ?? 'bomb' }))

  const result: Result | null = w.result === null ? null : w.result[0] === 0 ? { kind: 'win', winner: w.result[1] } : { kind: 'draw' }

  return {
    tick: w.tick,
    grid,
    hidden,
    drops,
    players,
    bombs,
    flames,
    shrinkIndex: w.shrinkIndex,
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

// Generous-but-finite cap on wire stat/fuse/cooldown magnitudes. No legitimate
// value comes close: bombCap/range grow only via collected power-ups (base +
// POWERUP_COUNTS totals), fuse <= FUSE_TICKS (40), flame ticks <= FLAME_TICKS
// (10), stepCooldown <= BASE_STEP_TICKS (5). The cap exists so a hostile snap
// that passes parse can never decode (via fromWire) into absurd magnitudes.
const MAX_WIRE_STAT = 255

function isCoordX(v: unknown): v is number {
  return isNonNegInt(v) && v < GRID_W
}

function isCoordY(v: unknown): v is number {
  return isNonNegInt(v) && v < GRID_H
}

function isStat(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_WIRE_STAT
}

function isDirOrKeepOrNull(v: unknown): v is Dir | null | 'keep' {
  if (v === null || v === 'keep') return true
  return typeof v === 'string' && (DIR_LIST as string[]).includes(v)
}

function isDirCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DIR_LIST.length
}

function isKindCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < KIND_LIST.length
}

function isWirePlayer(v: unknown): v is WirePlayer {
  if (!Array.isArray(v) || v.length !== 12) return false
  const [id, name, bot, x, y, alive, bombCap, range, speed, dirCode, stepCooldown, activeBombs] = v
  return (
    isPlayerId(id) &&
    typeof name === 'string' &&
    (bot === 0 || bot === 1) &&
    isCoordX(x) &&
    isCoordY(y) &&
    (alive === 0 || alive === 1) &&
    isStat(bombCap) &&
    isStat(range) &&
    isStat(speed) &&
    isDirCode(dirCode) &&
    isStat(stepCooldown) &&
    isStat(activeBombs)
  )
}

function isWireBomb(v: unknown): v is WireBomb {
  if (!Array.isArray(v) || v.length !== 5) return false
  const [owner, x, y, fuse, range] = v
  return isPlayerId(owner) && isCoordX(x) && isCoordY(y) && isStat(fuse) && isStat(range)
}

function isWireFlame(v: unknown): v is WireFlame {
  if (!Array.isArray(v) || v.length !== 3) return false
  const [x, y, ticks] = v
  return isCoordX(x) && isCoordY(y) && isStat(ticks)
}

function isWireDrop(v: unknown): v is WireDrop {
  if (!Array.isArray(v) || v.length !== 3) return false
  const [x, y, kindCode] = v
  return isCoordX(x) && isCoordY(y) && isKindCode(kindCode)
}

function isWireResult(v: unknown): v is WireResult {
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
  if (typeof o['g'] !== 'string' || !GRID_DIGITS_RE.test(o['g'])) return false
  if (!Array.isArray(o['players']) || o['players'].length > MAX_PLAYERS || !o['players'].every(isWirePlayer)) return false
  if (!Array.isArray(o['bombs']) || !o['bombs'].every(isWireBomb)) return false
  if (!Array.isArray(o['flames']) || !o['flames'].every(isWireFlame)) return false
  if (!Array.isArray(o['drops']) || !o['drops'].every(isWireDrop)) return false
  if (typeof o['shrinkIndex'] !== 'number' || !Number.isInteger(o['shrinkIndex']) || o['shrinkIndex'] < -1) return false
  if (!isWireResult(o['result'])) return false
  return true
}

// Rebuilds a fresh WireState literal from an already-validated object —
// never hands back a reference into attacker-controlled JSON (no field
// smuggling of extra properties riding along on the wire).
function freshWireState(o: WireState): WireState {
  return {
    tick: o.tick,
    g: o.g,
    players: o.players.map((p): WirePlayer => [...p]),
    bombs: o.bombs.map((b): WireBomb => [...b]),
    flames: o.flames.map((f): WireFlame => [...f]),
    drops: o.drops.map((d): WireDrop => [...d]),
    shrinkIndex: o.shrinkIndex,
    result: o.result === null ? null : o.result.length === 1 ? [1] : [0, o.result[1]],
  }
}

const NO_WINNER_KINDS = new Set(['draw'])
const WINNER_KINDS = new Set(['win'])

function isResult(v: unknown): v is Result {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const kind = o['kind']
  if (typeof kind !== 'string') return false
  if (WINNER_KINDS.has(kind)) {
    return isPlayerId(o['winner'])
  }
  if (NO_WINNER_KINDS.has(kind)) {
    return o['winner'] === undefined
  }
  return false
}

function freshResult(r: Result): Result {
  return r.kind === 'win' ? { kind: 'win', winner: r.winner } : { kind: 'draw' }
}

// --- parse -----------------------------------------------------------------

export function parseBomberClientMsg(raw: unknown): BomberClientMsg | null {
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
  if (o['t'] === 'input' && isDirOrKeepOrNull(o['dir']) && typeof o['bomb'] === 'boolean') {
    return { t: 'input', dir: o['dir'], bomb: o['bomb'] }
  }
  return null
}

export function parseBomberServerMsg(raw: unknown): BomberServerMsg | null {
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
    const startTick = o['startTick']
    if (!isPlayerId(you)) return null
    if (!isFiniteNum(seed)) return null
    // Intentional asymmetry vs WireState.players (<= MAX_PLAYERS): start declares the full bot-padded roster, so exactly MAX_PLAYERS entries.
    if (!Array.isArray(names) || names.length !== MAX_PLAYERS || !names.every((n) => typeof n === 'string')) return null
    if (!Array.isArray(bots) || bots.length !== MAX_PLAYERS || !bots.every((b) => typeof b === 'boolean')) return null
    if (!isNonNegInt(startTick)) return null
    return {
      t: 'start',
      you,
      seed,
      names: [...(names as string[])],
      bots: [...(bots as boolean[])],
      startTick,
    }
  }
  if (o['t'] === 'snap' && isWireState(o['state'])) {
    return { t: 'snap', state: freshWireState(o['state']) }
  }
  if (o['t'] === 'end' && isResult(o['result'])) {
    return { t: 'end', result: freshResult(o['result']) }
  }
  return null
}
