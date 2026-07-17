import { expect, it } from 'vitest'
import { createMatch } from '../src/match.js'
import { resolveShot } from '../src/resolve.js'
import { stateHash } from '../src/state.js'

// Scripted duel: both players cycle a fixed aim tape (coprime cycle lengths exercise
// interleaving of turn, round, wind-reroll, carve, and damage paths).
const ANGLES = [50, 62, 75, 88, 110, 130, 45]      // 7 entries
const POWERS = [35, 48, 55, 70, 90]                // 5 entries
it('golden master: seed 7 + scripted duel → pinned hash chain after 30 shots (or result)', () => {
  let m = createMatch(7, ['a', 'b'], [false, false])
  const chain: string[] = []
  for (let i = 0; i < 30 && !m.result; i++) {
    const out = resolveShot(m, { angle: ANGLES[i % 7]!, power: POWERS[i % 5]! })
    m = out.state
    chain.push(stateHash(m))
  }
  expect(stateHash(m)).toBe('4db4e9af')  // record from an actual green run; re-record + note why on intended changes
  expect(chain.length).toBeGreaterThan(3) // the tape survives at least 2 rounds before any result
})
