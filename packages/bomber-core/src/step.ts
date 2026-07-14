import { FLAME_TICKS, FUSE_TICKS, GRID_H, GRID_W, SHRINK_INTERVAL_TICKS, SHRINK_START_TICK } from './constants.js'
import { SPIRAL } from './grid.js'
import type { Bomb, BomberState, Cell, Dir, Drop, Flame, Input, PlayerState, PowerupKind } from './state.js'
import { idx, stepTicks } from './state.js'

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

function isBlocked(state: BomberState, x: number, y: number): boolean {
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return true
  if (state.grid[idx(x, y)] !== 'empty') return true
  if (state.bombs.some((b) => b.x === x && b.y === y)) return true
  return false
}

// Movement phase: tap-to-step grid stepping. p.dir is a single-step BUFFER,
// not a persistent latch, and the buffer is CONSUMED — set back to null — the
// moment a step attempt fires (whether it moved or was blocked), so one press
// yields at most one tile.
//
// The input each tick carries one of three meanings, which is why the two kinds
// of "null" are deliberately distinct:
//   • a present input with a non-null dir  → SET the buffer to that dir (a press)
//   • a present input with dir === null    → CLEAR the buffer (an authoritative
//       stop; this is how a bot stands still and how it halts the instant it
//       decides to, with no leftover step)
//   • NO input at all (inputs[i] == null)  → KEEP whatever is buffered (a human
//       who simply isn't pressing a key this tick — so a tap made mid-cooldown
//       survives until the step actually fires)
// Continuous motion needs a fresh press every cooldown: a human holding the key
// auto-repeats it, and a bot re-issues its remembered heading each tick. Bots
// therefore always send a present input, making their movement identical to the
// old latched sim; only the (input-absent) human path buffers across cooldown.
function movementPhase(state: BomberState, inputs: (Input | null)[]): PlayerState[] {
  return state.players.map((p, i) => {
    const input = inputs[i] ?? null
    const dir: Dir | null = input === null ? p.dir : input.dir

    if (!p.alive) {
      return dir === p.dir ? p : { ...p, dir }
    }

    let cooldown = p.stepCooldown - 1
    let x = p.x
    let y = p.y
    let nextDir = dir

    if (dir !== null && cooldown <= 0) {
      const target = targetTile(x, y, dir)
      if (!isBlocked(state, target.x, target.y)) {
        x = target.x
        y = target.y
      }
      // Blocked or not, the retry cadence resets and the buffer is consumed:
      // one press yields at most one tile.
      cooldown = stepTicks(p.speed)
      nextDir = null
    }

    if (nextDir === p.dir && x === p.x && y === p.y && cooldown === p.stepCooldown) return p
    return { ...p, dir: nextDir, x, y, stepCooldown: cooldown }
  })
}

// Phase 2.5 (pickup): an alive player standing on a drop tile after movement
// collects it — stat bump (bombCap/range are unbounded here; speed is only
// effective-capped downstream via stepTicks's MIN_STEP_TICKS floor, so it is
// never clamped at pickup time), drop removed. Movement never checks player-
// vs-player collision (isBlocked only looks at grid/bombs), so two players CAN
// land on the same drop tile the same tick — ties resolve lowest-id-wins by
// walking players in id order and consuming the drop for whichever claims it
// first; later same-tick players at that tile find it already gone.
function pickupPhase(drops: Drop[], players: PlayerState[]): { drops: Drop[]; players: PlayerState[] } {
  let remaining = drops
  let changed = false
  const nextPlayers = players.map((p) => {
    if (!p.alive) return p
    const i = remaining.findIndex((d) => d.x === p.x && d.y === p.y)
    if (i === -1) return p
    const drop = remaining[i]!
    remaining = [...remaining.slice(0, i), ...remaining.slice(i + 1)]
    changed = true
    switch (drop.kind) {
      case 'bomb':
        return { ...p, bombCap: p.bombCap + 1 }
      case 'range':
        return { ...p, range: p.range + 1 }
      case 'speed':
        return { ...p, speed: p.speed + 1 }
    }
  })
  if (!changed) return { drops, players }
  return { drops: remaining, players: nextPlayers }
}

