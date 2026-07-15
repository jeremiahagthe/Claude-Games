import { describe, expect, it } from 'vitest'
import { PREVIEW, TOTAL_ROWS, BOARD_W } from '../src/constants.js'
import { gravityTicksAt } from '../src/state.js'
import { createMatch } from '../src/match.js'

const NAMES = ['a', 'b'], BOTS = [false, true]

describe('createMatch', () => {
  const m = createMatch(42, NAMES, BOTS)
  it('two players, empty boards, live piece + full preview', () => {
    expect(m.players).toHaveLength(2)
    m.players.forEach((p, i) => {
      expect(p).toMatchObject({ id: i, name: NAMES[i], bot: BOTS[i], alive: true, tick: 0, hold: null, holdUsed: false, lockTicks: null, lockResets: 0, linesCleared: 0, linesSent: 0 })
      expect(p.board).toHaveLength(TOTAL_ROWS * BOARD_W)
      expect(p.board.every((c) => c === 0)).toBe(true)
      expect(p.piece).not.toBeNull()
      expect(p.queue.length).toBeGreaterThanOrEqual(PREVIEW)
      expect(p.fallCooldown).toBe(gravityTicksAt(0))
    })
  })
  it('both players get the SAME piece sequence (fairness pin)', () => {
    expect(m.players[0]!.piece!.kind).toBe(m.players[1]!.piece!.kind)
    expect(m.players[0]!.queue.slice(0, PREVIEW)).toEqual(m.players[1]!.queue.slice(0, PREVIEW))
  })
  it('first 7 pieces drawn form one complete bag (each kind exactly once)', () => {
    const first7 = [m.players[0]!.piece!.kind, ...m.players[0]!.queue].slice(0, 7)
    expect(new Set(first7).size).toBe(7)
  })
  it('deterministic per seed; different seeds differ', () => {
    expect(createMatch(42, NAMES, BOTS)).toEqual(m)
    expect(createMatch(43, NAMES, BOTS).players[0]!.piece!.kind + createMatch(43, NAMES, BOTS).players[0]!.queue.join(''))
      .not.toBe(m.players[0]!.piece!.kind + m.players[0]!.queue.join(''))
  })
  it('gravityTicksAt follows the schedule', () => {
    expect(gravityTicksAt(0)).toBe(20); expect(gravityTicksAt(399)).toBe(20)
    expect(gravityTicksAt(400)).toBe(15); expect(gravityTicksAt(2400)).toBe(2); expect(gravityTicksAt(9999)).toBe(2)
  })
})
