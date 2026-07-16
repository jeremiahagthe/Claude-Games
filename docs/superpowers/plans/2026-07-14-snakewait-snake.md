# snakewait (terminal multiplayer snake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship game 4 of the /games arcade — 4-snake last-alive-wins classic snake on a 56x40 field, online with bot backfill plus fully offline vs 3 bots, as npm packages `snakewait-core` + `snakewait`.

**Architecture:** Mirrors boomwait exactly: zero-dep deterministic core (pure fixed-tick reducer at 20Hz, seeded RNG carried IN state for mid-match food spawns), thin authoritative Durable Objects in the EXISTING fragwait-server worker (migration v4 appended), client on the already-published `termwait@0.1.0` (exact pin — NO extraction work this time). Spec: `docs/superpowers/specs/2026-07-14-snakewait-snake-design.md` — read it first; it governs on any conflict.

**Tech Stack:** TypeScript strict / ESM NodeNext / vitest / Cloudflare Workers + DOs (wrangler 4.107.0, Node 22 for wrangler) / no runtime deps in core.

## Global Constraints (house rules — every task inherits these)

- `packages/snake-core` (`snakewait-core`): ZERO runtime deps; no `Date.now`/`Math.random` in core src (a grep test enforces it). RNG is a PURE serializable step function (`randStep(s: number)`) because food spawns mid-match — the closure-style mulberry32 is only for deriving the initial rng seed field.
- Exact version pins everywhere (`"x.y.z"`, never `^`/`~`). `.js` import extensions. Repo path contains a space — always quote.
- TDD: write the failing test first, run it, implement, run again, commit. Test literals are spec pins — change constants and tests together with the root cause stated in the test or ledger.
- Never run the interactive game in subagents; tests + build only. Feel verdicts come from the USER in iTerm2 at the default 80x24 window.
- After every task: append a ledger entry to `.superpowers/sdd/progress.md` (gitignored, still required) and commit with trailer exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- fragwait, checkwait, AND boomwait packages are UNTOUCHED (packages/core, packages/client, packages/chess-core, packages/chess-client, packages/bomber-core, packages/bomber-client — zero-diff reads only, for pattern reference). termwait (`packages/term-kit`) is consumed as-is at 0.1.0 — no edits.
- wrangler.jsonc migrations: APPEND tag v4 only; v1/v2/v3 are never edited (a literal file-reading test enforces order).
- Run tests: `npx vitest run packages/snake-core` (etc.) from repo root; full suite `npm test` must stay green (currently 674). The plugin launcher test runs STANDALONE with a ~30s bound (known chaining hang).
- The 80x24 frame fit (Task 8) is asserted by tests, not eyeballed — the checkwait lesson.
- packages/server and packages/snake-client import `snakewait-core` through its BUILT dist (workspace symlink → `dist/`): after ANY core src change, run `npm run build -w snakewait-core` before running server/client tests — a stale dist cost a full debugging cycle at boomwait 0.1.2.
- Movement-model lesson from boomwait 0.1.2: snake NEVER stops, so there is no tap-vs-hold subtlety — a keypress sets `pendingDir`, the sim applies it at the next step, same-dir repeats are no-ops and 180° reverses are REJECTED BY THE SIM (auto-repeat-proof by construction). Do not add client-side hold/stop logic.

## File Structure

```
packages/snake-core/            → npm "snakewait-core"
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/constants.ts              (grid, tick, speed schedule, food, shrink)
  src/prng.ts                   (mulberry32 + pure randStep — copied/adapted from fragwait-core)
  src/state.ts                  (SnakeState, MatchState, Input, Result, idx, isWall, stepTicksAt)
  src/match.ts                  (createMatch: spawns, initial food)
  src/step.ts                   (step(): pendingDir, movement, collisions, food, corpse-food, shrink, result)
  src/bot.ts                    (botDecide: BFS food-seek + flood-fill survival)
  src/protocol.ts               (msg types, RLE wire codec, parse + caps, sanitizeHandle)
  test/{match,step,shrink,golden,bot,protocol,nodate}.test.ts
packages/server/src/
  snake-lobby.ts                (SnakeLobbyDO)  [new]
  snake-match.ts                (SnakeMatchDO + SnakeMatchHost) [new]
  index.ts                      (add /snake routes + DO exports) [modify]
  ../wrangler.jsonc             (SNAKE_LOBBY/SNAKE_MATCH bindings + migration v4 APPEND) [modify]
  ../package.json               (add snakewait-core workspace dep) [modify]
  test/snake.test.ts            [new]
packages/snake-client/          → npm "snakewait"
  package.json tsconfig.json bin/snakewait.js
  src/main.ts src/cliArgs.ts
  src/render.ts                 (56x40 half-block arena + 22-col HUD; color tiers; k-scaling)
  src/input-latch.ts            (one-shot dir pulse)
  src/game.ts                   (session glue — bomber's game.ts shape minus bomb)
  src/offline.ts src/share.ts
  src/net.ts src/online.ts
  test/{cliArgs,input-latch,render,share,net,online}.test.ts
plugin/games.json               (add snakewait entry AT RELEASE) [modify]
plugin/test/launcher.test.sh    (four-entry rotation case) [modify]
README.md                       (snake section) [modify]
```

---

### Task 1: snake-core scaffold + state + createMatch (spawns, initial food)

**Files:** Create `packages/snake-core/{package.json,tsconfig.json,src/{index.ts,constants.ts,prng.ts,state.ts,match.ts},test/match.test.ts,test/nodate.test.ts}`.

