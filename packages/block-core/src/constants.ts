export const BOARD_W = 10, BOARD_H = 20, HIDDEN_ROWS = 4, TOTAL_ROWS = 24 // rows 0-3 hidden (top), 4-23 visible
export const TICK_RATE = 20
export const PREVIEW = 3
export const LOCK_DELAY_TICKS = 10
export const LOCK_RESETS_MAX = 15
export const ATTACK: readonly number[] = [0, 0, 1, 2, 4] // index = lines cleared
export const GRAVITY_SCHEDULE: readonly [number, number][] = // [fromTick, ticksPerCell]
  [[0, 20], [400, 15], [800, 10], [1200, 6], [1600, 4], [2000, 3], [2400, 2]]
export const SUDDEN_DEATH_TICK = 2400
export const SUDDEN_DEATH_INTERVAL = 100
export const MAX_EVENTS_PER_TICK = 8
export const GARBAGE = 8 // board cell value for garbage
