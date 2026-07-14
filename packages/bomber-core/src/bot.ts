import { FUSE_TICKS, GRID_H, GRID_W } from './constants.js'
import { mulberry32 } from './prng.js'
import type { Bomb, BomberState, Cell, Dir, Input, PlayerState } from './state.js'
import { idx, stepTicks } from './state.js'

export type Difficulty = 'easy' | 'normal' | 'hard'
// heading is the bot's OWN remembered movement direction. The sim now consumes
// player.dir after every tile (tap-to-step), so a bot can no longer read its
// heading back out of the state between decisions — it must re-issue heading
// every tick to keep gliding, exactly as a human holding a key does.
export interface BotMind { rng: () => number; nextDecisionTick: number; heading: Dir | null } // per-bot, caller-owned

export function createBotMind(seed: number): BotMind {
  return { rng: mulberry32(seed), nextDecisionTick: 0, heading: null }
}

const CADENCE: Record<Difficulty, number> = { easy: 10, normal: 5, hard: 3 }
const EASY_MISTAKE_RATE = 0.15

const DIRS: Dir[] = ['up', 'down', 'left', 'right']

function targetTile(x: number, y: number, dir: Dir): { x: number; y: number } {
  switch (dir) {
    case 'up':
      return { x, y: y - 1 }
    case 'down':
      return { x, y: y + 1 }
    case 'left':
      return { x: x - 1, y }
    case 'right':
      return { x: x + 1, y }
  }
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H
}

// Mirrors step.ts's private isBlocked (inverted): grid cell must be empty and no
// bomb may sit there. bot.ts is a pure consumer of the sim and does not import
// step.ts internals, so this small amount of duplication is intentional.
function isWalkable(state: BomberState, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false
  if (state.grid[idx(x, y)] !== 'empty') return false
  if (state.bombs.some((b) => b.x === x && b.y === y)) return false
  return true
}

const RAY_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

// Mirrors step.ts's resolveExplosions ray-walk (grid-only; bombs on the path
// don't block the ray, they chain) so danger predictions match the real sim.
function bombBlastTiles(grid: Cell[], bomb: Bomb): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [{ x: bomb.x, y: bomb.y }]
  for (const [dx, dy] of RAY_DIRS) {
    for (let s = 1; s <= bomb.range; s++) {
      const x = bomb.x + dx * s
      const y = bomb.y + dy * s
      if (!inBounds(x, y)) break
      const cellIdx = idx(x, y)
      const cell = grid[cellIdx]
      if (cell === 'hard') break
      tiles.push({ x, y })
      if (cell === 'soft') break
    }
  }
  return tiles
}

// Per tile: ticks until flame arrives (Infinity = safe). Active flames read 0.
// chainAware additionally propagates one level of chain reaction: if bomb A's
// blast would hit a tile bomb B sits on, B's own blast tiles become dangerous
// starting at min(A.fuse, B.fuse) too. extraBomb lets a hypothetical
// just-placed bomb be folded in for a post-placement retreat check.
function computeDangerMap(state: BomberState, chainAware: boolean, extraBomb?: Bomb): number[] {
  const map = new Array(GRID_W * GRID_H).fill(Infinity) as number[]
  for (const f of state.flames) map[idx(f.x, f.y)] = 0

  const bombs = extraBomb ? [...state.bombs, extraBomb] : state.bombs
  const blastCache = new Map<Bomb, { x: number; y: number }[]>()
  const blastOf = (b: Bomb): { x: number; y: number }[] => {
    let tiles = blastCache.get(b)
    if (!tiles) {
      tiles = bombBlastTiles(state.grid, b)
      blastCache.set(b, tiles)
    }
    return tiles
  }

  for (const b of bombs) {
    for (const t of blastOf(b)) {
      const i = idx(t.x, t.y)
      if (b.fuse < map[i]!) map[i] = b.fuse
    }
  }

  if (chainAware) {
    for (const a of bombs) {
      for (const t of blastOf(a)) {
        const hit = bombs.find((ob) => ob !== a && ob.x === t.x && ob.y === t.y)
        if (!hit) continue
        const chainArrival = Math.min(a.fuse, hit.fuse)
        for (const ct of blastOf(hit)) {
          const i = idx(ct.x, ct.y)
          if (chainArrival < map[i]!) map[i] = chainArrival
        }
      }
    }
  }

  return map
}