**Interfaces (Produces):**
```ts
// constants.ts
export const GRID_W = 56, GRID_H = 40
export const TICK_RATE = 20
export const MAX_PLAYERS = 4
export const START_LENGTH = 4
export const SPAWN_INSET = 4
export const FOOD_COUNT = 6
export const GROWTH_PER_FOOD = 2
export const SPEED_SCHEDULE: readonly [number, number][] = [[0, 4], [600, 3], [1200, 2]] // [fromTick, stepTicks]
export const SHRINK_START_TICK = 1800   // 90s
export const SHRINK_INTERVAL_TICKS = 40 // one ring per 2s
// prng.ts
export function mulberry32(seed: number): () => number          // copied from packages/core/src/prng.ts (fragwait-core), source comment
export function randStep(s: number): { value: number; next: number } // PURE mulberry32 single step: same math, state passed explicitly
// state.ts
export type Dir = 'up' | 'down' | 'left' | 'right'
export interface Cellxy { x: number; y: number }
export interface SnakeState {
  id: number; name: string; bot: boolean; alive: boolean
  dir: Dir                    // heading of the last actual move (reverse checks use THIS)
  pendingDir: Dir | null      // applied at the next movement step, then kept as dir
  cells: Cellxy[]             // head FIRST
  growth: number              // pending tail-freeze steps
}
export interface Food { x: number; y: number }
export interface Input { dir: Dir | null }   // null = no change this tick
export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }
export interface MatchState {
  tick: number
  stepCooldown: number        // SHARED — all snakes step simultaneously
  rng: number                 // serializable RNG state for mid-match food spawns
  rings: number               // closed shrink rings (0 = full field)
  snakes: SnakeState[]        // length 4, index = player id
  food: Food[]
  result: Result | null
}
export function idx(x: number, y: number): number                       // y*GRID_W+x
export function isWall(x: number, y: number, rings: number): boolean    // OOB or inside closed rings
export function stepTicksAt(tick: number): number                       // from SPEED_SCHEDULE
// match.ts
export const SPAWNS: { cells: Cellxy[]; dir: Dir }[]  // rotationally symmetric, head first
export function createMatch(seed: number, names: string[], bots: boolean[]): MatchState
```

- [ ] **Step 1:** Scaffold package.json (`"name": "snakewait-core"`, `"version": "0.0.0"`, `"type": "module"`, main/types → dist, zero deps, build script `tsc -p tsconfig.json`) + tsconfig copied from packages/bomber-core (NodeNext, strict). `npm install` (workspaces glob covers it).
- [ ] **Step 2:** Write failing `test/match.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FOOD_COUNT, GRID_H, GRID_W, SPEED_SCHEDULE, START_LENGTH } from '../src/constants.js'
import { idx, isWall, stepTicksAt } from '../src/state.js'
import { createMatch, SPAWNS } from '../src/match.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]

describe('spawns', () => {
  it('are the pinned rotationally-symmetric corner layouts, head first', () => {
    expect(SPAWNS[0]).toEqual({ dir: 'right', cells: [{x:7,y:4},{x:6,y:4},{x:5,y:4},{x:4,y:4}] })
    expect(SPAWNS[1]).toEqual({ dir: 'down',  cells: [{x:51,y:7},{x:51,y:6},{x:51,y:5},{x:51,y:4}] })
    expect(SPAWNS[2]).toEqual({ dir: 'left',  cells: [{x:48,y:35},{x:49,y:35},{x:50,y:35},{x:51,y:35}] })
    expect(SPAWNS[3]).toEqual({ dir: 'up',    cells: [{x:4,y:32},{x:4,y:33},{x:4,y:34},{x:4,y:35}] })
    for (const s of SPAWNS) expect(s.cells).toHaveLength(START_LENGTH)
  })
})

describe('createMatch', () => {
  const s = createMatch(42, NAMES, BOTS)
  it('4 snakes at spawns, alive, growth 0, pendingDir null', () => {
    expect(s.snakes).toHaveLength(4)
    s.snakes.forEach((sn, i) => {
      expect(sn.cells).toEqual(SPAWNS[i]!.cells)
      expect(sn.dir).toBe(SPAWNS[i]!.dir)
      expect(sn).toMatchObject({ id: i, name: NAMES[i], bot: BOTS[i], alive: true, growth: 0, pendingDir: null })
    })
  })
  it('FOOD_COUNT food on empty non-snake cells, deterministic per seed', () => {
    expect(s.food).toHaveLength(FOOD_COUNT)
    const occupied = new Set(s.snakes.flatMap((sn) => sn.cells.map((c) => idx(c.x, c.y))))
    for (const f of s.food) {
      expect(f.x).toBeGreaterThanOrEqual(0); expect(f.x).toBeLessThan(GRID_W)
      expect(f.y).toBeGreaterThanOrEqual(0); expect(f.y).toBeLessThan(GRID_H)
      expect(occupied.has(idx(f.x, f.y))).toBe(false)
    }
    expect(new Set(s.food.map((f) => idx(f.x, f.y))).size).toBe(FOOD_COUNT) // no stacking
    expect(createMatch(42, NAMES, BOTS)).toEqual(s)                          // deterministic
    expect(createMatch(43, NAMES, BOTS).food).not.toEqual(s.food)            // seed matters
  })
  it('tick 0, rings 0, no result, cooldown = stepTicksAt(0)', () => {
    expect(s).toMatchObject({ tick: 0, rings: 0, result: null, stepCooldown: stepTicksAt(0) })
  })
})

describe('helpers', () => {
  it('stepTicksAt follows SPEED_SCHEDULE', () => {
    expect(stepTicksAt(0)).toBe(4); expect(stepTicksAt(599)).toBe(4)
    expect(stepTicksAt(600)).toBe(3); expect(stepTicksAt(1200)).toBe(2); expect(stepTicksAt(9999)).toBe(2)
    expect(SPEED_SCHEDULE[0]![0]).toBe(0)
  })
  it('isWall: OOB always; interior cells close as rings advance', () => {
    expect(isWall(-1, 5, 0)).toBe(true); expect(isWall(0, 0, 0)).toBe(false)
    expect(isWall(0, 0, 1)).toBe(true); expect(isWall(1, 1, 1)).toBe(false)
    expect(isWall(55, 39, 1)).toBe(true); expect(isWall(54, 38, 1)).toBe(false)
  })
})
```

