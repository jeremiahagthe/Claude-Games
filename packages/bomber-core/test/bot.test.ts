import { describe, expect, it } from 'vitest'
import { FUSE_TICKS, GRID_H, GRID_W } from '../src/constants.js'
import { createMatch } from '../src/grid.js'
import { mulberry32 } from '../src/prng.js'
import { idx, type BomberState, type Dir, type Input } from '../src/state.js'
import { step } from '../src/step.js'
import { botDecide, createBotMind, dangerMap, type BotMind, type Difficulty } from '../src/bot.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [true, true, true, true]
const N: (Input | null)[] = [null, null, null, null]
function clearArena(s: BomberState): BomberState {
  return { ...s, grid: s.grid.map((c) => (c === 'soft' ? 'empty' : c)), hidden: s.hidden.map(() => null) }
}
const DIRS: Dir[] = ['up', 'down', 'left', 'right']
function move(x: number, y: number, dir: Dir): { x: number; y: number } {
  switch (dir) {
    case 'up': return { x, y: y - 1 }
    case 'down': return { x, y: y + 1 }
    case 'left': return { x: x - 1, y }
    case 'right': return { x: x + 1, y }
  }
}

describe('dangerMap', () => {
  it('marks a ticking bomb\'s center + 4 rays with its fuse value, Infinity elsewhere', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // (5,5) is odd/odd, so it and its range-1 neighbors avoid the even/even pillar grid.
    s = { ...s, bombs: [{ owner: 0, x: 5, y: 5, fuse: 17, range: 1 }] }
    const dmap = dangerMap(s)
    const dangerTiles = [
      { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 6, y: 5 }, { x: 5, y: 4 }, { x: 5, y: 6 },
    ]
    for (const t of dangerTiles) expect(dmap[idx(t.x, t.y)]).toBe(17)
    // spot-check tiles well outside the blast are untouched
    expect(dmap[idx(1, 1)]).toBe(Infinity)
    expect(dmap[idx(11, 9)]).toBe(Infinity)
    expect(dmap[idx(3, 5)]).toBe(Infinity)
    // exactly 5 finite tiles (center + 4 rays, range 1)
    const finiteCount = dmap.filter((v) => v !== Infinity).length
    expect(finiteCount).toBe(5)
  })
  it('an active flame tile reads 0', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, flames: [{ x: 6, y: 6, ticks: 4 }] }
    const dmap = dangerMap(s)
    expect(dmap[idx(6, 6)]).toBe(0)
  })
})

