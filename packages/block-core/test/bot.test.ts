import { describe, expect, it } from 'vitest'
import { BOARD_W } from '../src/constants.js'
import { botDecide, createBotMind, type Difficulty } from '../src/bot.js'
import { createMatch } from '../src/match.js'
import { step, stepPlayer } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { MatchState } from '../src/state.js'

function botDuel(seed: number, d: Difficulty, untilTick: number): MatchState {
  let m = createMatch(seed, ['x','y'], [true, true])
  let minds = [createBotMind(seed >>> 0), createBotMind((seed + 1) >>> 0)]
  while (m.players[0]!.tick < untilTick && !m.result) {
    const d0 = botDecide(m.players[0]!, minds[0]!, d), d1 = botDecide(m.players[1]!, minds[1]!, d)
    minds = [d0.mind, d1.mind]
    m = step(m, [d0.events, d1.events])
  }
  return m
}

describe('bot gates (day one, never loosened)', () => {
  it('normal: across 20 seeds both bots alive at tick 400 and the duel lasts ≥ 1200 ticks', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const at400 = botDuel(seed, 'normal', 400)
      expect(at400.players.every((p) => p.alive), `seed ${seed} @400`).toBe(true)
      const at1200 = botDuel(seed, 'normal', 1200)
      expect(at1200.result === null || at1200.players[0]!.tick >= 1200, `seed ${seed} early end`).toBe(true)
    }
  })
  it('easy and hard: no top-out before tick 400 (20 seeds each)', () => {
    for (const d of ['easy','hard'] as Difficulty[])
      for (let seed = 1; seed <= 20; seed++)
        expect(botDuel(seed, d, 400).players.every((p) => p.alive), `${d} seed ${seed}`).toBe(true)
  })
  it('bots actually clear and attack: normal, 20 seeds, median linesCleared ≥ 4 and median linesSent ≥ 1 by tick 1200', () => {
    const cleared: number[] = [], sent: number[] = []
    for (let seed = 1; seed <= 20; seed++) {
      const m = botDuel(seed, 'normal', 1200)
      cleared.push(Math.max(...m.players.map((p) => p.linesCleared)))
      sent.push(Math.max(...m.players.map((p) => p.linesSent)))
    }
    cleared.sort((a,b)=>a-b); sent.sort((a,b)=>a-b)
    expect(cleared[10]!).toBeGreaterThanOrEqual(4)
    expect(sent[10]!).toBeGreaterThanOrEqual(1)
  })
  it('sudden death guarantees an end: every duel decided by tick 4400 (10 seeds)', () => {
    for (let seed = 1; seed <= 10; seed++) expect(botDuel(seed, 'normal', 4400).result, `seed ${seed}`).not.toBeNull()
  })
  it('deterministic fixture: I piece + col-9 well 4 deep → bot tetrises', () => {
    const m = createMatch(1, ['x','y'], [true, true])
    let p = { ...m.players[0]!, piece: { kind: 'I' as const, rot: 0 as const, x: 3, y: 2 }, board: [...m.players[0]!.board] }
    for (let y = 20; y < 24; y++) for (let x = 0; x < BOARD_W - 1; x++) p.board[bIdx(x, y)] = 1
    let mind = createBotMind(1)
    for (let i = 0; i < 400 && p.linesCleared === 0 && p.alive; i++) {
      const d = botDecide(p, mind, 'normal'); mind = d.mind
      p = stepPlayer(p, d.events).player
    }
    expect(p.linesCleared).toBe(4)
  })
})