- [ ] **Step 3:** Run `npx vitest run packages/snake-core` → FAIL (modules missing).
- [ ] **Step 4:** Implement constants/prng/state/match per the Interfaces block. `randStep` is mulberry32's body with the counter passed in/out: `next = (s + 0x6D2B79F5) | 0` then the same scramble on `next` for `value` in [0,1). createMatch: seed the `rng` field via `(mulberry32(seed)() * 2**32) >>> 0`, then place FOOD_COUNT items by repeated `randStep` picks over `x = floor(value*GRID_W)`, `y` likewise, re-rolling on any collision with snakes or existing food. index.ts re-exports everything in the Interfaces block.
- [ ] **Step 5:** Also write `test/nodate.test.ts` — the determinism grep (mirrors boomwait's):

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
describe('core determinism', () => {
  it('no Date.now / Math.random anywhere in src', () => {
    const files = readdirSync('packages/snake-core/src').filter((f) => f.endsWith('.ts'))
    for (const f of files) {
      const text = readFileSync(`packages/snake-core/src/${f}`, 'utf8')
      expect(text, f).not.toMatch(/Date\.now|Math\.random/)
    }
  })
})
```

- [ ] **Step 6:** Run → PASS; full `npm test` green. Ledger + commit `feat(snake-core): scaffold, state, spawns, seeded createMatch`.

---

### Task 2: step() — movement, collisions, food, growth, corpse-food

**Files:** Create `packages/snake-core/src/step.ts`, `packages/snake-core/test/step.test.ts`. Modify `src/index.ts` (export step).

**Interfaces (Consumes):** Task 1's state/constants. **Produces:** `export function step(state: MatchState, inputs: (Input | null)[]): MatchState` — pure, never mutates its arguments.

Per-tick order (spec's phases, restated exactly):
1. **Inputs (every tick):** for each alive snake, if `inputs[i]?.dir` is non-null AND is not the 180° reverse of `snake.dir` (the LAST ACTUALLY MOVED heading, not pendingDir), set `pendingDir` to it. `inputs[i]` null or `{dir:null}` are identical: no change (pendingDir persists — snake never stops).
2. **Cooldown:** `stepCooldown - 1`; if still > 0, only tick/shrink/result phases run (skip 3-6). If it reaches 0, a movement step fires and cooldown resets to `stepTicksAt(newTick)`.
3. **Movement step:** each alive snake's next head = current head + (pendingDir ?? dir); the moved heading becomes `dir` and `pendingDir` resets to null.
4. **Tails vacate:** snakes with `growth > 0` decrement growth and keep their tail; others drop the last cell. Occupancy for collision = all remaining body cells of ALL alive snakes (after vacate, before heads land).
5. **Deaths (simultaneous):** next head hits `isWall(x,y,rings)`; OR occupancy; OR two+ heads target the same cell (all involved die); OR head-swap (a's next head === b's current head AND b's next head === a's current head — both die). Survivors' heads are prepended.
6. **Food:** surviving head on a food cell → remove that food, `growth += GROWTH_PER_FOOD`, respawn one food via `randStep` re-roll over empty cells (not wall, not snake, not food); if 200 re-rolls fail (field effectively full), skip silently. Ties (two survivors CAN'T share a cell — same-cell died in 5).
7. **Corpse-food:** each snake that died THIS tick converts even-indexed cells (0, 2, 4… from head) into food, skipping cells that are walls or already food; corpse removed (`cells: []`).
8. **Result stamp (set once):** alive count 0 → draw; 1 → win by that id; else null carries.

- [ ] **Step 1:** Write failing `test/step.test.ts`. Use helpers to build minimal states (spread from `createMatch(42,…)` and overwrite `snakes`/`food` — trajectory tests must control geometry, the boomwait clearArena lesson):

```ts
import { describe, expect, it } from 'vitest'
import { GROWTH_PER_FOOD, GRID_W } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState, SnakeState } from '../src/state.js'

const NAMES = ['a','b','c','d'], BOTS = [false,true,true,true]
const NONE: (Input|null)[] = [null,null,null,null]
const snake = (id: number, cells: {x:number;y:number}[], dir: SnakeState['dir'], over: Partial<SnakeState> = {}): SnakeState =>
  ({ id, name: NAMES[id]!, bot: BOTS[id]!, alive: true, dir, pendingDir: null, cells, growth: 0, ...over })
const base = (over: Partial<MatchState>): MatchState => ({ ...createMatch(42, NAMES, BOTS), food: [], ...over })
const run = (s: MatchState, inputs: (Input|null)[], n: number) => { for (let k=0;k<n;k++) s = step(s, k===0?inputs:NONE); return s }

describe('movement', () => {
  it('a snake advances one cell per stepTicksAt(0)=4 ticks, tail follows', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10},{x:7,y:10}],'right'), ...deadRest()] })
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 11, y: 10 })
    expect(s.snakes[0]!.cells).toHaveLength(4)
  })
  it('pendingDir applies at the step then clears; reverse input is rejected', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10},{x:7,y:10}],'right'), ...deadRest()] })
    s = step(s, [{dir:'left'},null,null,null])   // reverse of heading right → ignored
    expect(s.snakes[0]!.pendingDir).toBeNull()
    s = step(s, [{dir:'up'},null,null,null])     // perpendicular → pending
    expect(s.snakes[0]!.pendingDir).toBe('up')
    s = run(s, NONE, 2)                          // completes the 4-tick step window
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 10, y: 9 })
    expect(s.snakes[0]!.dir).toBe('up'); expect(s.snakes[0]!.pendingDir).toBeNull()
  })
  it('moving into a cell a tail vacates this same step is legal', () => {
    // 2x2 loop: snake of length 4 turning in a square survives forever
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:9,y:11},{x:10,y:11}],'right'), ...deadRest()] })
    s = run(s, [{dir:'down'},null,null,null], 4)
    expect(s.snakes[0]!.alive).toBe(true)
    expect(s.snakes[0]!.cells[0]).toEqual({ x: 10, y: 11 }) // entered the cell its own tail left
  })
})

describe('deaths', () => {
  it('wall kills; body kills; two heads to one cell both die; head-swap both die', () => {
    let w = base({ snakes: [snake(0,[{x:0,y:10},{x:1,y:10}],'left'), ...deadRest()] })
    expect(run(w, NONE, 4).snakes[0]!.alive).toBe(false)
    let hh = base({ snakes: [
      snake(0,[{x:10,y:10},{x:9,y:10}],'right'), snake(1,[{x:12,y:10},{x:13,y:10}],'left'),
      snake(2,[{x:30,y:30},{x:29,y:30}],'right',{alive:false,cells:[]}), snake(3,[{x:40,y:30},{x:39,y:30}],'right',{alive:false,cells:[]})] })
    hh = run(hh, NONE, 4) // both target (11,10)
    expect(hh.snakes[0]!.alive).toBe(false); expect(hh.snakes[1]!.alive).toBe(false)
    expect(hh.result).toEqual({ kind: 'draw' })
    let sw = base({ snakes: [
      snake(0,[{x:10,y:10},{x:9,y:10}],'right'), snake(1,[{x:11,y:10},{x:12,y:10}],'left'),
      snake(2,[{x:30,y:30},{x:29,y:30}],'right',{alive:false,cells:[]}), snake(3,[{x:40,y:30},{x:39,y:30}],'right',{alive:false,cells:[]})] })
    sw = run(sw, NONE, 4) // adjacent heads moving through each other
    expect(sw.snakes[0]!.alive).toBe(false); expect(sw.snakes[1]!.alive).toBe(false)
  })
})

