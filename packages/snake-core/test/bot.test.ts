import { describe, expect, it } from 'vitest'
import { createBotMind, botDecide, type Difficulty } from '../src/bot.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState } from '../src/state.js'

const NAMES = ['a','b','c','d']

function allBotSim(seed: number, d: Difficulty, untilTick: number): MatchState {
  let s = createMatch(seed, NAMES, [true, true, true, true])
  const minds = [0,1,2,3].map((i) => createBotMind((seed + i) >>> 0))
  while (s.tick < untilTick && !s.result) {
    s = step(s, [0,1,2,3].map((i) => botDecide(s, i, minds[i]!, d)) as (Input|null)[])
  }
  return s
}

describe('bot gates (the boomwait 0.1.1 lesson — from day one)', () => {
  for (const d of ['easy','normal','hard'] as Difficulty[]) {
    it(`${d}: across 20 seeds no all-dead-by-100 and ≥2 alive at tick 200`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const s100 = allBotSim(seed, d, 100)
        expect(s100.snakes.filter((x) => x.alive).length, `seed ${seed} @100`).toBeGreaterThan(0)
        const s200 = allBotSim(seed, d, 200)
        expect(s200.snakes.filter((x) => x.alive).length, `seed ${seed} @200`).toBeGreaterThanOrEqual(2)
      }
    })
  }
  it('bots actually eat: median max-length at tick 400 exceeds START_LENGTH (normal, 20 seeds)', () => {
    const maxLens: number[] = []
    for (let seed = 1; seed <= 20; seed++) {
      const s = allBotSim(seed, 'normal', 400)
      maxLens.push(Math.max(...s.snakes.map((x) => x.cells.length))) // dead snakes read 0 (cells cleared)
    }
    maxLens.sort((a, b) => a - b)
    expect(maxLens[10]!).toBeGreaterThan(4)
  })
  it('a bot never picks an immediately-lethal direction when a safe one exists (deterministic fixture)', () => {
    // bot 0 heading right at (10,10); opponent body forms a solid column at x=11 spanning
    // y=6..14, so 'right' is death and up/down are open — the decision must turn.
    const base = createMatch(1, NAMES, [true, true, true, true])
    const col = Array.from({ length: 9 }, (_, i) => ({ x: 11, y: 6 + i }))
    const s: MatchState = { ...base, food: [{ x: 30, y: 30 }], snakes: [
      { ...base.snakes[0]!, dir: 'right', pendingDir: null, cells: [{x:10,y:10},{x:9,y:10},{x:8,y:10}] },
      { ...base.snakes[1]!, dir: 'down',  pendingDir: null, cells: col },
      { ...base.snakes[2]!, alive: false, cells: [] },
      { ...base.snakes[3]!, alive: false, cells: [] },
    ] }
    const out = botDecide(s, 0, createBotMind(1), 'normal')
    expect(out.dir === 'up' || out.dir === 'down').toBe(true)
  })
})
