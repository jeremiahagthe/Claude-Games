export const TICK_RATE = 20
export const TICK_MS = 1000 / TICK_RATE
export const MATCH_TICKS = 3 * 60 * TICK_RATE

export const MOVE_SPEED = 3.2 / TICK_RATE // map cells per tick
export const TURN_SPEED = 2.6 / TICK_RATE // radians per tick
export const PLAYER_RADIUS = 0.3
export const HIT_RADIUS = 0.45 // generous, replaces lag compensation (spec §4.3)

export const MAX_HP = 100
export const BLASTER_DMG = 25
export const BLASTER_COOLDOWN_TICKS = 10
export const RAIL_DMG = 100
export const RAIL_RESPAWN_TICKS = 30 * TICK_RATE
export const RAIL_PICKUP_RADIUS = 0.6
export const SPAWN_PROTECTION_TICKS = 2 * TICK_RATE

export const MIN_COMBATANTS = 4
export const MAX_PLAYERS = 8

export const INPUT_BATCH_MS = 100 // client → server packet cadence (free-tier friendly)
export const INTERP_DELAY_MS = 120 // remote-player render delay
export const MAX_WALL_DIST = 64