describe('food', () => {
  it('eating grows by GROWTH_PER_FOOD (tail frozen) and respawns one food deterministically', () => {
    let s = base({ snakes: [snake(0,[{x:10,y:10},{x:9,y:10},{x:8,y:10}],'right'), ...deadRest()], food: [{x:11,y:10}] })
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.growth).toBe(GROWTH_PER_FOOD)
    expect(s.food).toHaveLength(1)                    // respawned elsewhere
    expect(s.food[0]).not.toEqual({ x: 11, y: 10 })
    const len = s.snakes[0]!.cells.length
    s = run(s, NONE, 8)                               // two more steps: tail frozen twice
    expect(s.snakes[0]!.cells.length).toBe(len + 2)
    expect(s.snakes[0]!.growth).toBe(0)
  })
  it('a dead snake decays into food at even-indexed cells', () => {
    let s = base({ snakes: [snake(0,[{x:1,y:10},{x:2,y:10},{x:3,y:10},{x:4,y:10},{x:5,y:10}],'left'), ...deadRest()] })
    s = run(s, NONE, 4)                               // head hits x=0… wait, x=0 is open; heads to x=0 fine; next step x=-1 dies
    s = run(s, NONE, 4)
    expect(s.snakes[0]!.alive).toBe(false)
    expect(s.snakes[0]!.cells).toEqual([])
    const foodIdx = new Set(s.food.map((f) => `${f.x},${f.y}`))
    expect(foodIdx.has('0,10')).toBe(true)            // index 0 (head at death)
    expect(foodIdx.has('2,10')).toBe(true)            // index 2
    expect(foodIdx.has('1,10')).toBe(false)           // odd index skipped
  })
})

describe('purity', () => {
  it('step never mutates its input state', () => {
    const s0 = createMatch(42, NAMES, BOTS)
    const snap = JSON.stringify(s0)
    step(s0, [{dir:'down'},null,null,null])
    expect(JSON.stringify(s0)).toBe(snap)
  })
})

function deadRest() {
  return [1,2,3].map((id) => snake(id, [], 'right', { alive: false, cells: [] }))
}
```

(Note the corpse test's geometry: head starts at (1,10) heading left; first step reaches x=0 legally, second step targets x=-1 → wall death with body [(0,10),(1,10),(2,10),(3,10),(4,10)] at death → food at indices 0,2,4. If your death-tick body disagrees, fix the TEST COORDS with the reasoning stated in the test — the semantics above are the pin, exact cells follow from them.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement step.ts per the 8-phase order. **Step 4:** Run → PASS, full suite green. **Step 5:** Ledger + commit `feat(snake-core): step() — movement, collisions, food, corpse decay`.

---

### Task 3: sudden-death shrink + result integration

**Files:** Modify `packages/snake-core/src/step.ts` (shrink phase). Create `packages/snake-core/test/shrink.test.ts`.

**Interfaces (Consumes):** step(), isWall, SHRINK_* constants. **Produces:** shrink behavior inside step(): from `SHRINK_START_TICK`, every `SHRINK_INTERVAL_TICKS`, `rings + 1`; any snake with ANY cell in the newly closed ring dies entirely (then decays to corpse-food per Task 2's rule, but only cells NOT in closed rings become food); food inside the ring is destroyed. Shrink runs AFTER movement/deaths, BEFORE the result stamp (shrink kills count this tick). `min(GRID_W,GRID_H)/2 = 20` rings max; when every cell is closed all remaining snakes die (guaranteed end by tick 1800+20*40 = 2600).

- [ ] **Step 1:** Write failing `test/shrink.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SHRINK_INTERVAL_TICKS, SHRINK_START_TICK } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState } from '../src/state.js'

const NAMES = ['a','b','c','d'], BOTS = [false,true,true,true]
// loops must be DRIVEN (see loopInputs below) — all-null inputs would run every snake straight into a wall
const advanceTo = (s: MatchState, tick: number) => { while (s.tick < tick) s = step(s, loopInputs(s)); return s }

describe('sudden death', () => {
  it('rings stays 0 before SHRINK_START_TICK, then advances every interval', () => {
    // park all snakes safely in the middle as 2x2 loops so they never die (see Task 2 loop test)
    let s = midLoopState()
    s = advanceTo(s, SHRINK_START_TICK - 1); expect(s.rings).toBe(0)
    s = step(s, loopInputs(s));               expect(s.rings).toBe(1)
    s = advanceTo(s, SHRINK_START_TICK + SHRINK_INTERVAL_TICKS); expect(s.rings).toBe(2)
  })
  it('a snake with any cell in the closing ring dies; its safe cells become food; ring food destroyed', () => {
    let s = midLoopState()
    // move snake 0's loop to hug the border: cells include (0,10) — dies when ring 1 closes
    s.snakes[0] = { ...s.snakes[0]!, cells: [{x:0,y:10},{x:1,y:10},{x:1,y:11},{x:0,y:11}] }
    s.food = [{ x: 0, y: 20 }]                     // in ring 1: destroyed
    s = advanceTo(s, SHRINK_START_TICK)
    expect(s.rings).toBe(1)
    expect(s.snakes[0]!.alive).toBe(false)
    expect(s.food.some((f) => f.x === 0)).toBe(false)          // nothing on the closed ring
    expect(s.food.some((f) => f.x === 1 && f.y === 10)).toBe(true) // even-index corpse cell inside safe area
  })
  it('the match is guaranteed decided by tick 2600', () => {
    let s = midLoopState()
    s = advanceTo(s, 2600)
    expect(s.result).not.toBeNull()
  })
})

