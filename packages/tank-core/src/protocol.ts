import type { Result } from './state.js'

export const MAX_RAW = 4096 // inbound size cap, applied both directions

export interface JoinMsg { t: 'join'; name: string } // client→server
export interface ShotMsg { t: 'shot'; seq: number; angle: number; power: number } // client→server
export type TankClientMsg = JoinMsg | ShotMsg

export interface StartMsg {
  t: 'start'
  you: 0 | 1
  seed: number
  names: [string, string]
  bots: [boolean, boolean]
  firstTurn: 0 | 1
} // server→client
export interface ShotBcast { t: 'shot'; by: 0 | 1; seq: number; angle: number; power: number; stateHash: string } // server→client
export interface TurnMsg { t: 'turn'; who: 0 | 1; deadlineMs: number } // server→client; duration from send, display-only countdown
export interface EndMsg { t: 'end'; result: [0, number] | [1] } // server→client; [0,winner] | [1]=draw
export type TankServerMsg = StartMsg | ShotBcast | TurnMsg | EndMsg

// Copied verbatim from packages/block-core/src/protocol.ts sanitizeHandle
// (itself copied down the family chain: fragwait → bomber-core → snake-core → block-core):
// lowercase, strip everything outside [a-z0-9-], cap at 24 chars, fall back to 'anon' if empty.
export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

const MAX_NAME_LEN = 24
const MAX_STATE_HASH_LEN = 16
const MAX_DEADLINE_MS = 120_000

// --- validation helpers ---------------------------------------------------

function isBool01(v: unknown): v is 0 | 1 {
  return v === 0 || v === 1
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
}

function isAngle(v: unknown): v is number {
  return isFiniteInt(v) && v >= 0 && v <= 180
}

function isPower(v: unknown): v is number {
  return isFiniteInt(v) && v >= 0 && v <= 100
}

function isSeq(v: unknown): v is number {
  return isFiniteInt(v) && v >= 0
}

function isSeed(v: unknown): v is number {
  return isFiniteInt(v)
}

function isDeadlineMs(v: unknown): v is number {
  return isFiniteInt(v) && v > 0 && v <= MAX_DEADLINE_MS
}

function isName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_NAME_LEN
}

function isStateHash(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_STATE_HASH_LEN && /^[0-9a-f]+$/.test(v)
}

function isNamesTuple(v: unknown): v is [string, string] {
  return Array.isArray(v) && v.length === 2 && v.every(isName)
}

function isBotsTuple(v: unknown): v is [boolean, boolean] {
  return Array.isArray(v) && v.length === 2 && v.every((b) => typeof b === 'boolean')
}

function isWireResult(v: unknown): v is [0, number] | [1] {
  if (!Array.isArray(v)) return false
  if (v.length === 1) return v[0] === 1
  if (v.length === 2) return v[0] === 0 && isBool01(v[1])
  return false
}

// Rebuilds a fresh result literal from an already-validated array — never
// hands back a reference into attacker-controlled JSON.
function freshWireResult(r: [0, number] | [1]): [0, number] | [1] {
  return r.length === 1 ? [1] : [0, r[1]]
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  return v as Record<string, unknown>
}

// --- parse -----------------------------------------------------------------

export function parseTankClientMsg(raw: unknown): TankClientMsg | null {
  const o = parseJsonObject(raw)
  if (o === null) return null

  if (o['t'] === 'join' && typeof o['name'] === 'string') {
    return { t: 'join', name: sanitizeHandle(o['name']) }
  }
  if (o['t'] === 'shot') {
    const seq = o['seq']
    const angle = o['angle']
    const power = o['power']
    if (!isSeq(seq) || !isAngle(angle) || !isPower(power)) return null
    return { t: 'shot', seq, angle, power }
  }
  return null
}

export function parseTankServerMsg(raw: unknown): TankServerMsg | null {
  const o = parseJsonObject(raw)
  if (o === null) return null

  if (o['t'] === 'start') {
    const you = o['you']
    const seed = o['seed']
    const names = o['names']
    const bots = o['bots']
    const firstTurn = o['firstTurn']
    if (!isBool01(you) || !isSeed(seed) || !isNamesTuple(names) || !isBotsTuple(bots) || !isBool01(firstTurn)) return null
    return { t: 'start', you, seed, names: [names[0], names[1]], bots: [bots[0], bots[1]], firstTurn }
  }
  if (o['t'] === 'shot') {
    const by = o['by']
    const seq = o['seq']
    const angle = o['angle']
    const power = o['power']
    const stateHash = o['stateHash']
    if (!isBool01(by) || !isSeq(seq) || !isAngle(angle) || !isPower(power) || !isStateHash(stateHash)) return null
    return { t: 'shot', by, seq, angle, power, stateHash }
  }
  if (o['t'] === 'turn') {
    const who = o['who']
    const deadlineMs = o['deadlineMs']
    if (!isBool01(who) || !isDeadlineMs(deadlineMs)) return null
    return { t: 'turn', who, deadlineMs }
  }
  if (o['t'] === 'end') {
    const result = o['result']
    if (!isWireResult(result)) return null
    return { t: 'end', result: freshWireResult(result) }
  }
  return null
}

export function resultToWire(r: Result): [0, number] | [1] {
  return r.kind === 'win' ? [0, r.winner] : [1]
}

export function resultFromWire(w: [0, number] | [1]): Result {
  return w.length === 1 ? { kind: 'draw' } : { kind: 'win', winner: w[1] }
}
