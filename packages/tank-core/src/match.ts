import { DEFAULT_ANGLE, DEFAULT_POWER, HP_MAX, SPAWN_FLAT_HALF, SPAWN_L, SPAWN_R } from './constants.js'
import { mulberry32, randStep } from './prng.js'
import { rollWind } from './state.js'
import type { MatchState, Tank } from './state.js'
import { genTerrain } from './terrain.js'

function flatten(heights: number[], col: number): void {
  const y = heights[col]!
  for (let d = -SPAWN_FLAT_HALF; d <= SPAWN_FLAT_HALF; d++) {
    const c = Math.max(0, Math.min(79, col + d))
    heights[c] = y
  }
}

export function createMatch(seed: number, names: [string, string], bots: [boolean, boolean]): MatchState {
  let rng = (mulberry32(seed)() * 2 ** 32) >>> 0

  const terrain = genTerrain(rng)
  const heights = terrain.heights
  rng = terrain.rng

  const leftDraw = randStep(rng)
  const leftCol = SPAWN_L[0] + Math.floor(leftDraw.value * (SPAWN_L[1] - SPAWN_L[0] + 1))
  rng = leftDraw.next

  const rightDraw = randStep(rng)
  const rightCol = SPAWN_R[0] + Math.floor(rightDraw.value * (SPAWN_R[1] - SPAWN_R[0] + 1))
  rng = rightDraw.next

  flatten(heights, leftCol)
  flatten(heights, rightCol)

  const firstTurnDraw = randStep(rng)
  const firstTurn: 0 | 1 = firstTurnDraw.value < 0.5 ? 0 : 1
  rng = firstTurnDraw.next

  const windRoll = rollWind(rng)
  rng = windRoll.rng

  const tank0: Tank = {
    id: 0, name: names[0], bot: bots[0], alive: true,
    col: leftCol, hp: HP_MAX,
    lastAngle: DEFAULT_ANGLE, lastPower: DEFAULT_POWER,
    shotsFired: 0, damageDealt: 0,
  }
  const tank1: Tank = {
    id: 1, name: names[1], bot: bots[1], alive: true,
    col: rightCol, hp: HP_MAX,
    lastAngle: 180 - DEFAULT_ANGLE, lastPower: DEFAULT_POWER,
    shotsFired: 0, damageDealt: 0,
  }

  return {
    heights,
    tanks: [tank0, tank1],
    turn: firstTurn,
    firstTurn,
    round: 1,
    wind: windRoll.wind,
    rng,
    result: null,
  }
}
