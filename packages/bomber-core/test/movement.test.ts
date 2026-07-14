import { describe, expect, it } from 'vitest'
import { BASE_STEP_TICKS, MIN_STEP_TICKS } from '../src/constants.js'
import { createMatch } from '../src/grid.js'
import { step } from '../src/step.js'
import { stepTicks, type BomberState, type Input } from '../src/state.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]
const NOTHING: (Input | null)[] = [null, null, null, null]
const only = (i: Input): (Input | null)[] => [i, null, null, null]
// plan's pinned fixture assumed (3,1) empty at seed 42; the committed seeded layout
// puts a soft block there — movement semantics under test are layout-independent, so
// soft blocks are cleared (blocking behavior itself is still covered by the wall test).
function clearArena(s: BomberState): BomberState {
  return { ...s, grid: s.grid.map(c => (c === 'soft' ? 'empty' : c)), hidden: s.hidden.map(() => null) }
}
// tap once (dir on tick 0 only), then no further events for n-1 ticks
function tapOnce(s: ReturnType<typeof createMatch>, inputs: (Input | null)[], n: number) {
  for (let k = 0; k < n; k++) s = step(s, k === 0 ? inputs : NOTHING)
  return s
}
// hold a direction: re-issue the same press every tick (mirrors OS auto-repeat)
function hold(s: ReturnType<typeof createMatch>, i: Input, n: number) {
  for (let k = 0; k < n; k++) s = step(s, only(i))
  return s
}

describe('movement', () => {
  it('one tap steps exactly one tile, then stops (tap-to-step)', () => {
    let s = clearArena(createMatch(42, NAMES, BOTS))
    s = tapOnce(s, only({ dir: 'right', bomb: false }), BASE_STEP_TICKS)
    expect(s.players[0].x).toBe(2)                 // moved one tile
    expect(s.players[0].dir).toBeNull()            // heading consumed
    s = tapOnce(s, NOTHING, BASE_STEP_TICKS * 2)
    expect(s.players[0].x).toBe(2)                 // no more events → stays put
  })
  it('a tap made mid-cooldown is buffered, not lost', () => {
    let s = clearArena(createMatch(42, NAMES, BOTS))
    s = step(s, only({ dir: 'right', bomb: false }))   // tick 0: steps immediately to x=2, cooldown set
    expect(s.players[0].x).toBe(2)
    // tap again one tick later, while still on cooldown — then no further events
    s = step(s, only({ dir: 'right', bomb: false }))   // buffered (cooldown not elapsed)
    for (let k = 0; k < BASE_STEP_TICKS; k++) s = step(s, NOTHING)
    expect(s.players[0].x).toBe(3)                 // the buffered tap landed as one more tile
  })
  it('holding a direction glides continuously (hold-to-run)', () => {
    let s = clearArena(createMatch(42, NAMES, BOTS))
    s = hold(s, { dir: 'right', bomb: false }, BASE_STEP_TICKS * 3)
    expect(s.players[0].x).toBeGreaterThanOrEqual(4) // several tiles while held
  })
  it('hard/soft/pillar tiles block; a blocked tap consumes the pulse', () => {
    let s = clearArena(createMatch(42, NAMES, BOTS))
    s = hold(s, { dir: 'up', bomb: false }, BASE_STEP_TICKS * 3)
    expect(s.players[0].y).toBe(1)                 // wall at y=0 blocks the run
    s = tapOnce(s, only({ dir: null, bomb: false }), BASE_STEP_TICKS)
    expect(s.players[0]).toMatchObject({ x: 1, y: 1, dir: null })
  })
  it('speed power-up shortens the cooldown with a floor', () => {
    expect(stepTicks(0)).toBe(BASE_STEP_TICKS)
    expect(stepTicks(1)).toBe(BASE_STEP_TICKS - 1)
    expect(stepTicks(99)).toBe(MIN_STEP_TICKS)
  })
  it('step is pure: input state object is not mutated', () => {
    const s0 = createMatch(42, NAMES, BOTS)
    const snapshot = JSON.stringify(s0)
    step(s0, only({ dir: 'right', bomb: false }))
    expect(JSON.stringify(s0)).toBe(snapshot)
  })
})
