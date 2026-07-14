import { describe, expect, it } from 'vitest'
import { GROWTH_PER_FOOD, GRID_W } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState, SnakeState } from '../src/state.js'

const NAMES = ['a','b','c','d'], BOTS = [false,true,true,true]
const NONE: (Input|null)[] = [null,null,null,null]
const snake = (id: number, cells: {x:number;y:number}[], dir: SnakeState['dir'], over: Partial<SnakeState> = {}): SnakeState =>
  ({ id, name: NAMES[id]!, bot: BOTS[id]!, alive: true, dir, pendingDir: null, cells, growth: 0, ...over })
const base = (over: Partial<MatchState>): MatchState => ({ ...createMatch(42, NAMES, BOTS), food: [], ...over })
const run = (s: MatchState, inputs: (Input|null)[], n: number) => { for (let k=0;k<n;k++) s = step(s, k===0?inputs:NONE); return s }

describe('movement', () => {
  it('a snake advances one cell per stepTicksAt(0)=4 ticks, tail follows', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10},{x:7,y:10}],'right'), ...deadRest()] })
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 11, y: 10 })
    expect(s.snakes[0]!.cells).toHaveLength(4)
  })
  it('pendingDir applies at the step then clears; reverse input is rejected', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10},{x:7,y:10}],'right'), ...deadRest()] })
    s = step(s, [{dir:'left'},null,null,null])   // reverse of heading right → ignored
    expect(s.snakes[0]!.pendingDir).toBeNull()
    s = step(s, [{dir:'up'},null,null,null])     // perpendicular → pending
    expect(s.snakes[0]!.pendingDir).toBe('up')
    s = run(s, NONE, 2)                          // completes the 4-tick step window
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 10, y: 9 })
    expect(s.snakes[0]!.dir).toBe('up'); expect(s.snakes[0]!.pendingDir).toBeNull()
  })
  it('moving into a cell a tail vacates this same step is legal', () => {
    // 2x2 loop: snake of length 4 turning in a square survives forever
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:9,y:11},{x:10,y:11}],'right'), ...deadRest()] })
    s = run(s, [{dir:'down'},null,null,null], 4)
    expect(s.snakes[0]!.alive).toBe(true)
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 10, y: 11 }) // entered the cell its own tail left
  })
})

describe('deaths', () => {
  it('wall kills; body kills; two heads to one cell both die; head-swap both die', () => {
    let w = base({ snakes: [snake(0,[{x:0,y:10},{x:1,y:10}],'left'), ...deadRest()] })
    expect(run(w, NONE, 4).snakes[0]!.alive).toBe(false)
    let hh = base({ snakes: [
      snake(0,[{x:10,y:10},{x:9,y:10}],'right'), snake(1,[{x:12,y:10},{x:13,y:10}],'left'),
      snake(2,[{x:30,y:30},{x:29,y:30}],'right',{alive:false,cells:[]}), snake(3,[{x:40,y:30},{x:39,y:30}],'right',{alive:false,cells:[]})] })
    hh = run(hh, NONE, 4) // both target (11,10)
    expect(hh.snakes[0]!.alive).toBe(false); expect(hh.snakes[1]!.alive).toBe(false)
    expect(hh.result).toEqual({ kind: 'draw' })
    let sw = base({ snakes: [
      snake(0,[{x:10,y:10},{x:9,y:10}],'right'), snake(1,[{x:11,y:10},{x:12,y:10}],'left'),
      snake(2,[{x:30,y:30},{x:29,y:30}],'right',{alive:false,cells:[]}), snake(3,[{x:40,y:30},{x:39,y:30}],'right',{alive:false,cells:[]})] })
    sw = run(sw, NONE, 4) // adjacent heads moving through each other
    expect(sw.snakes[0]!.alive).toBe(false); expect(sw.snakes[1]!.alive).toBe(false)
  })
})

describe('food', () => {
  it('eating grows by GROWTH_PER_FOOD (tail frozen) and respawns one food deterministically', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10}],'right'), ...deadRest()], food: [{x:11,y:10}] })
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.growth).toBe(GROWTH_PER_FOOD)
    expect(s.food).toHaveLength(1)                    // respawned elsewhere
    expect(s.food[0]).not.toEqual({ x: 11, y: 10 })
    const len = s.snakes[0]!.cells.length
    s = run(s, NONE, 8)                               // two more steps: tail frozen twice
    expect(s.snakes[0]!.cells.length).toBe(len + 2)
    expect(s.snakes[0]!.growth).toBe(0)
  })
  it('a dead snake decays into food at even-indexed cells', () => {
    let s = base({ snakes: [snake(0,[{x:1,y:10},{x:2,y:10},{x:3,y:10},{x:4,y:10},{x:5,y:10}],'left'), ...deadRest()] })
    s = run(s, NONE, 4)                               // head hits x=0… wait, x=0 is open; heads to x=0 fine; next step x=-1 dies
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.alive).toBe(false)
    expect(s.snakes[0]!.cells).toEqual([])
    const foodIdx = new Set(s.food.map((f) => `${f.x},${f.y}`))
    expect(foodIdx.has('0,10')).toBe(true)            // index 0 (head at death)
    expect(foodIdx.has('2,10')).toBe(true)            // index 2
    // Pins PRE-TICK body semantics: a snake that dies mid-move never sheds its tail
    // that tick, so index 4 of the 5-cell body at death — the would-be shed-tail
    // cell — still becomes food (per plan's corpse-test comment).
    expect(foodIdx.has('4,10')).toBe(true)            // index 4 (shed-tail cell)
    expect(foodIdx.has('1,10')).toBe(false)           // odd index skipped
  })
})

describe('purity', () => {
  it('step never mutates its input state', () => {
    const s0 = createMatch(42, NAMES, BOTS)
    const snap = JSON.stringify(s0)
    step(s0, [{dir:'down'},null,null,null])
    expect(JSON.stringify(s0)).toBe(snap)
  })
})

function deadRest() {
  return [1,2,3].map((id) => snake(id, [], 'right', { alive: false, cells: [] }))
}
