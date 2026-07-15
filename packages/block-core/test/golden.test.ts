import { expect, it } from 'vitest'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { GameEvent } from '../src/state.js'

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}
// Two scripted humans: rotations, shifts, holds, soft/hard drops on a fixed cadence.
// Every 31 ticks p0 acts, every 37 ticks p1 acts (coprime cadences exercise interleaving);
// action cycles through this tape:
const TAPE: GameEvent[] = ['rotCW','left','left','softDrop','hardDrop','hold','right','rotCCW','hardDrop']
it('golden master: seed 7 + scripted duel → pinned state hash at tick 600', () => {
  let m = createMatch(7, ['a','b'], [false,false])
  let i0 = 0, i1 = 0
  for (let t = 1; t <= 600; t++) {
    const e0: GameEvent[] = t % 31 === 0 ? [TAPE[i0++ % TAPE.length]!] : []
    const e1: GameEvent[] = t % 37 === 0 ? [TAPE[i1++ % TAPE.length]!] : []
    m = step(m, [e0, e1])
  }
  expect(fnv1a(JSON.stringify(m))).toBe('b01c1161') // record from an actual green run; re-record + note why on intended changes
})