describe('never-suicide property', () => {
  it('200 seeded random near-bomb states with a genuine safe escape: bot survives to bomb resolution', () => {
    const rng = mulberry32(777)
    const difficulties: Difficulty[] = ['easy', 'normal', 'hard']
    let ran = 0
    let skipped = 0
    for (let i = 0; i < 200; i++) {
      const bx = 1 + Math.floor(rng() * (GRID_W - 2))
      const by = 1 + Math.floor(rng() * (GRID_H - 2))
      if (bx % 2 === 0 && by % 2 === 0) continue // pillar tile, invalid bot position
      const dx = Math.floor(rng() * 5) - 2
      const dy = Math.floor(rng() * 5) - 2
      let bombX = bx + dx
      let bombY = by + dy
      bombX = Math.max(1, Math.min(GRID_W - 2, bombX))
      bombY = Math.max(1, Math.min(GRID_H - 2, bombY))
      if (bombX % 2 === 0 && bombY % 2 === 0) continue // pillar tile, invalid bomb position
      if (bombX === bx && bombY === by) continue // don't bother with own-tile case here
      const fuse = 20 + Math.floor(rng() * 15) // 20..34: generous margin
      const range = 1 + Math.floor(rng() * 3) // 1..3

      let s = clearArena(createMatch(1, NAMES, BOTS))
      s = {
        ...s,
        players: s.players.map((p, idx0) => (idx0 === 0 ? { ...p, x: bx, y: by } : p)),
        bombs: [{ owner: 1, x: bombX, y: bombY, fuse, range }],
      }
      const dmap = dangerMap(s)
      const myIdx = idx(bx, by)
      if (dmap[myIdx] === Infinity) continue // not actually in danger, not the case under test

      // Independent connectivity check (plain BFS, ignores danger timing) for whether ANY
      // Infinity-danger tile is reachable in fewer ticks than the fuse allows — if not, this
      // fixture has no safe option and must be skipped per the brief.
      const visited = new Set<number>([myIdx])
      const queue: { x: number; y: number; dist: number }[] = [{ x: bx, y: by, dist: 0 }]
      let qi = 0
      let hasSafeOption = false
      while (qi < queue.length) {
        const cur = queue[qi++]!
        for (const dir of DIRS) {
          const t = move(cur.x, cur.y, dir)
          if (t.x < 0 || t.x >= GRID_W || t.y < 0 || t.y >= GRID_H) continue
          const ti = idx(t.x, t.y)
          if (visited.has(ti)) continue
          if (s.grid[ti] !== 'empty') continue
          if (s.bombs.some((b) => b.x === t.x && b.y === t.y)) continue
          visited.add(ti)
          const dist = cur.dist + 1
          if (dmap[ti] === Infinity && dist * 5 < fuse) { hasSafeOption = true; break }
          queue.push({ x: t.x, y: t.y, dist })
        }
        if (hasSafeOption) break
      }
      if (!hasSafeOption) { skipped++; continue }

      ran++
      const difficulty = difficulties[i % 3]!
      const mind = createBotMind(1000 + i)
      let state = s
      let ticksRun = 0
      const bound = fuse + 10 /* FLAME_TICKS */ + 40
      while (state.result === null && state.bombs.length > 0 && ticksRun < bound) {
        const input = botDecide(state, 0, mind, difficulty)
        state = step(state, [input, null, null, null])
        ticksRun++
      }
      // run a little past resolution to be safe about lingering flames
      let extra = 0
      while (extra < 15) {
        const input = botDecide(state, 0, mind, difficulty)
        state = step(state, [input, null, null, null])
        extra++
      }
      expect(state.players[0].alive).toBe(true)
    }
    expect(ran).toBeGreaterThan(0) // sanity: the fixture generator actually exercised real danger
    expect(skipped).toBeLessThan(200)
  })
})

