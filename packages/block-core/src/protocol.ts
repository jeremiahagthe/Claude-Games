import { BOARD_W, MAX_EVENTS_PER_TICK, TOTAL_ROWS } from './constants.js'
import { cellsAt, KINDS, type Rot } from './pieces.js'
import { bIdx, EVENT_CODES, type ActivePiece, type GarbageEntry, type MatchState, type PlayerState, type Result } from './state.js'

export const MAX_RAW = 4096 // inbound size cap, applied both directions
export const LEAD_TICKS = 5 // client may run at most this far ahead of server wall clock
export const LAG_TICKS = 25 // further behind → server force-advances with empty inputs
export const BATCH_TICKS = 5 // client batch cadence

export interface HelloMsg {
  t: 'hello'
  name: string
} // client→server

export interface InputMsg {
  t: 'input'
  seq: number
  upTo: number
  events: [number, number][] // [tick, eventCode]
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
} // server→client

export interface GarbageMsg {
  t: 'garbage'
  rows: number
  holeCol: number
  atTick: number // on the VICTIM's own clock
} // server→client

export interface EndMsg {
  t: 'end'
  result: [0, number] | [1] // [0,winner] | [1]=draw
} // server→client

export type BlockClientMsg = HelloMsg | InputMsg
export type BlockServerMsg = StartMsg | SnapMsg | GarbageMsg | EndMsg

// WirePlayer round-trips the FULL PlayerState (resync needs it):
// [id, name, bot, alive, tick, boardRows(24 hex strings, 10 nibbles: 0 empty/1-7 kind/8 garbage, index 0 = top),
//  piece [kindCode(1-7), rot, x, y] | 0, queueCodes: number[], bagRng, holdCode(0=none), holdUsed(0|1),
//  fallCooldown, lockTicks(-1=null), lockResets, pending: [rows, holeCol][], linesCleared, linesSent]
export type WirePlayer = [
  number,
  string,
  number,
  number,
  number,
  string[],
  [number, number, number, number] | 0,
  number[],
  number,
  number,
  number,
  number,
  number,
  number,
  [number, number][],
  number,
  number,
]

export interface WireState {
  players: [WirePlayer, WirePlayer]
  garbageRng: number
  result: [0, number] | [1] | null
}

// Copied verbatim from packages/snake-core/src/protocol.ts sanitizeHandle
// (itself copied from bomber-core's, itself from fragwait's):
// lowercase, strip everything outside [a-z0-9-] (this also strips the '·'
// glyph reserved for bot names), cap at 24 chars, fall back to 'anon' if empty.
export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

const MAX_NAME_LEN = 24
const MAX_QUEUE_LEN = 16
const MAX_PENDING = 40
const MAX_PENDING_ROWS = 20
const MAX_EVENTS_PER_BATCH = BATCH_TICKS * MAX_EVENTS_PER_TICK
const MAX_LOCK_DELAY = 10 // LOCK_DELAY_TICKS
const MAX_LOCK_RESETS = 15 // LOCK_RESETS_MAX
const MAX_FALL_COOLDOWN = 32 // generous over the widest GRAVITY_SCHEDULE entry (20)
const MAX_LINES = 65535 // generous cap; no legitimate match approaches this
const MAX_RNG = 0xffffffff

// --- board / piece codecs ---------------------------------------------------

function boardToRows(board: number[]): string[] {
  const rows: string[] = []
  for (let y = 0; y < TOTAL_ROWS; y++) {
    let row = ''
    for (let x = 0; x < BOARD_W; x++) row += board[bIdx(x, y)]!.toString(16)
    rows.push(row)
  }
  return rows
}

function rowsToBoard(rows: string[]): number[] {
  const board = new Array<number>(TOTAL_ROWS * BOARD_W).fill(0)
  for (let y = 0; y < TOTAL_ROWS; y++) {
    const row = rows[y]!
    for (let x = 0; x < BOARD_W; x++) board[bIdx(x, y)] = Number.parseInt(row[x]!, 16)
  }
  return board
}

function pieceToWire(p: ActivePiece | null): [number, number, number, number] | 0 {
  if (p === null) return 0
  return [KINDS.indexOf(p.kind) + 1, p.rot, p.x, p.y]
}

function pieceFromWire(w: [number, number, number, number] | 0): ActivePiece | null {
  if (w === 0) return null
  const [kindCode, rot, x, y] = w
  return { kind: KINDS[kindCode - 1]!, rot: rot as Rot, x, y }
}

// --- toWire / fromWire ---------------------------------------------------

