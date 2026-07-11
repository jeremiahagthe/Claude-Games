import { GRID_H, GRID_W, POWERUP_COUNTS, SOFT_BLOCK_DENSITY } from './constants.js'
import { mulberry32 } from './prng.js'
import type { BomberState, Cell, PlayerState, PowerupKind } from './state.js'
import { idx } from './state.js'

export const SPAWNS: { x: number; y: number }[] = [
  { x: 1, y: 1 },
  { x: GRID_W - 2, y: 1 },
  { x: 1, y: GRID_H - 2 },
  { x: GRID_W - 2, y: GRID_H - 2 },
]

// interior tiles, border-inward spiral order (clockwise from top-left)
function computeSpiral(): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = []
  let top = 1
  let bottom = GRID_H - 2
  let left = 1
  let right = GRID_W - 2
  while (top <= bottom && left <= right) {
    for (let x = left; x <= right; x++) result.push({ x, y: top })
    for (let y = top + 1; y <= bottom; y++) result.push({ x: right, y })
    if (top < bottom) {
      for (let x = right - 1; x >= left; x--) result.push({ x, y: bottom })
    }
    if (left < right) {
      for (let y = bottom - 1; y > top; y--) result.push({ x: left, y })
    }
    top++
    bottom--
    left++
    right--
  }
  return result
}

export const SPIRAL: { x: number; y: number }[] = computeSpiral()

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

function spawnPocketTiles(): Set<number> {
  const tiles = new Set<number>()
  for (const { x, y } of SPAWNS) {
    tiles.add(idx(x, y))
    const dx = x === 1 ? 1 : -1
    const dy = y === 1 ? 1 : -1
    tiles.add(idx(x + dx, y))
    tiles.add(idx(x, y + dy))
  }
  return tiles
}

export function createMatch(seed: number, names: string[], bots: boolean[]): BomberState {
  const grid: Cell[] = new Array(GRID_W * GRID_H).fill('empty')

  // hard border
  for (let x = 0; x < GRID_W; x++) {
    grid[idx(x, 0)] = 'hard'
    grid[idx(x, GRID_H - 1)] = 'hard'
  }
  for (let y = 0; y < GRID_H; y++) {
    grid[idx(0, y)] = 'hard'
    grid[idx(GRID_W - 1, y)] = 'hard'
  }

  // pillars at even-even interior coords
  for (let y = 2; y <= GRID_H - 2; y += 2) {
    for (let x = 2; x <= GRID_W - 2; x += 2) {
      grid[idx(x, y)] = 'hard'
    }
  }

  const spawnPockets = spawnPocketTiles()

  // eligible tiles: interior, non-pillar, non-spawn-pocket, in deterministic row-major order
  const eligible: { x: number; y: number }[] = []
  for (let y = 1; y <= GRID_H - 2; y++) {
    for (let x = 1; x <= GRID_W - 2; x++) {
      const i = idx(x, y)
      if (grid[i] === 'hard') continue
      if (spawnPockets.has(i)) continue
      eligible.push({ x, y })
    }
  }

  const rng = mulberry32(seed)

  const shuffledEligible = shuffle(eligible, rng)
  const softCount = Math.floor(shuffledEligible.length * SOFT_BLOCK_DENSITY)
  const softTiles = shuffledEligible.slice(0, softCount)
  for (const { x, y } of softTiles) {
    grid[idx(x, y)] = 'soft'
  }

  const hidden: (PowerupKind | null)[] = new Array(GRID_W * GRID_H).fill(null)
  const powerupList: PowerupKind[] = [
    ...Array(POWERUP_COUNTS.bomb).fill('bomb' as const),
    ...Array(POWERUP_COUNTS.range).fill('range' as const),
    ...Array(POWERUP_COUNTS.speed).fill('speed' as const),
  ]
  const powerupTiles = shuffle(softTiles, rng)
  const powerupTotal = Math.min(powerupList.length, powerupTiles.length)
  for (let i = 0; i < powerupTotal; i++) {
    const { x, y } = powerupTiles[i]!
    hidden[idx(x, y)] = powerupList[i]!
  }

  const players: PlayerState[] = SPAWNS.map((spawn, id) => ({
    id,
    name: names[id] ?? `p${id}`,
    bot: bots[id] ?? true,
    x: spawn.x,
    y: spawn.y,
    alive: true,
    bombCap: 1,
    range: 2,
    speed: 0,
    dir: null,
    stepCooldown: 0,
    activeBombs: 0,
  }))

  return {
    tick: 0,
    grid,
    hidden,
    drops: [],
    players,
    bombs: [],
    flames: [],
    shrinkIndex: -1,
    result: null,
  }
}
