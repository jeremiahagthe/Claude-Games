import {
  GROWTH_PER_FOOD,
  GRID_H,
  GRID_W,
  SHRINK_INTERVAL_TICKS,
  SHRINK_START_TICK,
} from './constants.js'
import { randStep } from './prng.js'
import type { Cellxy, Food, Input, MatchState, Result, SnakeState } from './state.js'
import { DELTA, idx, isWall, OPPOSITE, stepTicksAt } from './state.js'

const MAX_RESPAWN_ATTEMPTS = 200
const MAX_RINGS = Math.min(GRID_W, GRID_H) / 2 // 20 — grid fully closed at this ring count

// Sudden-death ring count for a given tick: 0 before SHRINK_START_TICK, then +1 every
// SHRINK_INTERVAL_TICKS, capped at MAX_RINGS (grid fully closed; every cell is wall).
function ringsAt(tick: number): number {
  if (tick < SHRINK_START_TICK) return 0
  const rings = 1 + Math.floor((tick - SHRINK_START_TICK) / SHRINK_INTERVAL_TICKS)
  return Math.min(rings, MAX_RINGS)
}

// Corpse-food rule: a dead snake's even-indexed pre-death body cells decay to food,
// skipping cells that are wall (in the given ring count) or already carry food. Returns a
// new food array (input is never mutated); pushes the ORIGINAL cell objects, matching the
// three call sites this replaces (applyShrink / killSnake / step Phase 7).
function corpseFoodFor(cells: Cellxy[], food: Food[], rings: number): Food[] {
  const next = food.slice()
  const foodSet = new Set(next.map((f) => idx(f.x, f.y)))
  for (let ci = 0; ci < cells.length; ci += 2) {
    const c = cells[ci]!
    if (isWall(c.x, c.y, rings)) continue
    const cIdx = idx(c.x, c.y)
    if (foodSet.has(cIdx)) continue
    next.push(c)
    foodSet.add(cIdx)
  }
  return next
}

// Sudden-death shrink: any alive snake with a cell inside the newly closed ring dies
// entirely; its cells not inside a closed ring decay to food per the corpse-food rule
// (even-indexed, skipping wall/existing-food cells); food already inside the newly
// closed ring is destroyed. No-op if the ring count didn't advance this tick.
function applyShrink(
  snakes: SnakeState[],
  food: Food[],
  oldRings: number,
  newRings: number,
): { snakes: SnakeState[]; food: Food[] } {
  if (newRings <= oldRings) return { snakes, food }

  let nextSnakes = snakes
  let nextFood = food.filter((f) => !isWall(f.x, f.y, newRings))

  for (const snake of snakes) {
    if (!snake.alive) continue
    const hitsRing = snake.cells.some((c) => isWall(c.x, c.y, newRings))
    if (!hitsRing) continue

    nextFood = corpseFoodFor(snake.cells, nextFood, newRings)

    nextSnakes = nextSnakes.map((s) =>
      s.id === snake.id ? { ...s, alive: false, pendingDir: null, cells: [] } : s,
    )
  }

  return { snakes: nextSnakes, food: nextFood }
}

function stampResult(existing: Result | null, snakes: SnakeState[]): Result | null {
  if (existing !== null) return existing
  const alive = snakes.filter((s) => s.alive)
  if (alive.length === 0) return { kind: 'draw' }
  if (alive.length === 1) return { kind: 'win', winner: alive[0]!.id }
  return null
}

// Kills a single snake OUTSIDE the normal step() cadence — used by the server to resolve a
// disconnect-grace expiry (see snakewait server Task 7): applies the same corpse rule as
// step()'s Phase 7 (even-indexed pre-death cells → food, skipping walls/closed-ring cells and
// cells already carrying food), clears its cells, and marks it dead. Pure and a no-op if the
// snake is unknown or already dead — this never stamps a result itself; the next step() call
// picks that up naturally via its own Phase 9 (stampResult sees the now-dead snake).
export function killSnake(state: MatchState, id: number): MatchState {
  const snake = state.snakes.find((s) => s.id === id)
  if (!snake || !snake.alive) return state

  const food = corpseFoodFor(snake.cells, state.food, state.rings)

  const snakes = state.snakes.map((s) => (s.id === id ? { ...s, alive: false, pendingDir: null, cells: [] } : s))
  return { ...state, snakes, food }
}

