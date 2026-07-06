export const TICK_RATE = 20
export const TICK_MS = 1000 / TICK_RATE
export const MATCH_TICKS = 3 * 60 * TICK_RATE

export const MOVE_SPEED = 3.2 / TICK_RATE // map cells per tick
// Radians per tick at full turn axis. 5.2 rad/s is the MOUSE-LOOK ceiling
// (feel-11): the client's relative-delta budget may drain at up to the full
// axis, so a fast swipe tracks the hand instead of banking a slow replay tail.
export const TURN_SPEED = 5.2 / TICK_RATE
// Keyboard holds and bots emit this fraction of the full axis — exactly the
// pre-feel-11 rate (0.5 × 5.2 = 2.6 rad/s), so doubling TURN_SPEED changed
// nothing for them. The upper half of the axis range is mouse-only headroom.
export const KEY_TURN_AXIS = 0.5
// Cursor-aim: max fire-direction offset from facing, in radians. The client's
// RENDER_HALF_FOV (half the render FOV) must stay ≤ this so the aim can always
// reach the on-screen crosshair.
export const AIM_OFFSET_MAX = 0.6
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

// Bot difficulty tuning
export const AIM_WANDER_TICKS = 6 // ticks between aim-wobble resamples (~300ms @ 20Hz)
export const AIM_WOBBLE = 0.22 // radians; wander noise amplitude at skill 0
export const REACTION_TICKS_SCALE = 12 // reactionTicks = round((1 - skill) * this)
export const RESIGHT_GAP_TICKS = 20 // ticks without visibility before a re-sighting resets reaction delay

export type Difficulty = 'easy' | 'normal' | 'hard'
// Per-bot skill (0..1) by difficulty; index = bot slot (varied so there's always a weakest bot).
export const DIFFICULTY_SKILLS: Record<Difficulty, readonly [number, number, number]> = {
  easy: [0.15, 0.2, 0.25],
  normal: [0.3, 0.35, 0.4],
  hard: [0.5, 0.55, 0.6],
}
