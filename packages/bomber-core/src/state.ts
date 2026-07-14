import { BASE_STEP_TICKS, GRID_W, MIN_STEP_TICKS } from './constants.js'

export type Cell = 'empty' | 'hard' | 'soft'
export type Dir = 'up' | 'down' | 'left' | 'right'
export type PowerupKind = 'bomb' | 'range' | 'speed'

export interface PlayerState {
  id: number
  name: string
  bot: boolean
  x: number
  y: number
  alive: boolean
  bombCap: number
  range: number
  speed: number // speed 0.. → stepTicks
  dir: Dir | null // single-step buffer: consumed after each tile (null = standing)
  stepCooldown: number // ticks until next step allowed
  activeBombs: number
}

export interface Bomb { owner: number; x: number; y: number; fuse: number; range: number }
export interface Flame { x: number; y: number; ticks: number }
export interface Drop { x: number; y: number; kind: PowerupKind }
export interface Input { dir: Dir | null; bomb: boolean }
export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }

export interface BomberState {
  tick: number
  grid: Cell[] // GRID_W*GRID_H, index = y*GRID_W+x
  hidden: (PowerupKind | null)[] // parallel to grid: power-up under a soft block
  drops: Drop[] // revealed, walk-over-to-collect
  players: PlayerState[] // length 4, index = player id
  bombs: Bomb[]
  flames: Flame[]
  shrinkIndex: number // SPIRAL index of the LAST tile closed (-1 = none yet); SPIRAL.length once exhausted
  result: Result | null
}

export function idx(x: number, y: number): number {
  return y * GRID_W + x
}

export function stepTicks(speed: number): number {
  return Math.max(MIN_STEP_TICKS, BASE_STEP_TICKS - speed)
}