// Four 2x2 self-loops parked far apart mid-field. A length-4 snake in a 2x2 block that turns
// CLOCKWISE every step cycles that block forever (each move enters the cell its own tail
// vacates — legal per Task 2), so loops survive until shrink reaches them. Drive them by
// feeding each alive snake the clockwise turn of its current heading every tick (extra inputs
// on non-step ticks are harmless — pendingDir just gets re-set to the same value):
const CW = { up: 'right', right: 'down', down: 'left', left: 'up' } as const
function loopInputs(s: MatchState): (Input | null)[] {
  return s.snakes.map((sn) => (sn.alive ? { dir: CW[sn.dir] } : null))
}
function midLoopState(): MatchState {
  const base = createMatch(7, NAMES, BOTS)
  const block = (id: number, x: number, y: number) => ({
    ...base.snakes[id]!,
    dir: 'right' as const,
    cells: [{x:x+1,y},{x,y},{x,y:y+1},{x:x+1,y:y+1}], // head (x+1,y) heading right; CW turn = down
  })
  return { ...base, food: [], snakes: [block(0,20,18), block(1,34,18), block(2,20,26), block(3,34,26)] }
}
```

and `advanceTo` uses `loopInputs` instead of all-null inputs: `while (s.tick < tick) s = step(s, loopInputs(s))`. The ASSERTIONS are the pins; if a loop coordinate collides with your shrink geometry, adjust the parking spots with the reasoning stated in the test.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the shrink phase in step.ts. **Step 4:** Run → PASS, suite green. **Step 5:** Ledger + commit `feat(snake-core): sudden-death ring shrink + guaranteed end`.

---

### Task 4: golden master

**Files:** Create `packages/snake-core/test/golden.test.ts`.

**Interfaces (Consumes):** createMatch, step. Bots are NOT in this path (the boomwait pattern — golden pins the sim, bots evolve separately).

- [ ] **Step 1:** Write the test with a placeholder hash:

```ts
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
  expect(fnv1a(JSON.stringify(s))).toBe('RECORD_ME') // record from an actual green run; re-record + note why on intended changes
})
```

- [ ] **Step 2:** Run → FAIL with the actual hash printed in the assertion diff. **Step 3:** Pin the printed hash (this is a RECORDING, not an oracle — note that in the commit). **Step 4:** Run twice → PASS both (stability). Suite green. **Step 5:** Ledger + commit `test(snake-core): golden master pinned`.

---

### Task 5: bots — BFS food-seek + flood-fill survival

**Files:** Create `packages/snake-core/src/bot.ts`, `packages/snake-core/test/bot.test.ts`. Modify `src/index.ts` (export bot API).

**Interfaces (Consumes):** MatchState, step (tests only). **Produces:**
```ts
export type Difficulty = 'easy' | 'normal' | 'hard'
export interface BotMind { rng: () => number; nextDecisionTick: number }
export function createBotMind(seed: number): BotMind
export function botDecide(state: MatchState, id: number, mind: BotMind, d: Difficulty): Input
// CADENCE: easy 10 / normal 5 / hard 3 ticks; EASY_MISTAKE_RATE = 0.15
```
Between decision ticks botDecide returns `{ dir: null }` (no change — the sim's pendingDir persists; snakes never stop, so bots need no remembered heading — the boomwait 0.1.2 lesson does NOT recur here).

Decision logic (each decision tick):
1. Blocked-set = every snake body cell + `isWall(…, rings)` cells. If shrink is ≤ 2 intervals away (`tick ≥ SHRINK_START_TICK - 2*SHRINK_INTERVAL_TICKS`), also treat the NEXT ring as blocked (bots pre-evacuate).
2. Candidate dirs = the 3 non-reverse dirs from the current heading; drop any whose next-head cell is blocked.
3. SURVIVAL CHECK per candidate: flood fill free cells from the candidate next-head (4-connected, blocked-set excluded); reject if reachable count < own body length. `easy` skips this check on 15% of decisions (`mind.rng() < 0.15`).
4. `hard` only: also reject candidates adjacent (4-neighborhood) to the head of an alive opponent whose length ≥ own (head-to-head is death).
5. BFS from own head over unblocked cells to the nearest food; if the BFS first-hop direction survived steps 2-4, return it.
6. Fallback: the surviving candidate with the largest flood-fill space; if none survived, the unblocked candidate with the largest space; if every dir is blocked, `{ dir: null }` (ride it out).

- [ ] **Step 1:** Write failing `test/bot.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createBotMind, botDecide, type Difficulty } from '../src/bot.js'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { Input, MatchState } from '../src/state.js'

const NAMES = ['a','b','c','d']

function allBotSim(seed: number, d: Difficulty, untilTick: number): MatchState {
  let s = createMatch(seed, NAMES, [true, true, true, true])
  const minds = [0,1,2,3].map((i) => createBotMind((seed + i) >>> 0))
  while (s.tick < untilTick && !s.result) {
    s = step(s, [0,1,2,3].map((i) => botDecide(s, i, minds[i]!, d)) as (Input|null)[])
  }
  return s
}

describe('bot gates (the boomwait 0.1.1 lesson — from day one)', () => {
  for (const d of ['easy','normal','hard'] as Difficulty[]) {
    it(`${d}: across 20 seeds no all-dead-by-100 and ≥2 alive at tick 200`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const s100 = allBotSim(seed, d, 100)
        expect(s100.snakes.filter((x) => x.alive).length, `seed ${seed} @100`).toBeGreaterThan(0)
        const s200 = allBotSim(seed, d, 200)
        expect(s200.snakes.filter((x) => x.alive).length, `seed ${seed} @200`).toBeGreaterThanOrEqual(2)
      }
    })
  }
  it('bots actually eat: median max-length at tick 400 exceeds START_LENGTH (normal, 20 seeds)', () => {
    const maxLens: number[] = []
    for (let seed = 1; seed <= 20; seed++) {
      const s = allBotSim(seed, 'normal', 400)
      maxLens.push(Math.max(...s.snakes.map((x) => x.cells.length))) // dead snakes read 0 (cells cleared)
    }
    maxLens.sort((a, b) => a - b)
    expect(maxLens[10]!).toBeGreaterThan(4)
  })
  it('a bot never picks an immediately-lethal direction when a safe one exists (deterministic fixture)', () => {
    // bot 0 heading right at (10,10); opponent body forms a solid column at x=11 spanning
    // y=6..14, so 'right' is death and up/down are open — the decision must turn.
    const base = createMatch(1, NAMES, [true, true, true, true])
    const col = Array.from({ length: 9 }, (_, i) => ({ x: 11, y: 6 + i }))
    const s: MatchState = { ...base, food: [{ x: 30, y: 30 }], snakes: [
      { ...base.snakes[0]!, dir: 'right', pendingDir: null, cells: [{x:10,y:10},{x:9,y:10},{x:8,y:10}] },
      { ...base.snakes[1]!, dir: 'down',  pendingDir: null, cells: col },
      { ...base.snakes[2]!, alive: false, cells: [] },
      { ...base.snakes[3]!, alive: false, cells: [] },
    ] }
    const out = botDecide(s, 0, createBotMind(1), 'normal')
    expect(out.dir === 'up' || out.dir === 'down').toBe(true)
  })
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement bot.ts. **Step 4:** Run → PASS (if a gate fails, the BOT is wrong — fix the bot, never loosen the gate; boomwait's ledger documents why). Golden hash UNCHANGED (bots aren't in it). Suite green. **Step 5:** Ledger + commit `feat(snake-core): bots — BFS food-seek with flood-fill survival + liveness gates`.

