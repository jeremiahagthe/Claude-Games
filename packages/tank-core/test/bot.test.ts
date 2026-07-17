import { describe, expect, it } from 'vitest'
import { SUDDEN_DEATH_ROUND } from '../src/constants.js'
import { botDecide, botObserve, createBotMind, type Difficulty } from '../src/bot.js'
import { createMatch } from '../src/match.js'
import { resolveShot } from '../src/resolve.js'
import type { MatchState } from '../src/state.js'

function botDuel(seed: number, d: Difficulty): { m: MatchState; selfKill: boolean } {
  let m = createMatch(seed, ['x', 'y'], [true, true])
  let minds = [createBotMind(seed >>> 0), createBotMind((seed + 1) >>> 0)]
  let lastShooter = 0
  while (!m.result) {
    const id = m.turn
    const dec = botDecide(m, id, minds[id]!, d)
    const out = resolveShot(m, dec.shot)
    minds[id] = botObserve(dec.mind, dec.shot, out.impact ? out.impact.x : null)
    lastShooter = id
    m = out.state
  }
  const selfKill = m.result!.kind === 'win' ? m.result!.winner !== lastShooter : true
  return { m, selfKill }
}

describe('bot gates (day one, never loosened)', () => {
  it('normal: 20 seeds all reach a result BEFORE decay alone could force one, median length sane', () => {
    const rounds: number[] = []; let selfKills = 0
    for (let seed = 1; seed <= 20; seed++) {
      const { m, selfKill } = botDuel(seed, 'normal')
      expect(m.result, `seed ${seed}`).not.toBeNull()
      rounds.push(m.round)
      if (selfKill) selfKills++
      // decay alone (from full hp) cannot end a duel before round 21 — bots must genuinely hit:
      expect(m.round, `seed ${seed} decay-only`).toBeLessThan(SUDDEN_DEATH_ROUND + 9)
    }
    rounds.sort((a, b) => a - b)
    expect(rounds[10]!).toBeGreaterThanOrEqual(3)
    expect(rounds[10]!).toBeLessThanOrEqual(14)
    expect(selfKills).toBeLessThan(4)                              // < 20% of 20 matches
  })
  it('easy and hard both finish every duel (20 seeds each)', () => {
    for (const d of ['easy', 'hard'] as Difficulty[])
      for (let seed = 1; seed <= 20; seed++) expect(botDuel(seed, d).m.result, `${d} seed ${seed}`).not.toBeNull()
  })
  it('convergence: on flat terrain the normal bot shot 3 misses by less than shot 1 (all 20 seeds)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const base = createMatch(seed, ['x', 'y'], [true, true])
      let m: MatchState = { ...base, heights: new Array(80).fill(12), tanks: [{ ...base.tanks[0]!, col: 12 }, { ...base.tanks[1]!, col: 68 }], turn: 0, firstTurn: 0, wind: 0 }
      let mind = createBotMind(seed >>> 0)
      const misses: number[] = []
      for (let s = 0; s < 3; s++) {
        const dec = botDecide(m, 0, mind, 'normal')
        const out = resolveShot(m, dec.shot)
        mind = botObserve(dec.mind, dec.shot, out.impact ? out.impact.x : null)
        misses.push(out.impact ? Math.abs(out.impact.x - 68) : 40)
        // hand the turn straight back in a CONTROLLED world (no wind, craters erased, both tanks restored):
        m = {
          ...out.state, turn: 0, wind: 0, heights: new Array(80).fill(12),
          tanks: [{ ...out.state.tanks[0]!, hp: 100, alive: true }, { ...out.state.tanks[1]!, hp: 100, alive: true }],
        }
      }
      expect(misses[2]!, `seed ${seed}: ${misses}`).toBeLessThan(misses[0]! + 0.001)
    }
  })
})
