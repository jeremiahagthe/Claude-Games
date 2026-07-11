import { FLAME_TICKS, FUSE_TICKS, GRID_H, GRID_W } from './constants.js'
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

// Movement phase: latched-direction grid stepping.
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

    if (dir !== null && cooldown <= 0) {
      const target = targetTile(x, y, dir)
      if (!isBlocked(state, target.x, target.y)) {
        x = target.x
        y = target.y
      }
      // Blocked or not, the retry cadence resets on an expired cooldown.
      cooldown = stepTicks(p.speed)
    }

    if (dir === p.dir && x === p.x && y === p.y && cooldown === p.stepCooldown) return p
    return { ...p, dir, x, y, stepCooldown: cooldown }
  })
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
      ? playersAfterMove
      : playersAfterMove.map((p) => {
          const dec = decrementCounts.get(p.id)
          return dec ? { ...p, activeBombs: Math.max(0, p.activeBombs - dec) } : p
        })

  // Existing drops caught in this tick's flame are destroyed; freshly revealed drops survive.
  const survivingDrops = state.drops.filter((d) => !flameTiles.has(idx(d.x, d.y)))
  const drops = [...survivingDrops, ...revealedDrops]

  // Phase 6: deaths — any alive player standing on a flame tile dies.
  const playersAfterDeaths = playersAfterBombDecrement.map((p) => {
    if (!p.alive) return p
    if (!flameTiles.has(idx(p.x, p.y))) return p
    return { ...p, alive: false }
  })

  // Phase 7: flame expiry — merge this tick's new flames with survivors, tick down.
  const newFlames: Flame[] = Array.from(flameTiles.values()).map((t) => ({ x: t.x, y: t.y, ticks: FLAME_TICKS }))
  const flames = [...state.flames, ...newFlames]
    .map((f) => ({ ...f, ticks: f.ticks - 1 }))
    .filter((f) => f.ticks > 0)

  // Phase 8: result stamp — set once, never overwritten once decided.
  let result = state.result
  if (result === null) {
    const alive = playersAfterDeaths.filter((p) => p.alive)
    if (alive.length === 0) result = { kind: 'draw' }
    else if (alive.length === 1) result = { kind: 'win', winner: alive[0]!.id }
  }

  return {
    ...state,
    tick: state.tick + 1,
    grid,
    hidden,
    drops,
    players: playersAfterDeaths,
    bombs: remainingBombs,
    flames,
    result,
  }
}
