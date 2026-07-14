import { GRID_H, GRID_W, SHRINK_INTERVAL_TICKS, SHRINK_START_TICK } from './constants.js'
import { mulberry32 } from './prng.js'
import type { Cellxy, Dir, Input, MatchState } from './state.js'
import { idx, isWall } from './state.js'

export type Difficulty = 'easy' | 'normal' | 'hard'

export interface BotMind {
  rng: () => number
  nextDecisionTick: number
}

const CADENCE: Record<Difficulty, number> = { easy: 10, normal: 5, hard: 3 }
const EASY_MISTAKE_RATE = 0.15

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }
const DELTA: Record<Dir, Cellxy> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}
// Fixed canonical order for deterministic tie-breaking.
const ALL_DIRS: Dir[] = ['up', 'down', 'left', 'right']

export function createBotMind(seed: number): BotMind {
  return { rng: mulberry32(seed), nextDecisionTick: 0 }
}

type IsBlocked = (x: number, y: number) => boolean

// 4-connected flood fill from `start`, counting reachable free cells (including start
// itself if free). Returns 0 if `start` is itself blocked. Stops early once `cap` is
// reached — callers only need to know the count relative to a threshold (own body
// length) or a bounded "largest space" comparison, so the count need not be exact once
// it clearly exceeds what any comparison cares about.
function floodFillCount(start: Cellxy, isBlocked: IsBlocked, cap: number): number {
  if (isBlocked(start.x, start.y)) return 0
  const visited = new Set<number>([idx(start.x, start.y)])
  const queue: Cellxy[] = [start]
  let qi = 0
  let count = 1
  while (qi < queue.length && count < cap) {
    const c = queue[qi++]!
    for (const d of ALL_DIRS) {
      const delta = DELTA[d]
      const nx = c.x + delta.x
      const ny = c.y + delta.y
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
      const ni = idx(nx, ny)
      if (visited.has(ni) || isBlocked(nx, ny)) continue
      visited.add(ni)
      queue.push({ x: nx, y: ny })
      count++
      if (count >= cap) break
    }
  }
  return count
}

// BFS from `head` over unblocked cells to the nearest food cell; returns the direction
// of the first hop taken from `head` on that shortest path, or null if no food is
// reachable.
function bfsFirstHopToFood(head: Cellxy, isBlocked: IsBlocked, foodSet: Set<number>): Dir | null {
  if (foodSet.size === 0) return null
  const visited = new Set<number>([idx(head.x, head.y)])
  const queue: { x: number; y: number; hop: Dir }[] = []
  for (const d of ALL_DIRS) {
    const delta = DELTA[d]
    const nx = head.x + delta.x
    const ny = head.y + delta.y
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
    const ni = idx(nx, ny)
    if (visited.has(ni) || isBlocked(nx, ny)) continue
    visited.add(ni)
    queue.push({ x: nx, y: ny, hop: d })
  }
  let qi = 0
  while (qi < queue.length) {
    const c = queue[qi++]!
    const ci = idx(c.x, c.y)
    if (foodSet.has(ci)) return c.hop
    for (const d of ALL_DIRS) {
      const delta = DELTA[d]
      const nx = c.x + delta.x
      const ny = c.y + delta.y
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
      const ni = idx(nx, ny)
      if (visited.has(ni) || isBlocked(nx, ny)) continue
      visited.add(ni)
      queue.push({ x: nx, y: ny, hop: c.hop })
    }
  }
  return null
}