export function toWirePlayer(p: PlayerState): WirePlayer {
  return [
    p.id,
    p.name,
    p.bot ? 1 : 0,
    p.alive ? 1 : 0,
    p.tick,
    boardToRows(p.board),
    pieceToWire(p.piece),
    p.queue.map((k) => KINDS.indexOf(k) + 1),
    p.bagRng,
    p.hold === null ? 0 : KINDS.indexOf(p.hold) + 1,
    p.holdUsed ? 1 : 0,
    p.fallCooldown,
    p.lockTicks === null ? -1 : p.lockTicks,
    p.lockResets,
    p.pendingGarbage.map((g): [number, number] => [g.rows, g.holeCol]),
    p.linesCleared,
    p.linesSent,
  ]
}

export function fromWirePlayer(w: WirePlayer): PlayerState {
  const [id, name, bot, alive, tick, boardRows, piece, queueCodes, bagRng, holdCode, holdUsed, fallCooldown, lockTicks, lockResets, pending, linesCleared, linesSent] = w
  return {
    id,
    name,
    bot: bot === 1,
    alive: alive === 1,
    tick,
    board: rowsToBoard(boardRows),
    piece: pieceFromWire(piece),
    queue: queueCodes.map((c) => KINDS[c - 1]!),
    bagRng,
    hold: holdCode === 0 ? null : KINDS[holdCode - 1]!,
    holdUsed: holdUsed === 1,
    fallCooldown,
    lockTicks: lockTicks === -1 ? null : lockTicks,
    lockResets,
    pendingGarbage: pending.map(([rows, holeCol]): GarbageEntry => ({ rows, holeCol })),
    linesCleared,
    linesSent,
  }
}

export function toWire(m: MatchState): WireState {
  const result: WireState['result'] = m.result === null ? null : m.result.kind === 'win' ? [0, m.result.winner] : [1]
  return {
    players: [toWirePlayer(m.players[0]), toWirePlayer(m.players[1])],
    garbageRng: m.garbageRng,
    result,
  }
}

export function fromWire(w: WireState): MatchState {
  const result: Result | null = w.result === null ? null : w.result[0] === 0 ? { kind: 'win', winner: w.result[1] } : { kind: 'draw' }
  return {
    players: [fromWirePlayer(w.players[0]), fromWirePlayer(w.players[1])],
    garbageRng: w.garbageRng,
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
  return v === 0 || v === 1
}

function isRng(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_RNG
}

function isBool01(v: unknown): boolean {
  return v === 0 || v === 1
}

function isBoardRow(v: unknown): v is string {
  return typeof v === 'string' && /^[0-8]{10}$/.test(v)
}

function isBoardRows(v: unknown): v is string[] {
  return Array.isArray(v) && v.length === TOTAL_ROWS && v.every(isBoardRow)
}

function isKindCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= KINDS.length
}

function isHoldCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= KINDS.length
}

function isRot(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3
}

// Coarse sanity bound on raw piece box-origin ints so cellsAt is never fed
// garbage. Box origins are NOT cell columns: SRS lets legal origins go
// negative (I rot1 at x=-2 is a vertical I in column 0; JLSTZ rot1 at x=-1
// hugs the left wall; upward kicks can drive y to 0).
const MAX_PIECE_COORD = 32

function isPieceCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_PIECE_COORD
}

function isWirePiece(v: unknown): v is [number, number, number, number] | 0 {
  if (v === 0) return true
  if (!Array.isArray(v) || v.length !== 4) return false
  const [kindCode, rot, x, y] = v
  if (!isKindCode(kindCode) || !isRot(rot) || !isPieceCoord(x) || !isPieceCoord(y)) return false
  // Validate the DECODED piece: every occupied cell must land in-board.
  const kind = KINDS[(kindCode as number) - 1]!
  return cellsAt(kind, rot as Rot, x as number, y as number).every(
    ([cx, cy]) => cx >= 0 && cx < BOARD_W && cy >= 0 && cy < TOTAL_ROWS,
  )
}

function isQueue(v: unknown): v is number[] {
  return Array.isArray(v) && v.length <= MAX_QUEUE_LEN && v.every(isKindCode)
}

function isLockTicks(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= MAX_LOCK_DELAY
}

function isLockResets(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LOCK_RESETS
}

function isFallCooldown(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_FALL_COOLDOWN
}

function isLines(v: unknown): v is number {
  return isNonNegInt(v) && v <= MAX_LINES
}

function isPendingEntry(v: unknown): v is [number, number] {
  if (!Array.isArray(v) || v.length !== 2) return false
  const [rows, holeCol] = v
  return (
    typeof rows === 'number' && Number.isInteger(rows) && rows >= 1 && rows <= MAX_PENDING_ROWS &&
    typeof holeCol === 'number' && Number.isInteger(holeCol) && holeCol >= 0 && holeCol < BOARD_W
  )
}

