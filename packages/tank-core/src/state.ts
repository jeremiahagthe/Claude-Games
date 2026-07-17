import { WIND_MAX } from './constants.js'
import { randStep } from './prng.js'

export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }

export interface Shot { angle: number; power: number }

export interface Tank {
  id: number; name: string; bot: boolean; alive: boolean
  col: number                  // integer spawn column; never changes (fixed emplacements)
  hp: number
  lastAngle: number; lastPower: number   // pre-loaded defaults; server expiry auto-fires these
  shotsFired: number; damageDealt: number
}

export interface MatchState {
  heights: number[]            // 80 floats, world y of the surface per column
  tanks: [Tank, Tank]          // index 0 = left tank, 1 = right tank
  turn: 0 | 1; firstTurn: 0 | 1
  round: number                // 1-based; increments when the second mover of the round fires
  wind: number                 // integer [-WIND_MAX..WIND_MAX], rolled for the CURRENT turn
  rng: number                  // randStep state
  result: Result | null        // stamped once, never overwritten
}

// rollWind: floor(value*(2*WIND_MAX+1)) - WIND_MAX
export function rollWind(rng: number): { wind: number; rng: number } {
  const { value, next } = randStep(rng)
  const wind = Math.floor(value * (2 * WIND_MAX + 1)) - WIND_MAX
  return { wind, rng: next }
}

// fnv1a hex of JSON.stringify(m) — same imul formula as the family's golden tests.
export function stateHash(m: MatchState): string {
  const s = JSON.stringify(m)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

// tankY: heights[tank.col] (the tank sits ON the surface)
export function tankY(m: MatchState, id: number): number {
  const tank = m.tanks[id]!
  return m.heights[tank.col]!
}

// muzzle: [tank.col, tankY + 1]
export function muzzle(m: MatchState, id: number): [number, number] {
  const tank = m.tanks[id]!
  return [tank.col, tankY(m, id) + 1]
}
