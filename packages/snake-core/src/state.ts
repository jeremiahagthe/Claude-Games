import { GRID_H, GRID_W, SPEED_SCHEDULE } from './constants.js'

export type Dir = 'up' | 'down' | 'left' | 'right'

export interface Cellxy {
  x: number
  y: number
}

export interface SnakeState {
  id: number
  name: string
  bot: boolean
  alive: boolean
  dir: Dir
  pendingDir: Dir | null
  cells: Cellxy[]
  growth: number
}

export interface Food {
  x: number
  y: number
}

export interface Input {
  dir: Dir | null
}

export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }

// Direction tables shared across the core (step / bot / protocol). OPPOSITE maps a
// heading to its 180-reverse; DELTA maps a heading to its per-tick grid step.
export const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }
export const DELTA: Record<Dir, Cellxy> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export interface MatchState {
  tick: number
  stepCooldown: number
  rng: number
  rings: number
  snakes: SnakeState[]
  food: Food[]
  result: Result | null
}

export function idx(x: number, y: number): number {
  return y * GRID_W + x
}

export function isWall(x: number, y: number, rings: number): boolean {
  // OOB check
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) {
    return true
  }

  // Check if inside closed rings
  if (rings > 0) {
    // The rings shrink from the edges inward
    // Each ring is a rectangle that gets smaller
    // A cell is inside a closed ring if it's within `rings` distance from any edge
    const distFromLeft = x
    const distFromRight = GRID_W - 1 - x
    const distFromTop = y
    const distFromBottom = GRID_H - 1 - y

    const minDist = Math.min(distFromLeft, distFromRight, distFromTop, distFromBottom)
    if (minDist < rings) {
      return true
    }
  }

  return false
}

export function stepTicksAt(tick: number): number {
  // Find the appropriate step ticks for the current tick
  // Go through SPEED_SCHEDULE in reverse to find the largest fromTick that's <= tick
  for (let i = SPEED_SCHEDULE.length - 1; i >= 0; i--) {
    if (SPEED_SCHEDULE[i]![0] <= tick) {
      return SPEED_SCHEDULE[i]![1]
    }
  }
  // Should never reach here if SPEED_SCHEDULE[0][0] === 0
  return SPEED_SCHEDULE[0]![1]
}
