import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MatchState } from 'snakewait-core'

// Regression test for Finding 2 (final review): the sim clears a dead snake's
// `cells` to `[]`, and in offline's last-alive-wins mode you're always dead
// when you lose — so passing state.snakes[YOU].cells.length straight to the
// share card reported "length 0" on every loss/draw. offline.ts must track
// the player's own length client-side (updated every tick while alive) and
// pass THAT into shareCard instead.
//
// step() is mocked so the test controls the exact tick-by-tick sequence
// (alive-with-growth, then dead-with-a-result) without depending on real bot
// AI/RNG to produce a loss. createMatch/botDecide/createBotMind stay real —
// they only shape the initial board and bot inputs, neither of which this
// test cares about.
vi.mock('snakewait-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('snakewait-core')>()
  return { ...actual, step: vi.fn() }
})

vi.mock('../src/game.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game.js')>()
  return {
    ...actual,
    setupGame: vi.fn(async () => ({
      term: { write: vi.fn(), enter: vi.fn(), installExitGuards: vi.fn(), restore: vi.fn() },
      parser: {},
      colorMode: 'truecolor',
      listener: { close: vi.fn(async () => {}), onEvent: vi.fn() },
      layout: () => ({ k: 1, cols: 80, rows: 24 }),
      drainInput: () => ({ dir: null }),
      statusLine: () => '',
      quitRequested: () => false, // the match itself must end the loop, not a quit
      onResize: () => {},
      dispose: vi.fn(),
    })),
    teardownAndExit: vi.fn(async () => 'teardown-called'),
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runOffline share card length (Finding 2 regression)', () => {
  it('carries the pre-death length into the share card when you lose, not 0', async () => {
    vi.useFakeTimers()

    const core = await import('snakewait-core')
    const base = core.createMatch(1, ['you', 'bot·1', 'bot·2', 'bot·3'], [false, true, true, true])

    // Tick 1: you're still alive and have grown to 5 cells.
    const aliveState: MatchState = {
      ...base,
      tick: 1,
      snakes: base.snakes.map((sn, i) =>
        i === 0 ? { ...sn, cells: [...sn.cells, { x: 9, y: 9 }, { x: 9, y: 10 }] } : sn,
      ),
    }
    const preDeathLength = aliveState.snakes[0]!.cells.length

    // Tick 2: you die (cells cleared, as the real sim does), someone else wins.
    const deadState: MatchState = {
      ...aliveState,
      tick: 2,
      snakes: aliveState.snakes.map((sn, i) => (i === 0 ? { ...sn, alive: false, cells: [] } : sn)),
      result: { kind: 'win', winner: 1 },
    }

    vi.mocked(core.step).mockReturnValueOnce(aliveState).mockReturnValueOnce(deadState)

    const game = await import('../src/game.js')
    const { runOffline } = await import('../src/offline.js')
    const resultPromise = runOffline({ difficulty: 'easy', name: 'you', seed: 1 })
    await vi.advanceTimersByTimeAsync(200)
    const outcome = await resultPromise
    expect(outcome).toBe('teardown-called')

    const finale = vi.mocked(game.teardownAndExit).mock.calls.at(-1)![0].finale
    expect(finale).not.toBeNull()
    expect(finale!.shareText).toContain(`length ${preDeathLength}`)
    expect(finale!.shareText).not.toContain('length 0')
  })
})