interface ShrinkResult {
  grid: Cell[]
  hidden: (PowerupKind | null)[]
  drops: Drop[]
  bombs: Bomb[]
  players: PlayerState[]
  shrinkIndex: number
}

// Phase 7.5 (sudden-death shrink): from SHRINK_START_TICK, every
// SHRINK_INTERVAL_TICKS the next SPIRAL tile closes to 'hard', destroying any
// soft block/hidden power-up/drop there, crushing any bomb parked there
// WITHOUT detonating it (a crush is a silent removal, not a chain trigger — it
// produces no flames; the owner's activeBombs is still decremented so their
// capacity frees up), and killing any player standing on it (even mid-fuse-
// cooldown — position is all that matters). shrinkIndex holds the SPIRAL index
// of the last tile closed (-1 = none yet), so SPIRAL[0] closes at exactly
// newTick === SHRINK_START_TICK. Once the spiral is exhausted (closeIndex >=
// SPIRAL.length) every player still alive dies — a guaranteed draw by tick
// SHRINK_START_TICK + SPIRAL.length * SHRINK_INTERVAL_TICKS (3780), even if
// survivors have been dodging every individual close.
function shrinkPhase(
  newTick: number,
  shrinkIndex: number,
  grid: Cell[],
  hidden: (PowerupKind | null)[],
  drops: Drop[],
  bombs: Bomb[],
  players: PlayerState[],
): ShrinkResult {
  if (newTick < SHRINK_START_TICK || (newTick - SHRINK_START_TICK) % SHRINK_INTERVAL_TICKS !== 0) {
    return { grid, hidden, drops, bombs, players, shrinkIndex }
  }
  const closeIndex = shrinkIndex + 1
  if (closeIndex >= SPIRAL.length) {
    const survivorsCleared = players.map((p) => (p.alive ? { ...p, alive: false } : p))
    return { grid, hidden, drops, bombs, players: survivorsCleared, shrinkIndex: SPIRAL.length }
  }
  const tile = SPIRAL[closeIndex]!
  const cellIdx = idx(tile.x, tile.y)

  const grid2 = grid.slice()
  grid2[cellIdx] = 'hard'
  const hidden2 = hidden.slice()
  hidden2[cellIdx] = null
  const drops2 = drops.filter((d) => idx(d.x, d.y) !== cellIdx)

  const crushed = bombs.filter((b) => idx(b.x, b.y) === cellIdx)
  const bombs2 = crushed.length === 0 ? bombs : bombs.filter((b) => idx(b.x, b.y) !== cellIdx)
  const crushCounts = new Map<number, number>()
  for (const b of crushed) crushCounts.set(b.owner, (crushCounts.get(b.owner) ?? 0) + 1)

  const players2 = players.map((p) => {
    const dec = crushCounts.get(p.id)
    const afterCrush = dec ? { ...p, activeBombs: Math.max(0, p.activeBombs - dec) } : p
    if (afterCrush.alive && afterCrush.x === tile.x && afterCrush.y === tile.y) {
      return { ...afterCrush, alive: false }
    }
    return afterCrush
  })

  return { grid: grid2, hidden: hidden2, drops: drops2, bombs: bombs2, players: players2, shrinkIndex: closeIndex }
}

// Phase 1 (bomb half): place a bomb at each requesting, alive player's CURRENT
// tile (pre-movement), subject to capacity (activeBombs < bombCap) and
// one-bomb-per-tile. Bombs placed this tick are solid to movement this same
// tick (the placer may still walk off — isBlocked only checks the
// destination tile, never the mover's own source tile).
function placeBombsPhase(
  state: BomberState,
  inputs: (Input | null)[],
): { bombs: Bomb[]; players: PlayerState[] } {
  const newBombs: Bomb[] = []
  let changed = false
  const players = state.players.map((p, i) => {
    const input = inputs[i] ?? null
    if (!p.alive || !input?.bomb) return p
    if (p.activeBombs >= p.bombCap) return p
    const occupied =
      state.bombs.some((b) => b.x === p.x && b.y === p.y) ||
      newBombs.some((b) => b.x === p.x && b.y === p.y)
    if (occupied) return p
    newBombs.push({ owner: p.id, x: p.x, y: p.y, fuse: FUSE_TICKS, range: p.range })
    changed = true
    return { ...p, activeBombs: p.activeBombs + 1 }
  })
  if (!changed) return { bombs: state.bombs, players: state.players }
  return { bombs: [...state.bombs, ...newBombs], players }
}