export function step(state: MatchState, inputs: (Input | null)[]): MatchState {
  const newTick = state.tick + 1

  // Phase 1: inputs (every tick) — reject 180 reverse of last ACTUALLY MOVED heading (snake.dir)
  const snakesAfterInput: SnakeState[] = state.snakes.map((snake, i) => {
    if (!snake.alive) return snake
    const dir = inputs[i]?.dir
    if (dir != null && dir !== OPPOSITE[snake.dir]) {
      return { ...snake, pendingDir: dir }
    }
    return snake
  })

  // Phase 2: cooldown — shrink still runs on skipped ticks (tick/shrink/result run every tick)
  const newCooldown = state.stepCooldown - 1
  if (newCooldown > 0) {
    const ringsOnSkip = ringsAt(newTick)
    const shrunkOnSkip = applyShrink(snakesAfterInput, state.food, state.rings, ringsOnSkip)
    return {
      ...state,
      tick: newTick,
      stepCooldown: newCooldown,
      rings: ringsOnSkip,
      snakes: shrunkOnSkip.snakes,
      food: shrunkOnSkip.food,
      result: stampResult(state.result, shrunkOnSkip.snakes),
    }
  }

  // Phase 3: movement step — compute next head per alive snake, resolve the moved heading
  const movement = snakesAfterInput.map((snake) => {
    if (!snake.alive) return null
    const dir = snake.pendingDir ?? snake.dir
    const delta = DELTA[dir]
    const head = snake.cells[0]!
    const nextHead = { x: head.x + delta.x, y: head.y + delta.y }
    return { snake, dir, head, nextHead }
  })

  // Phase 4: tails vacate — occupancy for collision = remaining body cells of ALL alive snakes
  const vacated = snakesAfterInput.map((snake) => {
    if (!snake.alive) return null
    if (snake.growth > 0) {
      return { bodyAfterVacate: snake.cells, growth: snake.growth - 1 }
    }
    return { bodyAfterVacate: snake.cells.slice(0, -1), growth: 0 }
  })

  const occupied = new Set<number>()
  for (const v of vacated) {
    if (!v) continue
    for (const c of v.bodyAfterVacate) occupied.add(idx(c.x, c.y))
  }

  // Phase 5: deaths (simultaneous) — wall, body occupancy, shared target cell, head-swap
  const aliveMovers = movement.filter((m): m is NonNullable<typeof m> => m !== null)
  const headTargetCounts = new Map<number, number>()
  for (const m of aliveMovers) {
    const key = idx(m.nextHead.x, m.nextHead.y)
    headTargetCounts.set(key, (headTargetCounts.get(key) ?? 0) + 1)
  }

  const deadIds = new Set<number>()
  for (const m of aliveMovers) {
    if (isWall(m.nextHead.x, m.nextHead.y, state.rings)) {
      deadIds.add(m.snake.id)
      continue
    }
    const key = idx(m.nextHead.x, m.nextHead.y)
    if (occupied.has(key)) {
      deadIds.add(m.snake.id)
      continue
    }
    if ((headTargetCounts.get(key) ?? 0) > 1) {
      deadIds.add(m.snake.id)
    }
  }
  for (let i = 0; i < aliveMovers.length; i++) {
    for (let j = i + 1; j < aliveMovers.length; j++) {
      const a = aliveMovers[i]!
      const b = aliveMovers[j]!
      if (
        a.nextHead.x === b.head.x &&
        a.nextHead.y === b.head.y &&
        b.nextHead.x === a.head.x &&
        b.nextHead.y === a.head.y
      ) {
        deadIds.add(a.snake.id)
        deadIds.add(b.snake.id)
      }
    }
  }

  // Build post-movement snakes: survivors get the new head prepended; snakes that died
  // this tick keep their pre-tick body (never actually completed the move) for corpse
  // conversion below, then get cleared to alive:false/cells:[].
  let snakes: SnakeState[] = snakesAfterInput.map((snake, i) => {
    const m = movement[i]
    if (!m) return snake // already dead before this tick
    if (deadIds.has(snake.id)) {
      return { ...snake, alive: false, dir: m.dir, pendingDir: null, cells: [] }
    }
    const v = vacated[i]!
    return {
      ...snake,
      alive: true,
      dir: m.dir,
      pendingDir: null,
      cells: [m.nextHead, ...v.bodyAfterVacate],
      growth: v.growth,
    }
  })

  // Phase 6: food — surviving head on a food cell grows the snake and respawns one food
  let food: Food[] = state.food.slice()
  let rng = state.rng
  for (let i = 0; i < snakes.length; i++) {
    const snake = snakes[i]!
    if (!snake.alive) continue
    const head = snake.cells[0]!
    const eatenIdx = food.findIndex((f) => f.x === head.x && f.y === head.y)
    if (eatenIdx === -1) continue

    food = food.slice(0, eatenIdx).concat(food.slice(eatenIdx + 1))
    snakes = snakes.map((s) => (s.id === snake.id ? { ...s, growth: s.growth + GROWTH_PER_FOOD } : s))

    const occupiedNow = new Set<number>()
    for (const s of snakes) {
      if (!s.alive) continue
      for (const c of s.cells) occupiedNow.add(idx(c.x, c.y))
    }
    for (const f of food) occupiedNow.add(idx(f.x, f.y))

    let placed = false
    for (let attempt = 0; attempt < MAX_RESPAWN_ATTEMPTS && !placed; attempt++) {
      const xStep = randStep(rng)
      rng = xStep.next
      const x = Math.floor(xStep.value * GRID_W)
      const yStep = randStep(rng)
      rng = yStep.next
      const y = Math.floor(yStep.value * GRID_H)

      const cellIdx = idx(x, y)
      if (isWall(x, y, state.rings) || occupiedNow.has(cellIdx)) continue
      food = [...food, { x, y }]
      placed = true
    }
    // 200 re-rolls exhausted (field effectively full): skip silently, no food added.
  }

  // Phase 7: corpse-food — snakes that died THIS tick convert even-indexed pre-tick body
  // cells to food (skipping walls/existing food); corpse cells become [].
  for (let i = 0; i < snakesAfterInput.length; i++) {
    const snake = snakesAfterInput[i]!
    if (!deadIds.has(snake.id)) continue
    food = corpseFoodFor(snake.cells, food, state.rings)
  }

  // Phase 8: shrink (after movement/deaths, before result stamp — shrink kills count this tick)
  const newRings = ringsAt(newTick)
  const shrunk = applyShrink(snakes, food, state.rings, newRings)
  snakes = shrunk.snakes
  food = shrunk.food

  // Phase 9: result stamp (set once)
  const result = stampResult(state.result, snakes)

  return {
    ...state,
    tick: newTick,
    stepCooldown: stepTicksAt(newTick),
    rng,
    rings: newRings,
    snakes,
    food,
    result,
  }
}