export function dangerMap(state: BomberState): number[] {
  return computeDangerMap(state, false)
}

// A latched-movement bot can only hold ONE direction between decisions, for
// up to `cadence` ticks before the next decision gets a chance to react — so
// the WHOLE window has to be validated, not just "does it eventually reach a
// safe tile": a bomb can detonate partway through the window (its dmap
// arrival tick was in the future when this decision started, but by hop 2 or
// 3 it's already gone off), and the resulting flame lingers for FLAME_TICKS
// after that — so a hop PAST an already-safe tile can walk straight into it.
// Reaching genuine (Infinity) safety doesn't end the check early; it's just
// remembered as the preferred outcome once the whole window has been swept.
//
// Crucially, each tile is checked over its full OCCUPANCY window, not just
// the arrival instant: the bot stands on every hopped tile for stepCost
// ticks before the next step fires, so a flame arriving anywhere in
// [arrival, arrival + stepCost) kills it there. The model's arrival estimate
// (hop * stepCost) is an upper bound on the real arrival — the first step
// can fire early off a fresh or mid-stride cooldown — and for the same
// reason arrival + stepCost bounds the real departure, so the check stays
// conservative for every actual timing. (No flame-expiry model: a flame
// born before arrival is conservatively assumed still burning.)
//
// The one case that needs special care is getting BLOCKED (wall/soft/another
// bomb) partway through — latched movement just keeps retrying and failing,
// so the bot is stuck at the last tile reached for the REST of the window,
// and that tile must not catch fire before `cadence` ticks have elapsed.
function holdSafe(
  state: BomberState,
  dmap: number[],
  player: PlayerState,
  dir: Dir,
  cadence: number,
  stepCost: number,
): { safe: boolean; reachedInfinity: boolean; infinityTicks: number; hopsTaken: number } {
  let x = player.x
  let y = player.y
  let ticks = 0
  let hopsTaken = 0
  let reachedInfinity = false
  let infinityTicks = 0
  while (ticks < cadence) {
    const t = targetTile(x, y, dir)
    if (!isWalkable(state, t.x, t.y)) {
      const i = idx(x, y)
      const d = dmap[i]!
      const stillSafe = d === Infinity || d > cadence
      return {
        safe: stillSafe,
        reachedInfinity: reachedInfinity || d === Infinity,
        infinityTicks: reachedInfinity ? infinityTicks : d === Infinity ? ticks : 0,
        hopsTaken,
      }
    }
    ticks += stepCost
    const i = idx(t.x, t.y)
    const d = dmap[i]!
    // Occupancy check: the bot stands here for [arrival, arrival + stepCost),
    // so any flame arriving before the NEXT step is lethal — not just one
    // arriving before/at the arrival instant.
    if (d !== Infinity && d < ticks + stepCost) {
      return { safe: false, reachedInfinity, infinityTicks, hopsTaken } // would burn while standing here
    }
    x = t.x
    y = t.y
    hopsTaken++
    if (d === Infinity && !reachedInfinity) {
      reachedInfinity = true
      infinityTicks = ticks
    }
  }
  return { safe: true, reachedInfinity, infinityTicks, hopsTaken }
}

