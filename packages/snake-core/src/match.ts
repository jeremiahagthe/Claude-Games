import { FOOD_COUNT, GRID_H, GRID_W, MAX_PLAYERS, START_LENGTH } from './constants.js'
import { mulberry32, randStep } from './prng.js'
import { Cellxy, Dir, MatchState, SnakeState } from './state.js'
import { idx, stepTicksAt } from './state.js'

export const SPAWNS: { cells: Cellxy[]; dir: Dir }[] = [
  { dir: 'right', cells: [{x:7,y:4},{x:6,y:4},{x:5,y:4},{x:4,y:4}] },
  { dir: 'down',  cells: [{x:51,y:7},{x:51,y:6},{x:51,y:5},{x:51,y:4}] },
  { dir: 'left',  cells: [{x:48,y:35},{x:49,y:35},{x:50,y:35},{x:51,y:35}] },
  { dir: 'up',    cells: [{x:4,y:32},{x:4,y:33},{x:4,y:34},{x:4,y:35}] },
]

export function createMatch(seed: number, names: string[], bots: boolean[]): MatchState {
  if (names.length !== MAX_PLAYERS || bots.length !== MAX_PLAYERS) {
    throw new Error(`createMatch: expected ${MAX_PLAYERS} names and ${MAX_PLAYERS} bots`)
  }
  // Create snakes at spawn points
  const snakes: SnakeState[] = []
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const spawn = SPAWNS[i]!
    snakes.push({
      id: i,
      name: names[i]!,
      bot: bots[i]!,
      alive: true,
      dir: spawn.dir,
      pendingDir: null,
      cells: spawn.cells.slice(),
      growth: 0,
    })
  }

  // Initialize RNG state
  let rng = (mulberry32(seed)() * 4294967296) >>> 0

  // Generate food using randStep
  const food = []
  const occupied = new Set<number>()

  // Mark snake cells as occupied
  for (const snake of snakes) {
    for (const cell of snake.cells) {
      occupied.add(idx(cell.x, cell.y))
    }
  }

  // Generate FOOD_COUNT food items
  while (food.length < FOOD_COUNT) {
    const xStep = randStep(rng)
    rng = xStep.next
    const x = Math.floor(xStep.value * GRID_W)

    const yStep = randStep(rng)
    rng = yStep.next
    const y = Math.floor(yStep.value * GRID_H)

    const cellIdx = idx(x, y)
    if (!occupied.has(cellIdx)) {
      food.push({ x, y })
      occupied.add(cellIdx)
    }
  }

  return {
    tick: 0,
    stepCooldown: stepTicksAt(0),
    rng,
    rings: 0,
    snakes,
    food,
    result: null,
  }
}
