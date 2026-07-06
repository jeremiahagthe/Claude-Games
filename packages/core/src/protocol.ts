import { AIM_OFFSET_MAX } from './constants.js'
import type { MatchState, PlayerInput } from './types.js'

export type ClientMsg =
  | { t: 'join'; handle: string }
  | { t: 'input'; inputs: PlayerInput[] }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'welcome'; id: string; state: MatchState }
  | { t: 'snap'; state: MatchState }
  | { t: 'end'; state: MatchState }

const MAX_RAW = 4096
const MAX_INPUTS = 10

export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

// Analog axis, range [-1, 1] (PlayerInput.forward/strafe/turn are continuous
// floats, not the tri-state -1/0/1 of earlier milestones).
function isAxis(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1
}

function isInput(v: unknown): v is PlayerInput {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!(typeof o['seq'] === 'number' && Number.isInteger(o['seq']) && o['seq'] >= 0)) return false
  if (!isAxis(o['forward']) || !isAxis(o['strafe']) || !isAxis(o['turn'])) return false
  if (typeof o['fire'] !== 'boolean') return false
  // aimOffset is optional on the wire (bots and older clients omit it); when
  // present it must be a finite number within ±AIM_OFFSET_MAX, else the whole
  // message is rejected.
  if (o['aimOffset'] !== undefined) {
    const a = o['aimOffset']
    if (typeof a !== 'number' || !Number.isFinite(a) || Math.abs(a) > AIM_OFFSET_MAX) return false
  }
  return true
}

function toInput(o: Record<string, unknown>): PlayerInput {
  return {
    seq: o['seq'] as number,
    forward: o['forward'] as number,
    strafe: o['strafe'] as number,
    turn: o['turn'] as number,
    fire: o['fire'] as boolean,
    aimOffset: typeof o['aimOffset'] === 'number' ? o['aimOffset'] : 0,
  }
}

export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > MAX_RAW) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['t'] === 'join' && typeof o['handle'] === 'string') return { t: 'join', handle: sanitizeHandle(o['handle']) }
  if (o['t'] === 'leave') return { t: 'leave' }
  if (o['t'] === 'input' && Array.isArray(o['inputs']) && o['inputs'].length <= MAX_INPUTS && o['inputs'].every(isInput)) {
    return { t: 'input', inputs: (o['inputs'] as unknown[]).map((i) => toInput(i as Record<string, unknown>)) }
  }
  return null
}

export function parseServerMsg(raw: string): ServerMsg | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['t'] === 'welcome' && typeof o['id'] === 'string' && typeof o['state'] === 'object' && o['state'] !== null) return o as unknown as ServerMsg
  if ((o['t'] === 'snap' || o['t'] === 'end') && typeof o['state'] === 'object' && o['state'] !== null) return o as unknown as ServerMsg
  return null
}

// Snaps analog axes + aimOffset to the nearest 1/64 step before they go on the
// wire, so JSON payloads stay compact (no 17-digit float tails from client-side
// trig/normalization). seq/fire are exact already and pass through untouched.
export function quantizeInput(input: PlayerInput): PlayerInput {
  const q = (v: number) => Math.round(v * 64) / 64
  return {
    ...input,
    forward: q(input.forward),
    strafe: q(input.strafe),
    turn: q(input.turn),
    aimOffset: q(input.aimOffset),
  }
}
