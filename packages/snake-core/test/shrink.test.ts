import { describe, expect, it } from 'vitest'
import { SHRINK_INTERVAL_TICKS, SHRINK_START_TICK } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState } from '../src/state.js'

const NAMES = ['a','b','c','d'], BOTS = [false,true,true,true]
// loops must be DRIVEN (see loopInputs below) — all-null inputs would run every snake straight into a wall
const advanceTo = (s: MatchState, tick: number) => { while (s.tick < tick) s = step(s, loopInputs(s)); return s }

describe('sudden death', () => {
  it('rings stays 0 before SHRINK_START_TICK, then advances every interval', () => {
    // park all snakes safely in the middle as 2x2 loops so they never die (see Task 2 loop test)
    let s = midLoopState()
    s = advanceTo(s, SHRINK_START_TICK - 1); expect(s.rings).toBe(0)
    s = step(s, loopInputs(s));               expect(s.rings).toBe(1)
    s = advanceTo(s, SHRINK_START_TICK + SHRINK_INTERVAL_TICKS); expect(s.rings).toBe(2)
  })
  it('a snake with any cell in the closing ring dies; its safe cells become food; ring food destroyed', () => {
    let s = midLoopState()
    // move snake 0's loop to hug the border: cells include (0,10) — dies when ring 1 closes
    s.snakes[0] = { ...s.snakes[0]!, cells: [{x:0,y:10},{x:1,y:10},{x:1,y:11},{x:0,y:11}] }
    s.food = [{ x: 0, y: 20 }]                     // in ring 1: destroyed
    s = advanceTo(s, SHRINK_START_TICK)
    expect(s.rings).toBe(1)
    expect(s.snakes[0]!.alive).toBe(false)
    expect(s.food.some((f) => f.x === 0)).toBe(false)          // nothing on the closed ring
    expect(s.food.some((f) => f.x === 1 && f.y === 10)).toBe(true) // even-index corpse cell inside safe area
  })
  it('the match is guaranteed decided by tick 2600', () => {
    let s = midLoopState()
    s = advanceTo(s, 2600)
    expect(s.result).not.toBeNull()
  })
})

// Four 2x2 self-loops parked far apart mid-field. A length-4 snake in a 2x2 block that turns
// CLOCKWISE every step cycles that block forever (each move enters the cell its own tail
// vacates — legal per Task 2), so loops survive until shrink reaches them. Drive them by
// feeding each alive snake the clockwise turn of its current heading every tick (extra inputs
// on non-step ticks are harmless — pendingDir just gets re-set to the same value):
const CW = { up: 'right', right: 'down', down: 'left', left: 'up' } as const
function loopInputs(s: MatchState): (Input | null)[] {
  return s.snakes.map((sn) => (sn.alive ? { dir: CW[sn.dir] } : null))
}
function midLoopState(): MatchState {
  const base = createMatch(7, NAMES, BOTS)
  const block = (id: number, x: number, y: number) => ({
    ...base.snakes[id]!,
    dir: 'right' as const,
    cells: [{x:x+1,y},{x,y},{x,y:y+1},{x:x+1,y:y+1}], // head (x+1,y) heading right; CW turn = down
  })
  return { ...base, food: [], snakes: [block(0,20,18), block(1,34,18), block(2,20,26), block(3,34,26)] }
}
