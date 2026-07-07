import type { Color, Result } from './board.js'

export type ChessClientMsg =
  | { t: 'join'; handle: string }
  | { t: 'move'; move: string; seq: number } // coordinate notation on the wire
  | { t: 'resign' }

export type ChessServerMsg =
  | { t: 'welcome'; color: Color; opponent: string; state: string /* FEN */; clocksMs: { w: number; b: number } }
  | { t: 'move'; move: string; clocksMs: { w: number; b: number }; seq: number }
  | { t: 'end'; result: Result; state: string /* FEN */ }

const MAX_RAW = 4096

// Coordinate notation as produced/consumed on the wire: 'e2e4', 'e7e8q'.
const COORD_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/i

// Copied verbatim from fragwait's packages/core/src/protocol.ts sanitizeHandle:
// lowercase, strip everything outside [a-z0-9-] (this also strips the '·'
// glyph reserved for bot names), cap at 24 chars, fall back to 'anon' if empty.
export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

function isSeq(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isMoveString(v: unknown): v is string {
  return typeof v === 'string' && COORD_MOVE_RE.test(v)
}

function isClocksMs(v: unknown): v is { w: number; b: number } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['w'] === 'number' && Number.isFinite(o['w']) && typeof o['b'] === 'number' && Number.isFinite(o['b'])
  )
}

function isColor(v: unknown): v is Color {
  return v === 'w' || v === 'b'
}

const NO_WINNER_KINDS = new Set(['stalemate', 'fifty-move', 'threefold', 'insufficient'])
const WINNER_KINDS = new Set(['checkmate', 'resign', 'flag'])

// Validates a Result (from board.ts) field-by-field: kind must be one of the
// known literals, and winner is present (and 'w'|'b') only for the
// winner-bearing kinds; the draw kinds must NOT carry a winner field at all.
function isResult(v: unknown): v is Result {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const kind = o['kind']
  if (typeof kind !== 'string') return false
  if (WINNER_KINDS.has(kind)) {
    return isColor(o['winner'])
  }
  if (NO_WINNER_KINDS.has(kind)) {
    return o['winner'] === undefined
  }
  return false
}

export function parseChessClientMsg(raw: string): ChessClientMsg | null {
  if (raw.length > MAX_RAW) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>

  if (o['t'] === 'join' && typeof o['handle'] === 'string') {
    return { t: 'join', handle: sanitizeHandle(o['handle']) }
  }
  if (o['t'] === 'resign') return { t: 'resign' }
  if (o['t'] === 'move' && isMoveString(o['move']) && isSeq(o['seq'])) {
    return { t: 'move', move: o['move'], seq: o['seq'] }
  }
  return null
}

export function parseChessServerMsg(raw: string): ChessServerMsg | null {
  if (raw.length > MAX_RAW) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>

  if (
    o['t'] === 'welcome' &&
    isColor(o['color']) &&
    typeof o['opponent'] === 'string' &&
    typeof o['state'] === 'string' &&
    isClocksMs(o['clocksMs'])
  ) {
    return { t: 'welcome', color: o['color'], opponent: o['opponent'], state: o['state'], clocksMs: o['clocksMs'] }
  }
  if (o['t'] === 'move' && isMoveString(o['move']) && isClocksMs(o['clocksMs']) && isSeq(o['seq'])) {
    return { t: 'move', move: o['move'], clocksMs: o['clocksMs'], seq: o['seq'] }
  }
  if (o['t'] === 'end' && isResult(o['result']) && typeof o['state'] === 'string') {
    return { t: 'end', result: o['result'], state: o['state'] }
  }
  return null
}
