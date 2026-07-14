import { expect, it } from 'vitest'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input } from '../src/state.js'

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}
// 4 human snakes, scripted turns (spawn runways are ~44 cells ≈ 176 ticks — these turns keep
// everyone alive past tick 200, then natural deaths may occur; both are fine, the hash pins it).
const SCRIPT: Record<number, (Input | null)[]> = {
  40:  [{ dir: 'down' },  { dir: 'left' },  { dir: 'up' },    { dir: 'right' }],
  120: [{ dir: 'right' }, { dir: 'down' },  { dir: 'left' },  { dir: 'up' }],
  200: [{ dir: 'up' },    { dir: 'right' }, { dir: 'down' },  { dir: 'left' }],
  280: [{ dir: 'left' },  { dir: 'up' },    { dir: 'right' }, { dir: 'down' }],
}
it('golden master: seed 7 + script → pinned state hash at tick 400', () => {
  let s = createMatch(7, ['a','b','c','d'], [false,false,false,false])
  for (let t = 0; t < 400; t++) s = step(s, SCRIPT[t] ?? [null, null, null, null])
  expect(fnv1a(JSON.stringify(s))).toBe('1d50378b') // record from an actual green run; re-record + note why on intended changes
})