---

### Task 6: wire protocol — RLE codec, caps, parsers

**Files:** Create `packages/snake-core/src/protocol.ts`, `packages/snake-core/test/protocol.test.ts`. Modify `src/index.ts`.

**Interfaces (Produces):**
```ts
export const MAX_RAW = 4096
export interface HelloMsg { t: 'hello'; name: string }
export interface InputMsg { t: 'input'; dir: 'up'|'down'|'left'|'right' }   // sent only on change; no null/keep
export interface StartMsg { t: 'start'; you: number; seed: number; names: string[]; bots: boolean[] }
export interface SnapMsg { t: 'snap'; state: WireState }
export interface EndMsg { t: 'end'; result: [0, number] | [1] }             // [0,winner] | [1]=draw
export type SnakeClientMsg = HelloMsg | InputMsg
export type SnakeServerMsg = StartMsg | SnapMsg | EndMsg
// dirCode: 1=up 2=down 3=left 4=right; 0 = pendingDir null
export type WireSnake = [number, string, number, number, number, number, number, number, number, [number, number][]]
//                      [id,  name,  bot, alive, dirCode, pendCode, growth, headX, headY, segments(dirCode,count) head→tail]
export interface WireState { tick: number; cd: number; rng: number; rings: number
  food: [number, number][]; snakes: WireSnake[]; result: [0, number] | [1] | null }
export function sanitizeHandle(raw: string): string   // copy boomwait's rules verbatim (read packages/bomber-core/src/protocol.ts)
export function toWire(s: MatchState): WireState
export function fromWire(w: WireState): MatchState
export function parseSnakeClientMsg(raw: unknown): SnakeClientMsg | null   // size cap + shape checks, null on ANY violation
export function parseSnakeServerMsg(raw: unknown): SnakeServerMsg | null
```
RLE: body cells after the head encoded as (dirCode, count) segments walking HEAD → TAIL (each segment's dir points from a cell to the NEXT cell toward the tail). fromWire reconstructs by walking from the head. Parser hardening (the boomwait Task 7 lesson): coordinates capped to grid bounds, counts capped to GRID_W*GRID_H, string fields length-capped, anything malformed → null, and NO literal control bytes in the test file (escape sequences only — a binary test file broke git review once).

- [ ] **Step 1:** Write failing `test/protocol.test.ts` covering: round-trip `fromWire(toWire(s))` equals s for a mid-match state (createMatch stepped 100 ticks with scripted turns — reuse Task 4's SCRIPT shape); a straight snake of length 10 encodes as ONE segment `[dirCode, 9]`; snapshot size pin — a worst case with 4 fully-twisty snakes of length 60 (staircase pattern) + 40 food serializes under 2048 bytes (`JSON.stringify(toWire(worst)).length < 2048`); parser rejects: oversized raw (> MAX_RAW), `dir: 'diagonal'`, coords 999999999, segment count 10^9, non-JSON garbage `'\x00\x01'`, valid-JSON-wrong-shape.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(snake-core): wire protocol — RLE codec + hardened parsers`.

---

### Task 7: server DOs (existing worker) + wrangler migration v4

**Files:** Create `packages/server/src/snake-lobby.ts`, `packages/server/src/snake-match.ts`, `packages/server/test/snake.test.ts`. Modify `packages/server/src/index.ts` (routes + DO exports), `packages/server/wrangler.jsonc` (bindings `SNAKE_LOBBY`, `SNAKE_MATCH` + APPENDED migration `{ "tag": "v4", "new_sqlite_classes": ["SnakeLobbyDO", "SnakeMatchDO"] }` — v1/v2/v3 untouched), `packages/server/package.json` (add `"snakewait-core": "0.0.0"` workspace dep — pinned to the real version at release).

**Interfaces (Consumes):** snakewait-core Tasks 1-6 (createMatch, step, botDecide, protocol). **Produces:** `POST /snake/join {name}` → `{ matchId, token }` after the ~10s gather window (bots backfill to 4 — never a no-opponent outcome); `GET /snake/match/:id/ws?token=` (WebSocket). `export function parseSnakeMatchId(pathname: string): string | null`.

- [ ] **Step 1:** Read `packages/server/src/{bomber-lobby.ts,bomber-match.ts}` and `packages/server/test/bomber.test.ts` FIRST — snake follows those shapes near-verbatim: gather window, monotonic connId + start-time slot compaction (the pre-start id-churn lesson), start-deadline bot backfill (the socket-no-show hang lesson), 50ms alarm tick, 5s disconnect grace (grace expiry = that snake dies in-sim and decays to food via the normal step rules — kill it by marking dead + corpse conversion through a synthetic wall... NO: simplest correct mechanism is a `killSnake(state, id)` helper exported from snake-core's step.ts that applies the Task 2 corpse rule directly; add it in THIS task with a core unit test), one-shot input latch per slot (dir consumed into exactly one step() call then cleared — pendingDir persists in-sim so once is enough), 'empty' stop, tombstone after end.
- [ ] **Step 2:** Failing tests (mirror bomber.test.ts's structure): 4 joiners fill → humanCount 4; 1 human after window → 3 bots (difficulty 'normal' for backfill); an InputMsg turns that slot's snake (position assertion after a step, not dirCode — the boomwait tap-to-step test lesson); garbage/oversized messages dropped without crashing; disconnect → grace → snake dead and converted to food; wrangler.jsonc literal test — tags v1, v2, v3, v4 in order.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement (SnakeLobbyDO via the bomber lobby queue shape; SnakeMatchHost pure class + SnakeMatchDO wrapper; index.ts routes under `/snake/...` exactly like `/bomber/...`). **Step 5:** PASS, full suite green, `npx tsc -p packages/server/tsconfig.json --noEmit` clean. NO DEPLOY — user-gated at release. Ledger + commit `feat(server): snake lobby + match DOs, migration v4`.

---

### Task 8: client scaffold + renderer (frame-fit FIRST)

**Files:** Create `packages/snake-client/{package.json,tsconfig.json,bin/snakewait.js,src/{index.ts stub not needed — this is an app},src/render.ts},test/render.test.ts`.

**Interfaces (Consumes):** snakewait-core state/constants, termwait `ColorMode`. **Produces:**
```ts
// render.ts
export interface Layout { k: number; cols: number; rows: number }  // k = integer pixel scale
export function chooseLayout(cols: number, rows: number): Layout | null  // null = window too small (< 80x24)
export function renderFrame(state: MatchState, you: number, layout: Layout, statusLine: string, mode: ColorMode): string
export function tooSmallScreen(cols: number, rows: number): string  // centered "snakewait needs 80x24" message
```
package.json: `"name": "snakewait"`, `"version": "0.0.0"`, `"bin": {"snakewait": "bin/snakewait.js"}`, deps `{"snakewait-core": "0.0.0", "termwait": "0.1.0", "ws": "8.21.0"}` (workspace core pin fixed at release). bin file: `#!/usr/bin/env node` + `import('../dist/cli.js')` (cli.ts arrives Task 9 — the bin file existing early is harmless).

Rendering rules (spec, restated): arena 56x40 logical cells, 1 cell = 1 half-block pixel at k=1 → 56 cols × 20 char rows; +1-char border all around (58×22); right HUD pads to exactly 80 cols; + 1 status row = 23 lines total. `chooseLayout` returns k=2 only when cols ≥ 114 AND rows ≥ 43, else k=1 when ≥ 80x24, else null. Colors: snakes RGB `[ [80,250,120], [255,95,135], [95,175,255], [255,215,95] ]` (truecolor), nearest xterm-256 indices for '256', ANSI 32/31/34/33 for 'basic'; head = the same hue brightened (+60 per channel clamped, bold in basic); food = dim white dot `·` colorable; closed rings = the border color. 'mono' → glyph mode: body `o x + #` per snake id, head uppercase `O X * @`, food `.`, walls `█`. Half-block compositing: per char cell take pixel pair (y*2, y*2+1) → `▀` fg=top/bg=bottom (space when both empty — terminal default bg).

HUD (22 cols, right of the border): line per player — 2-char swatch, name (8 chars, sanitized), length right-aligned, `†` when dead; blank; clock `mm:ss` from `tick/TICK_RATE`; speed row `spd N/s`; from tick 1500: `walls close in Ns!` countdown; bottom: `wasd/arrows steer · esc quit`. Status line (row 24) comes in as a parameter.

- [ ] **Step 1:** Write the FRAME-FIT test before any rendering code:

```ts
import { describe, expect, it } from 'vitest'
import { createMatch } from 'snakewait-core'
import { chooseLayout, renderFrame } from '../src/render.js'

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  it('exact fit at 80x24: k=1, every line ≤ 80 visible cols, ≤ 23 rows', () => {
    const layout = chooseLayout(80, 24)!
    expect(layout.k).toBe(1)
    const s = createMatch(7, ['jeremiah','bot·1','bot·2','bot·3'], [false,true,true,true])
    const frame = renderFrame(s, 0, layout, 'claude is working…', 'truecolor')
    const lines = frame.split('\n')
    expect(lines.length).toBeLessThanOrEqual(23)
    for (const line of lines) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
      expect(visible.length, JSON.stringify(visible)).toBeLessThanOrEqual(80)
    }
    expect(lines.some((l) => l.includes('jeremiah'))).toBe(true)
  })
  it('window below 80x24 → null layout', () => {
    expect(chooseLayout(79, 24)).toBeNull()
    expect(chooseLayout(80, 23)).toBeNull()
  })
  it('k=2 only at 114x43+', () => {
    expect(chooseLayout(114, 43)!.k).toBe(2)
    expect(chooseLayout(113, 43)!.k).toBe(1)
  })
})
```

Additional render tests in the same file: mono mode contains NO escape sequences and uses the glyph set; 256 mode contains `38;5;` and never `38;2;`; a dead snake's corpse-food renders as food; closed rings paint wall color at ring cells.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement render.ts (read `packages/bomber-client/src/render.ts` first for the half-block compositing + ColorMode threading patterns; snake's is SIMPLER — no sprites, one pixel per cell). **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(snakewait): renderer with asserted 80x24 frame`.

---

### Task 9: input + session glue + offline loop + CLI (playable offline milestone)

**Files:** Create `packages/snake-client/src/{input-latch.ts,game.ts,offline.ts,share.ts,cliArgs.ts,cli.ts,main.ts}`, `packages/snake-client/test/{input-latch.test.ts,cliArgs.test.ts,share.test.ts}`.

**Interfaces (Consumes):** Task 8 render, snakewait-core (createMatch/step/botDecide/TICK_RATE), termwait everything. **Produces:**
```ts
// input-latch.ts — one-shot dir pulse; NO reverse/hold logic (the sim owns the reverse rule)
export interface LatchState { dir: Dir | null }
export function createLatch(): LatchState
export function onKey(l: LatchState, e: KeyEvent): LatchState  // press/repeat of wasd/arrows sets dir (latest wins); release ignored
export function drain(l: LatchState): { input: Input; next: LatchState }  // returns {dir}, next.dir = null
// game.ts — copy bomber's game.ts shape (read packages/bomber-client/src/game.ts) minus the bomb flag:
export const REDRAW_MS = 1000 / TICK_RATE
export interface GameSession { term; parser; colorMode; listener; layout(): Layout | null; drainInput(): Input; statusLine(): string; quitRequested(): boolean; onResize(cb: () => void): void; dispose(): void }
export async function setupGame(): Promise<GameSession>
export function resultLine(result: Result, you: number): string       // "you won!" / "<name> won" / "draw"
export async function teardownAndExit(opts): Promise<Result | null>   // bomber's contract verbatim
// offline.ts
export async function runOffline(opts: { difficulty: Difficulty; name: string; seed: number }): Promise<Result>
// share.ts
export function shareCard(result: Result, you: number, tick: number, finalLength: number, opponentHandle: string): string
// cliArgs.ts — copy bomber's parseArgs surface (read packages/bomber-client/src/cliArgs.ts):
export const DEFAULT_SERVER = 'https://fragwait-server.agthe7.workers.dev'
export interface CliOpts { offline: boolean; name?: string; server: string; seed?: number; difficulty: Difficulty }
export function parseArgs(argv: string[]): CliOpts
```
offline loop = bomber's offline.ts shape: 50ms interval, `step(state, [drained, botDecide×3])`, minds seeded `(seed + id) >>> 0`, quit/result exits, finale screen + share card through teardownAndExit. A quiet tick passes `{ dir: null }` — NO absent-input distinction (pendingDir persists in-sim; the bomber 0.1.2 buffering subtlety does not apply). `layout() === null` → render `tooSmallScreen` and keep polling for resize. cli.ts wires parseArgs → runOffline (online arrives Task 10 — until then non-offline args ALSO run offline with a printed note, so the package is runnable at this milestone).

- [ ] **Step 1:** Failing tests: input-latch (press sets dir incl. arrows; latest-wins on two presses same tick; repeat same as press; release ignored; drain clears), cliArgs (defaults, `--offline`, `--name x`, `--seed 9`, `--server url`, unknown flag → usage error), share (contains outcome word, `m:ss` duration, final length, opponent handle; ≤ 280 chars).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (game.ts/offline.ts largely transcribed from bomber's with bomb removed and Input narrowed — read those files first; they encode the TDZ-hoisting, resize, and teardown lessons). **Step 4:** PASS, suite green, `npm run build -w snakewait` clean. **Step 5:** Ledger + commit `feat(snakewait): offline game vs bots — input, session glue, CLI`.

---

### Task 10: net + online loop

**Files:** Create `packages/snake-client/src/{net.ts,online.ts}`, `packages/snake-client/test/{net.test.ts,online.test.ts}`. Modify `src/cli.ts` (default path = online with offline fallback).

**Interfaces (Consumes):** protocol (Task 6), game.ts session glue (Task 9). **Produces:**
```ts
// net.ts — bomber's net.ts shape (read packages/bomber-client/src/net.ts): factory seam for ws, join POST, connect-resolves-on-start
export type JoinOutcome = { kind: 'joined'; matchId: string; token: string } | { kind: 'error' }
export async function joinSnakeMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome>  // POST /snake/join
export class SnakeNetClient { static connect(serverUrl, matchId, token, name, handlers, timeoutMs?, factory?): Promise<{ client; start: StartMsg }>; sendInput(msg: InputMsg): void; close(): void }
export function diffInputForWire(prevDir: Dir | null, input: Input): { msg: InputMsg | null; nextDir: Dir | null }  // send only on CHANGE to a non-null dir
// online.ts
export async function runOnline(opts: { name?: string; server: string }): Promise<Result | 'fallback'>
```
online.ts transcribes bomber's online.ts including its hard-won specifics: `let state` hoisted ABOVE connect (the coalesced start+snap TDZ crash), snaps replace state outright via fromWire, result precedence `end ?? state.result ?? closedEarly-synthesized-loss`, quit sends nothing (socket close IS elimination, server grace covers drops). cli.ts: no `--offline` → join online, any join/connect failure → offline fallback with a printed note.

- [ ] **Step 1:** Failing tests with a fake ws factory (mirror bomber's net/online tests): join ok/non-2xx/timeout → outcomes; connect resolves on start and rejects on pre-start close; snap → handler; diffInputForWire sends on change only and never sends null; online returns 'fallback' on join error.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(snakewait): online play — lobby join, ws match, offline fallback`.

---

### Task 11: plugin + README

**Files:** Modify `plugin/test/launcher.test.sh` (a FOUR-entry games.json fixture rotation case — games.json itself is NOT touched until release), `README.md` (snakewait section following the boomwait section's format).

- [ ] **Step 1:** Extend the launcher test with a temp four-entry fixture asserting rotation order and `npx -y snakewait@X.Y.Z` command passthrough; run STANDALONE `bash plugin/test/launcher.test.sh` (~30s bound) → PASS.
- [ ] **Step 2:** README: one section — what it is, controls, `npx -y snakewait` / `--offline`, the 80x24 note.
- [ ] **Step 3:** Full suite green. Ledger + commit `chore(plugin): launcher 4-game rotation test + snakewait README`.

---

### Task 12: release — USER-GATED (STOP and hand commands to the user)

**Files:** Modify `packages/snake-core/package.json` + `packages/snake-client/package.json` (0.1.0, exact pins), `packages/server/package.json` (snakewait-core pin), `plugin/games.json` (add entry `{"id":"snakewait","title":"snakewait — terminal snake battle","cmd":"npx -y snakewait@0.1.0"}`), `plugin/.claude-plugin/plugin.json` (version bump), lockfile.

- [ ] **Step 1:** Re-verify `npm view snakewait` / `snakewait-core` → still E404. Full suite green; builds clean.
- [ ] **Step 2:** Version pins: snakewait-core@0.1.0; snakewait@0.1.0 (deps snakewait-core@0.1.0, termwait@0.1.0); server dep snakewait-core@0.1.0; games.json + plugin bump; `npm install --package-lock-only`. Commit `chore(release): snakewait 0.1.0 pins`.
- [ ] **Step 3:** STOP. Hand the user, in order: (a) feel-gate FIRST — `node "<repo>/packages/snake-client/bin/snakewait.js" --offline` at iTerm2 80x24 (the boomwait 0.1.2 lesson: feel before publish); (b) publish commands (user's terminal, npm login fresh — the termwait E404 lesson): build then `npm publish -w snakewait-core && npm publish -w snakewait`; (c) worker deploy with `env -u CLOUDFLARE_API_TOKEN PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler deploy` from packages/server (ships migration v4). After user confirms: verify publishes + worker health + `/snake/join` smoke + clean-install resolution, tag `snakewait-v0.1.0`, push main + tag, ledger SHIPPED entry.

---

## Self-review notes (spec-coverage pass done at write time)

- Spec §Product → Tasks 9/10/12. §Frame → Task 8. §Core state/sim → Tasks 1-4. §Bots → Task 5. §Wire → Task 6. §Server → Task 7. §Plugin → Tasks 11/12. §Release → Task 12. §Out-of-scope respected (no power-ups, no wrap, 4 players).
- `killSnake` grace-kill helper is introduced in Task 7 (with a core unit test) because only the server needs it — YAGNI kept it out of Task 2.
- Golden (Task 4) precedes bots (Task 5) so the hash is bot-free — boomwait's ordering, kept deliberately.