const RAY_DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

interface ExplosionResult {
  grid: Cell[]
  hidden: (PowerupKind | null)[]
  revealedDrops: Drop[]
  flameTiles: Map<number, { x: number; y: number }>
  remainingBombs: Bomb[]
  detonatedOwners: number[]
}

// Phase 4 + 5: work-queue explosion resolution with same-tick transitive
// chains, plus soft-block destruction and power-up reveal (each ray destroys
// at most one soft block, and stops there; rays stop at hard walls without
// flaming them).
function resolveExplosions(state: BomberState, bombsAfterFuse: Bomb[]): ExplosionResult {
  const grid = state.grid.slice()
  const hidden = state.hidden.slice()
  const revealedDrops: Drop[] = []
  const flameTiles = new Map<number, { x: number; y: number }>()
  const detonatedOwners: number[] = []

  const queue: Bomb[] = []
  let remainingBombs: Bomb[] = []
  for (const b of bombsAfterFuse) {
    if (b.fuse <= 0) queue.push(b)
    else remainingBombs.push(b)
  }

  while (queue.length > 0) {
    const bomb = queue.shift()!
    detonatedOwners.push(bomb.owner)

    const tiles: { x: number; y: number }[] = [{ x: bomb.x, y: bomb.y }]
    for (const [dx, dy] of RAY_DIRS) {
      for (let s = 1; s <= bomb.range; s++) {
        const x = bomb.x + dx * s
        const y = bomb.y + dy * s
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) break
        const cellIdx = idx(x, y)
        const cell = grid[cellIdx]
        if (cell === 'hard') break
        tiles.push({ x, y })
        if (cell === 'soft') {
          grid[cellIdx] = 'empty'
          const powerup = hidden[cellIdx]
          if (powerup) {
            hidden[cellIdx] = null
            revealedDrops.push({ x, y, kind: powerup })
          }
          break // ray stops: at most one soft destroyed per ray
        }
      }
    }

    for (const t of tiles) flameTiles.set(idx(t.x, t.y), t)

    // Chain check keys off this tick's detonation flames only; a bomb on a
    // LINGERING flame is unreachable via legal play: a flame born on a bomb tile
    // chains it that tick, and a would-be placer standing on a lingering flame
    // died the tick they stepped in (placement uses the pre-movement tile).
    const stillWaiting: Bomb[] = []
    for (const rb of remainingBombs) {
      if (flameTiles.has(idx(rb.x, rb.y))) queue.push(rb)
      else stillWaiting.push(rb)
    }
    remainingBombs = stillWaiting
  }

  return { grid, hidden, revealedDrops, flameTiles, remainingBombs, detonatedOwners }
}