describe('never-suicide: short-fuse occupancy window', () => {
  it('mid-stride bot must not rest on a tile whose flame lands inside its occupancy window', () => {
    // Regression for the holdSafe occupancy bug: under latched movement the bot
    // OCCUPIES each tile for stepTicks between hops, so a flame arriving inside
    // [arrival, arrival + stepCost) kills it there even though the arrival
    // instant itself was clear. Corridor fixture: p0 mid-stride (stepCooldown 4)
    // at (5,1); down blocked by soft (5,2); up is the border wall. B1 (fuse 40,
    // range 2 at (7,1)) makes (5,1) dangerous so the bot must flee along row 1.
    // Left leads onto (4,1), which B2 (fuse 7, range 1 at (3,1)) flames at tick
    // 6 — inside the bot's occupancy of that tile: it arrives ~tick 3 (mid-
    // stride cooldown), (3,1)'s own bomb dead-ends the run, and the step
    // cooldown locks it there past tick 6. An arrival-instant-only check rates
    // left safe (7 > arrival estimate) and the bot burns; occupancy-aware
    // danger must reject left and take the right-hand slack toward (6,1).
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s.grid[idx(5, 2)] = 'soft'
    s = {
      ...s,
      players: s.players.map((p, i) => (i === 0 ? { ...p, x: 5, y: 1, stepCooldown: 4 } : p)),
      bombs: [
        { owner: 1, x: 7, y: 1, fuse: 40, range: 2 },
        { owner: 1, x: 3, y: 1, fuse: 7, range: 1 },
      ],
    }
    const mind = createBotMind(7)
    let state = s
    for (let t = 0; t < 120 && state.result === null; t++) {
      const input = botDecide(state, 0, mind, 'normal')
      state = step(state, [input, null, null, null])
    }
    expect(state.players[0].alive).toBe(true)
  })

  it('100 seeded short-fuse states (fuse 6-15) with a reachable safe tile: bot survives', () => {
    // Same generator shape as the main never-suicide property but in the
    // short-fuse regime the 20-34 range never enters, where occupancy windows
    // dominate. Only normal/hard here: easy's p=0.15 danger-check skip is a
    // BY-DESIGN mistake that is fatal near short fuses (one skipped decision
    // at cadence 10 can eat the whole fuse), so it can't carry a survival
    // guarantee in this regime.
    const rng = mulberry32(888)
    const difficulties: Difficulty[] = ['normal', 'hard']
    let ran = 0
    for (let i = 0; i < 100; i++) {
      const bx = 1 + Math.floor(rng() * (GRID_W - 2))
      const by = 1 + Math.floor(rng() * (GRID_H - 2))
      if (bx % 2 === 0 && by % 2 === 0) continue
      const dx = Math.floor(rng() * 5) - 2
      const dy = Math.floor(rng() * 5) - 2
      let bombX = bx + dx
      let bombY = by + dy
      bombX = Math.max(1, Math.min(GRID_W - 2, bombX))
      bombY = Math.max(1, Math.min(GRID_H - 2, bombY))
      if (bombX % 2 === 0 && bombY % 2 === 0) continue
      if (bombX === bx && bombY === by) continue
      const fuse = 6 + Math.floor(rng() * 10) // 6..15: short-fuse regime
      const range = 1 + Math.floor(rng() * 3)

      let s = clearArena(createMatch(1, NAMES, BOTS))
      s = {
        ...s,
        players: s.players.map((p, idx0) => (idx0 === 0 ? { ...p, x: bx, y: by } : p)),
        bombs: [{ owner: 1, x: bombX, y: bombY, fuse, range }],
      }
      const dmap = dangerMap(s)
      const myIdx = idx(bx, by)
      if (dmap[myIdx] === Infinity) continue

      // Independent safe-option check as in the main property: an Infinity
      // tile reachable in fewer ticks than the fuse allows.
      const visited = new Set<number>([myIdx])
      const queue: { x: number; y: number; dist: number }[] = [{ x: bx, y: by, dist: 0 }]
      let qi = 0
      let hasSafeOption = false
      while (qi < queue.length) {
        const cur = queue[qi++]!
        for (const dir of DIRS) {
          const t = move(cur.x, cur.y, dir)
          if (t.x < 0 || t.x >= GRID_W || t.y < 0 || t.y >= GRID_H) continue
          const ti = idx(t.x, t.y)
          if (visited.has(ti)) continue
          if (s.grid[ti] !== 'empty') continue
          if (s.bombs.some((b) => b.x === t.x && b.y === t.y)) continue
          visited.add(ti)
          const dist = cur.dist + 1
          if (dmap[ti] === Infinity && dist * 5 < fuse) { hasSafeOption = true; break }
          queue.push({ x: t.x, y: t.y, dist })
        }
        if (hasSafeOption) break
      }
      if (!hasSafeOption) continue

      ran++
      const difficulty = difficulties[i % 2]!
      const mind = createBotMind(2000 + i)
      let state = s
      let ticksRun = 0
      const bound = fuse + 10 /* FLAME_TICKS */ + 40
      while (state.result === null && state.bombs.length > 0 && ticksRun < bound) {
        const input = botDecide(state, 0, mind, difficulty)
        state = step(state, [input, null, null, null])
        ticksRun++
      }
      let extra = 0
      while (extra < 15) {
        const input = botDecide(state, 0, mind, difficulty)
        state = step(state, [input, null, null, null])
        extra++
      }
      expect(state.players[0].alive).toBe(true)
    }
    expect(ran).toBeGreaterThan(0)
  })
})

describe('bombing behavior', () => {
  it('bot adjacent to a soft block with a safe retreat eventually plants (run <= 200 ticks)', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // p0 spawns at (1,1); put a lone soft block right next to it at (2,1) with plenty of
    // open safe space around for a retreat.
    s.grid[idx(2, 1)] = 'soft'
    const mind = createBotMind(42)
    let state = s
    let destroyed = false
    for (let t = 0; t < 200; t++) {
      const input = botDecide(state, 0, mind, 'normal')
      state = step(state, [input, null, null, null])
      if (state.grid[idx(2, 1)] === 'empty') { destroyed = true; break }
    }
    expect(destroyed).toBe(true)
    expect(state.players[0].alive).toBe(true)
  })
})

describe('4-bot match reaches a result', () => {
  for (const difficulty of ['easy', 'normal', 'hard'] as Difficulty[]) {
    it(`difficulty=${difficulty}: seeded match reaches result before tick 3780, softs get destroyed`, () => {
      let state = createMatch(99, NAMES, BOTS)
      const initialSofts = state.grid.filter((c) => c === 'soft').length
      const minds: BotMind[] = [0, 1, 2, 3].map((id) => createBotMind(500 + id))
      let sawFlames = false
      let steps = 0
      while (state.result === null && steps < 3780) {
        const inputs: (Input | null)[] = [0, 1, 2, 3].map((id) => botDecide(state, id, minds[id]!, difficulty))
        state = step(state, inputs)
        if (state.flames.length > 0) sawFlames = true
        steps++
      }
      expect(state.result).not.toBeNull()
      expect(state.tick).toBeLessThan(3780)
      expect(sawFlames).toBe(true)
      const finalSofts = state.grid.filter((c) => c === 'soft').length
      expect(finalSofts).toBeLessThan(initialSofts)
    })
  }
})

