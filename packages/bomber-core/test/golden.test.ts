import { describe, expect, it } from 'vitest'
import { createMatch } from '../src/grid.js'
import { step } from '../src/step.js'
import type { Input } from '../src/state.js'

// Scripted-input golden master: any behavior change to the sim shows up here.
// When a change is INTENDED, re-record the hash and say why in the ledger.
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}
const SCRIPT: Record<number, (Input | null)[]> = {
  0: [{ dir: 'right', bomb: false }, { dir: 'left', bomb: false }, null, null],
  20: [{ dir: 'down', bomb: true }, null, { dir: 'up', bomb: false }, null],
  60: [{ dir: null, bomb: false }, { dir: 'down', bomb: true }, null, { dir: 'left', bomb: true }],
}
it('golden master: seed 7 + script → pinned state hash at tick 400', () => {
  let s = createMatch(7, ['a', 'b', 'c', 'd'], [false, false, false, false])
  for (let t = 0; t < 400; t++) s = step(s, SCRIPT[t] ?? [null, null, null, null])
  expect(fnv1a(JSON.stringify(s))).toBe('4904a09a')  // recorded from an actual green run; re-record + note why on intended changes
})