function isPending(v: unknown): v is [number, number][] {
  return Array.isArray(v) && v.length <= MAX_PENDING && v.every(isPendingEntry)
}

function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_NAME_LEN
}

function isWirePlayer(v: unknown): v is WirePlayer {
  if (!Array.isArray(v) || v.length !== 17) return false
  const [id, name, bot, alive, tick, boardRows, piece, queueCodes, bagRng, holdCode, holdUsed, fallCooldown, lockTicks, lockResets, pending, linesCleared, linesSent] = v
  return (
    isPlayerId(id) &&
    isName(name) &&
    isBool01(bot) &&
    isBool01(alive) &&
    isNonNegInt(tick) &&
    isBoardRows(boardRows) &&
    isWirePiece(piece) &&
    isQueue(queueCodes) &&
    isRng(bagRng) &&
    isHoldCode(holdCode) &&
    isBool01(holdUsed) &&
    isFallCooldown(fallCooldown) &&
    isLockTicks(lockTicks) &&
    isLockResets(lockResets) &&
    isPending(pending) &&
    isLines(linesCleared) &&
    isLines(linesSent)
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
  if (!Array.isArray(o['players']) || o['players'].length !== 2 || !o['players'].every(isWirePlayer)) return false
  if (!isRng(o['garbageRng'])) return false
  if (!isWireResult(o['result'])) return false
  return true
}

// Rebuilds a fresh WirePlayer literal from an already-validated array — never
// hands back a reference into attacker-controlled JSON.
function freshWirePlayer(w: WirePlayer): WirePlayer {
  return [
    w[0],
    w[1],
    w[2],
    w[3],
    w[4],
    [...w[5]],
    w[6] === 0 ? 0 : [...w[6]],
    [...w[7]],
    w[8],
    w[9],
    w[10],
    w[11],
    w[12],
    w[13],
    w[14].map(([rows, holeCol]): [number, number] => [rows, holeCol]),
    w[15],
    w[16],
  ]
}

// Rebuilds a fresh WireState literal — never hands back a reference into
// attacker-controlled JSON (no field smuggling of extra properties).
function freshWireState(o: WireState): WireState {
  return {
    players: [freshWirePlayer(o.players[0]), freshWirePlayer(o.players[1])],
    garbageRng: o.garbageRng,
    result: o.result === null ? null : o.result.length === 1 ? [1] : [0, o.result[1]],
  }
}

function freshEndResult(r: [0, number] | [1]): [0, number] | [1] {
  return r.length === 1 ? [1] : [0, r[1]]
}

function isEventCode(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < EVENT_CODES.length
}

function isEventEntry(v: unknown, upTo: number): v is [number, number] {
  if (!Array.isArray(v) || v.length !== 2) return false
  const [t, code] = v
  return isNonNegInt(t) && t <= upTo && isEventCode(code)
}

// --- parse -----------------------------------------------------------------

export function parseBlockClientMsg(raw: unknown): BlockClientMsg | null {
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
  if (o['t'] === 'input') {
    const seq = o['seq']
    const upTo = o['upTo']
    const events = o['events']
    if (!isFiniteNum(seq) || !Number.isInteger(seq) || seq < 0) return null
    if (!isFiniteNum(upTo) || !Number.isInteger(upTo) || upTo < 0) return null
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_BATCH) return null
    if (!events.every((e) => isEventEntry(e, upTo))) return null
    return { t: 'input', seq, upTo, events: (events as [number, number][]).map(([t, c]): [number, number] => [t, c]) }
  }
  return null
}

export function parseBlockServerMsg(raw: unknown): BlockServerMsg | null {
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
    if (!isNonNegInt(seed)) return null
    if (!Array.isArray(names) || names.length !== 2 || !names.every(isName)) return null
    if (!Array.isArray(bots) || bots.length !== 2 || !bots.every((b) => typeof b === 'boolean')) return null
    return { t: 'start', you, seed, names: [...(names as string[])], bots: [...(bots as boolean[])] }
  }
  if (o['t'] === 'snap' && isWireState(o['state'])) {
    return { t: 'snap', state: freshWireState(o['state']) }
  }
  if (o['t'] === 'garbage') {
    const rows = o['rows']
    const holeCol = o['holeCol']
    const atTick = o['atTick']
    if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > MAX_PENDING_ROWS) return null
    if (typeof holeCol !== 'number' || !Number.isInteger(holeCol) || holeCol < 0 || holeCol >= BOARD_W) return null
    if (!isNonNegInt(atTick)) return null
    return { t: 'garbage', rows, holeCol, atTick }
  }
  if (o['t'] === 'end' && isWireResult(o['result']) && o['result'] !== null) {
    return { t: 'end', result: freshEndResult(o['result'] as [0, number] | [1]) }
  }
  return null
}
