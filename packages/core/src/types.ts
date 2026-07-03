export interface Vec2 { x: number; y: number }

export type Weapon = 'blaster' | 'rail'

export interface PlayerInput {
  seq: number
  // Continuous axes, range [-1, 1]. Milestone C's wire format must quantize
  // these (e.g. to 1/64 steps) before transmission — not implemented yet.
  forward: number
  strafe: number
  turn: number
  fire: boolean
  // Cursor-aim fire direction offset from the player's facing `dir`, in radians;
  // positive is the same rotational direction as positive `turn`. Clamped to
  // ±AIM_OFFSET_MAX by makeInput. Only affects the fire ray for the tick it is
  // fired (facing, movement, and turn are untouched). Milestone C's wire format
  // must quantize this like the axes.
  aimOffset: number
}

export interface PlayerState {
  id: string
  handle: string
  bot: boolean
  pos: Vec2
  dir: number // radians
  hp: number
  frags: number
  deaths: number
  fireCooldown: number // ticks
  spawnProtection: number // ticks of invulnerability; firing cancels it
  hasRail: boolean
  lastInputSeq: number
}

export interface RailState { pos: Vec2; present: boolean; respawnTimer: number }

export interface KillEvent { tick: number; killerId: string; victimId: string; weapon: Weapon }

export interface MatchState {
  tick: number
  timeLeftTicks: number
  mapId: string
  players: Record<string, PlayerState>
  rail: RailState
  kills: KillEvent[] // events from the current tick only (transient)
}