export function botDecide(state: MatchState, id: number, mind: BotMind, d: Difficulty): Input {
  if (state.tick < mind.nextDecisionTick) return { dir: null }
  mind.nextDecisionTick = state.tick + CADENCE[d]

  const snake = state.snakes[id]
  if (!snake || !snake.alive) return { dir: null }
  const head = snake.cells[0]!
  const ownLength = snake.cells.length

  // Step 1: blocked-set — every snake body cell + wall/ring cells, plus pre-evacuation
  // of the NEXT ring once shrink is within 2 intervals.
  const bodySet = new Set<number>()
  for (const s of state.snakes) {
    if (!s.alive) continue
    for (const c of s.cells) bodySet.add(idx(c.x, c.y))
  }
  const preEvacuate = state.tick >= SHRINK_START_TICK - 2 * SHRINK_INTERVAL_TICKS
  const isBlocked: IsBlocked = (x, y) => {
    if (isWall(x, y, state.rings)) return true
    if (preEvacuate && isWall(x, y, state.rings + 1)) return true
    return bodySet.has(idx(x, y))
  }

  // Step 2: candidate dirs — the 3 non-reverse dirs from current heading, minus blocked.
  // Flood-fill space is capped well above own length: exact counts don't matter once a
  // candidate is clearly safe, only "reachable >= own length" and coarse ranking do.
  const spaceCap = Math.min(GRID_W * GRID_H, ownLength + 100)
  const reverse = OPPOSITE[snake.dir]
  const unblocked: { dir: Dir; next: Cellxy; space: number }[] = []
  for (const dir of ALL_DIRS) {
    if (dir === reverse) continue
    const delta = DELTA[dir]
    const next = { x: head.x + delta.x, y: head.y + delta.y }
    if (next.x < 0 || next.x >= GRID_W || next.y < 0 || next.y >= GRID_H) continue
    if (isBlocked(next.x, next.y)) continue
    unblocked.push({ dir, next, space: floodFillCount(next, isBlocked, spaceCap) })
  }

  if (unblocked.length === 0) return { dir: null }

  // Step 3: survival check — flood-fill reachable space from the candidate must be >=
  // own body length. `easy` skips this check on 15% of decisions.
  const skipSurvival = d === 'easy' && mind.rng() < EASY_MISTAKE_RATE
  let survivors = skipSurvival ? unblocked : unblocked.filter((c) => c.space >= ownLength)

  // Step 4: `hard` only — reject candidates 4-adjacent to the head of an alive opponent
  // whose length >= own (head-to-head risk).
  if (d === 'hard') {
    const dangerousHeads: Cellxy[] = []
    for (const s of state.snakes) {
      if (!s.alive || s.id === id) continue
      if (s.cells.length >= ownLength) dangerousHeads.push(s.cells[0]!)
    }
    if (dangerousHeads.length > 0) {
      const dangerCells = new Set<number>()
      for (const h of dangerousHeads) {
        for (const dd of ALL_DIRS) {
          const delta = DELTA[dd]
          const nx = h.x + delta.x
          const ny = h.y + delta.y
          if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue
          dangerCells.add(idx(nx, ny))
        }
      }
      survivors = survivors.filter((c) => !dangerCells.has(idx(c.next.x, c.next.y)))
    }
  }

  // Step 5: BFS to nearest food; if its first hop survived steps 2-4, take it.
  const foodSet = new Set(state.food.map((f) => idx(f.x, f.y)))
  const bfsHop = bfsFirstHopToFood(head, isBlocked, foodSet)
  if (bfsHop != null && survivors.some((c) => c.dir === bfsHop)) {
    return { dir: bfsHop }
  }

  // Step 6: fallback — surviving candidate with the largest space; else the unblocked
  // candidate with the largest space; else ride it out. The capped counts from step 2
  // can tie at the cap when candidates' true reachable space both exceed it, so the
  // comparison here uses EXACT (uncapped) flood-fill counts, recomputed only for the
  // ≤3 pool candidates and only on decisions that actually reach this fallback.
  const pool = survivors.length > 0 ? survivors : unblocked
  let best = pool[0]!
  let bestExact = floodFillCount(best.next, isBlocked, GRID_W * GRID_H)
  for (let i = 1; i < pool.length; i++) {
    const c = pool[i]!
    const exact = floodFillCount(c.next, isBlocked, GRID_W * GRID_H)
    if (exact > bestExact) {
      best = c
      bestExact = exact
    }
  }
  return { dir: best.dir }
}