// A straight run needs to clear a bomb's full blast radius, which has
// nothing to do with decision cadence. Purely geometric/timing-agnostic
// (grid-bounded, well under GRID_W*GRID_H tiles) — used only to break ties
// among directions that are safe for the CURRENT hold window but don't reach
// genuine safety within it: one of those might be a dead end (e.g. runs
// straight into the border while still inside the blast) while another
// keeps making real progress toward an actually-safe tile a few hops
// further out. Without this, findEscapeDir's window-bounded check can't
// distinguish them and may commit to the dead end.
const FULL_SCAN_HOPS = GRID_W + GRID_H
function eventuallyReachesInfinity(state: BomberState, dmap: number[], player: PlayerState, dir: Dir): boolean {
  let x = player.x
  let y = player.y
  for (let hop = 0; hop < FULL_SCAN_HOPS; hop++) {
    const t = targetTile(x, y, dir)
    if (!isWalkable(state, t.x, t.y)) return false
    if (dmap[idx(t.x, t.y)]! === Infinity) return true
    x = t.x
    y = t.y
  }
  return false
}

// Escape/retreat search (bounded: `cadence` ticks of travel in each of the 4
// directions, never wall-clock). A direction qualifies if holding it is
// hold-safe (see holdSafe) AND it actually moves the bot (hopsTaken > 0) —
// "safe because it can't go anywhere" isn't an escape. Preference order:
// reaching genuine (Infinity) safety within this window wins outright,
// nearest first; failing that, a direction merely safe for this window is
// accepted, preferring one that's geometrically still heading toward real
// safety (see eventuallyReachesInfinity) over one that's about to dead-end,
// trusting the next decision to continue the job from wherever this leaves
// the bot.
function findEscapeDir(state: BomberState, dmap: number[], player: PlayerState, cadence: number): Dir | null {
  const stepCost = stepTicks(player.speed)
  let bestInfinity: { dir: Dir; ticks: number } | null = null
  let bestSafeWithFuture: Dir | null = null
  let bestSafeAny: Dir | null = null

  for (const dir of DIRS) {
    const res = holdSafe(state, dmap, player, dir, cadence, stepCost)
    if (!res.safe || res.hopsTaken === 0) continue
    if (res.reachedInfinity) {
      if (!bestInfinity || res.infinityTicks < bestInfinity.ticks) bestInfinity = { dir, ticks: res.infinityTicks }
      continue
    }
    if (bestSafeAny === null) bestSafeAny = dir
    if (bestSafeWithFuture === null && eventuallyReachesInfinity(state, dmap, player, dir)) bestSafeWithFuture = dir
  }

  return bestInfinity ? bestInfinity.dir : (bestSafeWithFuture ?? bestSafeAny)
}

// Fallback movement for "nothing to flee, nothing to approach, but don't
// just freeze either" situations (adjacent to a bomb target with no safe
// retreat right now, or genuinely no escape at all). Tries the same
// hold-safe search as findEscapeDir first; only if literally no direction is
// safe for the window does it fall back to a bare 1-hop least-bad pick.
function wanderDir(state: BomberState, dmap: number[], player: PlayerState, cadence: number): Dir | null {
  const viaEscape = findEscapeDir(state, dmap, player, cadence)
  if (viaEscape) return viaEscape

  const stepCost = stepTicks(player.speed)
  const here = dmap[idx(player.x, player.y)]!
  const hereSafe = here === Infinity || here > cadence

  // Prefer a direction we can actually survive occupying. A bot standing on a
  // SAFE tile must never wander into an active or imminent flame just because
  // it is the "least dangerous" walkable neighbour — that is a voluntary
  // suicide (e.g. stepping into your own bomb's blast the tick it detonates).
  let bestDir: Dir | null = null
  let bestVal = -Infinity
  let bestUnsafeDir: Dir | null = null
  let bestUnsafeVal = -Infinity
  for (const dir of DIRS) {
    const t = targetTile(player.x, player.y, dir)
    if (!isWalkable(state, t.x, t.y)) continue
    const v = dmap[idx(t.x, t.y)]!
    const val = v === Infinity ? Number.MAX_SAFE_INTEGER : v
    if (holdSafe(state, dmap, player, dir, cadence, stepCost).safe) {
      if (val > bestVal) {
        bestVal = val
        bestDir = dir
      }
    } else if (val > bestUnsafeVal) {
      bestUnsafeVal = val
      bestUnsafeDir = dir
    }
  }
  if (bestDir) return bestDir
  // No safe wander target. If we're already safe, STAY PUT rather than walk
  // into fire; only if the current tile is itself doomed do we flee to the
  // least-dangerous neighbour to buy time for a later re-decision.
  return hereSafe ? null : bestUnsafeDir
}

