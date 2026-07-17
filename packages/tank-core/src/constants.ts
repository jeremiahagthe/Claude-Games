export const FIELD_W = 80, FIELD_H = 42            // world units; y up, floor 0
export const HP_MAX = 100
export const ANGLE_MIN = 0, ANGLE_MAX = 180        // integer degrees; 0=right, 90=up, 180=left
export const POWER_MIN = 0, POWER_MAX = 100        // integer
export const DT = 1 / 30                           // s per integration step
export const GRAVITY = 40                          // units/s^2
export const POWER_SCALE = 1.1                     // v0 = power * POWER_SCALE units/s
export const WIND_MAX = 10                         // wind ∈ [-WIND_MAX..WIND_MAX] integers; + pushes right
export const WIND_ACCEL = 1.2                      // horizontal accel = wind * WIND_ACCEL units/s^2
export const MAX_FLIGHT_STEPS = 600
export const BLAST_RADIUS = 6                      // world units
export const BLAST_DAMAGE_MAX = 60
export const TANK_HIT_RADIUS = 1.5                 // direct-contact radius (plan addition; spec's "tank contact")
export const FALL_FREE_UNITS = 4
export const FALL_DAMAGE_PER_UNIT = 3
export const TERRAIN_MIN = 4, TERRAIN_MAX = 30
export const SPAWN_FLAT_HALF = 2                   // flatten tankCol ± 2 (5 cols)
export const SPAWN_L: readonly [number, number] = [8, 16]   // inclusive col ranges
export const SPAWN_R: readonly [number, number] = [63, 71]
export const SHOT_CLOCK_MS = 20_000
export const SUDDEN_DEATH_ROUND = 12               // decay applies as each round ≥ this completes
export const SUDDEN_DEATH_DECAY = 10
export const DEFAULT_POWER = 50
export const DEFAULT_ANGLE = 60                    // left tank; right tank uses 180 - DEFAULT_ANGLE