export function step(state: BomberState, inputs: (Input | null)[]): BomberState {
  // Phase 1: apply inputs — bomb placement uses each player's pre-movement tile.
  const { bombs: bombsAfterPlacement, players: playersAfterPlacement } = placeBombsPhase(state, inputs)

  // Phase 2: movement (latch + step). Bombs placed this tick already block re-entry.
  const stateForMovement: BomberState = { ...state, bombs: bombsAfterPlacement, players: playersAfterPlacement }
  const playersAfterMove = movementPhase(stateForMovement, inputs)

  // Phase 2.5: pickup — a player who just moved onto a drop tile collects it.
  const { drops: dropsAfterPickup, players: playersAfterPickup } = pickupPhase(state.drops, playersAfterMove)

  // Phase 3: fuse decrement (applies to newly-placed bombs too).
  const bombsAfterFuse = bombsAfterPlacement.map((b) => ({ ...b, fuse: b.fuse - 1 }))

  // Phase 4 + 5: explosion resolution (work-queue chains) + soft destruction/drop reveal.
  const { grid, hidden, revealedDrops, flameTiles, remainingBombs, detonatedOwners } = resolveExplosions(
    state,
    bombsAfterFuse,
  )

  // Owner activeBombs decrement, one per detonated bomb.
  const decrementCounts = new Map<number, number>()
  for (const owner of detonatedOwners) decrementCounts.set(owner, (decrementCounts.get(owner) ?? 0) + 1)
  const playersAfterBombDecrement =
    decrementCounts.size === 0
      ? playersAfterPickup
      : playersAfterPickup.map((p) => {
          const dec = decrementCounts.get(p.id)
          return dec ? { ...p, activeBombs: Math.max(0, p.activeBombs - dec) } : p
        })

  // Active flames this tick: flames born this tick PLUS every carried-over flame
  // still present at the start of the tick (pre-expiry-decrement). Boundary: a
  // carried-over flame that expires during this tick's phase 7 is still lethal
  // this tick — it was burning when a player stepped onto it. Consistent with
  // the pinned expiry fixture (kill on creation tick; 0 flames after FLAME_TICKS).
  const activeFlameTiles = new Set<number>(flameTiles.keys())
  for (const f of state.flames) activeFlameTiles.add(idx(f.x, f.y))

  // Drop destruction checks THIS tick's new flames only: drops are stationary,
  // so only an arriving flame front can hit one. (Checking lingering flames too
  // would delete every explosion-revealed drop one tick after reveal — the
  // reveal tile is by construction still burning at T+1, and reveal is the only
  // in-sim drop source.) Filtered from dropsAfterPickup (not state.drops) so a
  // drop collected THIS tick by pickupPhase doesn't get resurrected here; this
  // tick's reveals are appended after, so a freshly revealed drop is never
  // destroyed by the very ray that exposed it.
  const survivingDrops = dropsAfterPickup.filter((d) => !flameTiles.has(idx(d.x, d.y)))
  const drops = [...survivingDrops, ...revealedDrops]

  // Phase 6: deaths — any alive player standing on an active flame tile dies,
  // including lingering flames from earlier ticks (players MOVE into flames;
  // contrast with stationary drops above).
  const playersAfterDeaths = playersAfterBombDecrement.map((p) => {
    if (!p.alive) return p
    if (!activeFlameTiles.has(idx(p.x, p.y))) return p
    return { ...p, alive: false }
  })

  // Phase 7: flame expiry — merge this tick's new flames with survivors, tick down.
  // A carried-over flame on a re-flamed tile is dropped in favor of the new flame
  // (timer refresh), which also keeps at most one flame entry per tile.
  const newFlames: Flame[] = Array.from(flameTiles.values()).map((t) => ({ x: t.x, y: t.y, ticks: FLAME_TICKS }))
  const carriedFlames =
    flameTiles.size === 0 ? state.flames : state.flames.filter((f) => !flameTiles.has(idx(f.x, f.y)))
  const flames = [...carriedFlames, ...newFlames]
    .map((f) => ({ ...f, ticks: f.ticks - 1 }))
    .filter((f) => f.ticks > 0)

  // Phase 7.5: sudden-death shrink — runs after flame deaths/expiry, before the
  // result stamp, so shrink kills participate in this tick's win/draw check.
  const newTick = state.tick + 1
  const shrunk = shrinkPhase(newTick, state.shrinkIndex, grid, hidden, drops, remainingBombs, playersAfterDeaths)

  // Phase 8: result stamp — set once, never overwritten once decided.
  let result = state.result
  if (result === null) {
    const alive = shrunk.players.filter((p) => p.alive)
    if (alive.length === 0) result = { kind: 'draw' }
    else if (alive.length === 1) result = { kind: 'win', winner: alive[0]!.id }
  }

  return {
    ...state,
    tick: newTick,
    grid: shrunk.grid,
    hidden: shrunk.hidden,
    drops: shrunk.drops,
    players: shrunk.players,
    bombs: shrunk.bombs,
    flames,
    shrinkIndex: shrunk.shrinkIndex,
    result,
  }
}