function hasBombTargetAdjacent(state: BomberState, player: PlayerState): boolean {
  for (const dir of DIRS) {
    const t = targetTile(player.x, player.y, dir)
    if (!inBounds(t.x, t.y)) continue
    if (state.grid[idx(t.x, t.y)] === 'soft') return true
    if (state.players.some((p) => p.alive && p.id !== player.id && p.x === t.x && p.y === t.y)) return true
  }
  return false
}

// Would a bomb dropped at (x, y) — player's stats, full fresh fuse — have a
// straight-line retreat? Used to keep findApproachDir from ever converging on
// a soft block that's adjacent-but-unbombable (e.g. boxed in by hard walls
// with no clearing run): without this check, that tile is indistinguishable
// from a genuinely reachable target and the bot oscillates into it forever,
// wandering off empty-handed every time (never suicide, but never fights).
function canSafelyBombFrom(
  state: BomberState,
  chainAware: boolean,
  cadence: number,
  x: number,
  y: number,
  player: PlayerState,
): boolean {
  const hypBomb: Bomb = { owner: player.id, x, y, fuse: FUSE_TICKS, range: player.range }
  const postDmap = computeDangerMap(state, chainAware, hypBomb)
  return findEscapeDir(state, postDmap, { ...player, x, y }, cadence) !== null
}

function isApproachGoalTile(
  state: BomberState,
  x: number,
  y: number,
  selfId: number,
  chainAware: boolean,
  cadence: number,
  player: PlayerState,
): boolean {
  if (state.drops.some((d) => d.x === x && d.y === y)) return true
  if (state.players.some((p) => p.alive && p.id !== selfId && p.x === x && p.y === y)) return true
  for (const dir of DIRS) {
    const t = targetTile(x, y, dir)
    if (!inBounds(t.x, t.y)) continue
    if (state.grid[idx(t.x, t.y)] === 'soft' && canSafelyBombFrom(state, chainAware, cadence, x, y, player)) return true
  }
  return false
}

interface BfsNode {
  x: number
  y: number
  ticks: number
  firstDir: Dir
}

// BFS (bounded by GRID_W*GRID_H tiles) toward the nearest reachable tile that
// is a drop, an enemy's tile, or adjacent to a soft block — i.e. the nearest
// "approach" goal. Every hop the BFS considers must land on a genuinely safe
// (Infinity) tile — walking even briefly through a live bomb's footprint
// risks getting stuck there (blocked by e.g. the bomb itself) well past when
// it stops being safe. The BFS path itself may need a turn partway through
// (fine — reaching a goal is not the safety-critical promise escape makes),
// but since the bot commits to the FIRST direction for up to `cadence` ticks
// before it can reconsider, that first leg alone is re-validated with
// holdSafe before being trusted: if simply continuing straight in that
// direction (which is what actually happens, turn or no turn) would run
// past the intended turn into danger, the candidate is rejected.
function findApproachDir(
  state: BomberState,
  dmap: number[],
  player: PlayerState,
  cadence: number,
  chainAware: boolean,
): Dir | null {
  if (isApproachGoalTile(state, player.x, player.y, player.id, chainAware, cadence, player)) return null // already there
  const stepCost = stepTicks(player.speed)
  const visited = new Set<number>([idx(player.x, player.y)])
  const queue: BfsNode[] = []

  const tryTile = (x: number, y: number, ticks: number, firstDir: Dir): Dir | null => {
    if (!isWalkable(state, x, y)) return null
    const i = idx(x, y)
    if (visited.has(i)) return null
    visited.add(i)
    if (dmap[i] !== Infinity) return null
    if (isApproachGoalTile(state, x, y, player.id, chainAware, cadence, player)) return firstDir
    queue.push({ x, y, ticks, firstDir })
    return null
  }

  let candidate: Dir | null = null
  for (const dir of DIRS) {
    const t = targetTile(player.x, player.y, dir)
    const found = tryTile(t.x, t.y, stepCost, dir)
    if (found) {
      candidate = found
      break
    }
  }
  if (!candidate) {
    let qi = 0
    while (qi < queue.length) {
      const cur = queue[qi++]!
      for (const dir of DIRS) {
        const t = targetTile(cur.x, cur.y, dir)
        const found = tryTile(t.x, t.y, cur.ticks + stepCost, cur.firstDir)
        if (found) {
          candidate = found
          break
        }
      }
      if (candidate) break
    }
  }
  if (!candidate) return null

  return holdSafe(state, dmap, player, candidate, cadence, stepCost).safe ? candidate : null
}