describe('no voluntary suicide into flames (wanderDir hole — feel-gate regression)', () => {
  // Root cause of the "bots all die in ~2s" feel-gate bug: a bot standing on a
  // SAFE tile, out of options (bomb on cooldown, no reachable approach target),
  // fell back to wanderDir, which picked the least-dangerous WALKABLE neighbour
  // even when that neighbour was an active flame — walking into its own just-
  // detonated bomb's blast. wanderDir now refuses to leave a safe tile for an
  // unsafe one.
  it('a bot on a safe tile does not step into an adjacent active flame', () => {
    // Bot at (5,5) is safe; its only non-pillar walkable neighbours are flame
    // tiles (an active blast just washed over them). It must stay put, never
    // choose a direction that walks into fire.
    let s = clearArena(createMatch(3, NAMES, BOTS))
    s = {
      ...s,
      players: s.players.map((p, i) => (i === 0 ? { ...p, x: 5, y: 5, dir: null, stepCooldown: 0, activeBombs: 1, bombCap: 1 } : { ...p, alive: false })),
      // active flames on every orthogonal neighbour of (5,5) — stepping any way burns.
      flames: [
        { x: 4, y: 5, ticks: 8 }, { x: 6, y: 5, ticks: 8 },
        { x: 5, y: 4, ticks: 8 }, { x: 5, y: 6, ticks: 8 },
      ],
    }
    const mind = createBotMind(1)
    const chosen = botDecide(s, 0, mind, 'hard')
    // Whatever it decides, applying it must not land the bot on a flame tile.
    const dest = chosen.dir ? move(s.players[0]!.x, s.players[0]!.y, chosen.dir) : { x: 5, y: 5 }
    const onFlame = s.flames.some((f) => f.x === dest.x && f.y === dest.y)
    expect(onFlame).toBe(false)
  })

  for (const difficulty of ['easy', 'normal', 'hard'] as const) {
    it(`${difficulty}: bots do not mass-suicide — not all three dead by tick 60 across seeds`, () => {
      // Before the fix, 50–67% of default-spawn matches had all three bots dead
      // by tick ~46–56 (one bomb-fuse cycle). Assert that never happens now.
      let massSuicides = 0
      for (let seed = 0; seed < 20; seed++) {
        let state = createMatch(seed, ['you', 'b1', 'b2', 'b3'], [false, true, true, true])
        const minds: BotMind[] = [1, 2, 3].map((id) => createBotMind((seed + id) >>> 0))
        const dead: Record<number, number> = {}
        for (let t = 0; t < 60 && state.result === null; t++) {
          const inputs: (Input | null)[] = [
            { dir: null, bomb: false },
            botDecide(state, 1, minds[0]!, difficulty),
            botDecide(state, 2, minds[1]!, difficulty),
            botDecide(state, 3, minds[2]!, difficulty),
          ]
          state = step(state, inputs)
          for (let i = 1; i <= 3; i++) if (!state.players[i]!.alive && dead[i] === undefined) dead[i] = state.tick
        }
        if ([1, 2, 3].every((i) => dead[i] !== undefined)) massSuicides++
      }
      expect(massSuicides).toBe(0)
    })
  }
})

describe('determinism', () => {
  it('same seed → identical decision sequence', () => {
    const runOnce = (): Input[] => {
      let state = createMatch(99, NAMES, BOTS)
      const mind = createBotMind(4242)
      const seq: Input[] = []
      for (let t = 0; t < 300; t++) {
        const inputs: (Input | null)[] = [0, 1, 2, 3].map((id) =>
          id === 0 ? botDecide(state, id, mind, 'hard') : null,
        )
        seq.push(inputs[0] as Input)
        state = step(state, inputs)
      }
      return seq
    }
    const seqA = runOnce()
    const seqB = runOnce()
    expect(seqB).toEqual(seqA)
  })
})