// Deterministic given (state, mind.rng state, d); mutates only mind (rng
// advance on 'easy' mistake rolls, decision-cadence bookkeeping, and the
// remembered heading). Between decision ticks it re-issues mind.heading —
// under tap-to-step the sim consumes player.dir every tile, so the bot must
// keep feeding its own heading to keep moving (a decision commits to a
// heading for the whole cadence window; the ticks in between just repeat it).
export function botDecide(state: BomberState, id: number, mind: BotMind, d: Difficulty): Input {
  const player = state.players[id]
  if (!player || !player.alive) {
    mind.heading = null
    return { dir: null, bomb: false }
  }

  if (state.tick < mind.nextDecisionTick) {
    return { dir: mind.heading, bomb: false }
  }
  const cadence = CADENCE[d]
  mind.nextDecisionTick = state.tick + cadence

  const decision = decide(state, player, mind, d, cadence)
  mind.heading = decision.dir
  return decision
}

// The actual per-decision logic, factored out so botDecide can record the
// chosen heading in one place.
function decide(state: BomberState, player: PlayerState, mind: BotMind, d: Difficulty, cadence: number): Input {
  const chainAware = d === 'hard'
  const skipDangerCheck = d === 'easy' && mind.rng() < EASY_MISTAKE_RATE
  const dmap = computeDangerMap(state, chainAware)
  const myIdx = idx(player.x, player.y)
  const inDanger = !skipDangerCheck && dmap[myIdx] !== Infinity

  if (inDanger) {
    const escapeDir = findEscapeDir(state, dmap, player, cadence)
    if (escapeDir) return { dir: escapeDir, bomb: false }
    return { dir: wanderDir(state, dmap, player, cadence), bomb: false }
  }

  const canPlace =
    player.activeBombs < player.bombCap && !state.bombs.some((b) => b.x === player.x && b.y === player.y)
  if (canPlace && hasBombTargetAdjacent(state, player)) {
    const hypBomb: Bomb = { owner: player.id, x: player.x, y: player.y, fuse: FUSE_TICKS, range: player.range }
    const postDmap = computeDangerMap(state, chainAware, hypBomb)
    const retreatDir = findEscapeDir(state, postDmap, player, cadence)
    if (retreatDir) return { dir: retreatDir, bomb: true }
    // No safe retreat from here — don't plant. isApproachGoalTile knows this
    // exact tile is unbombable (same canSafelyBombFrom check), so
    // findApproachDir won't mistake it for "arrived" — it searches on for a
    // different, actually-bombable target (or an enemy/drop) instead.
    const away = findApproachDir(state, dmap, player, cadence, chainAware)
    return { dir: away ?? wanderDir(state, dmap, player, cadence), bomb: false }
  }

  return { dir: findApproachDir(state, dmap, player, cadence, chainAware), bomb: false }
}
