# boomwait (terminal bomberman) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship game 3 of the /games arcade — 4-player last-man-standing bomberman on a 13x11 grid, online with bot backfill plus fully offline vs 3 bots, as npm packages `termwait` + `boomwait-core` + `boomwait`.

**Architecture:** Mirrors fragwait/checkwait: zero-dep deterministic core (pure fixed-tick reducer at 20Hz), thin authoritative Durable Objects in the EXISTING fragwait-server worker (migration v3 appended), client built on the NEW `termwait` shared-plumbing package (three-strikes extraction — tasks 1 comes before any boomwait code). Spec: `docs/superpowers/specs/2026-07-11-boomwait-bomber-design.md` — read it first; it governs on any conflict.

**Tech Stack:** TypeScript strict / ESM NodeNext / vitest / Cloudflare Workers + DOs (wrangler 4.107.0, Node 22 for wrangler) / no runtime deps in termwait or core.

## Global Constraints (house rules — every task inherits these)

- `packages/term-kit` (`termwait`) and `packages/bomber-core` (`boomwait-core`): ZERO runtime deps; no `Date.now`/`Math.random` in core src (sim advances by `step()`; RNG is seeded mulberry32 copied from fragwait-core with a source comment). termwait's claude.ts keeps its existing `Date.now` default-param pattern (it is I/O plumbing, not sim).
- Exact version pins everywhere (`"x.y.z"`, never `^`/`~`). `.js` import extensions. Repo path contains a space — always quote.
- TDD: write the failing test first, run it, implement, run again, commit. Test literals are spec pins — change constants and tests together with the root cause stated in the test or ledger.
- Never run the interactive game in subagents; tests + build only. Feel verdicts come from the USER in iTerm2 at the default 80x24 window.
- After every task: append a ledger entry to `.superpowers/sdd/progress.md` (gitignored, still required) and commit with trailer exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- fragwait AND checkwait packages are UNTOUCHED (no edits to packages/core, packages/client, packages/chess-core, packages/chess-client except zero-diff reads for copying). Migration of the shipped games to termwait is FIX-LATER, not this plan.
- wrangler.jsonc migrations: APPEND tag v3 only; v1/v2 (lines ~14-15) are never edited.
- Run tests: `npx vitest run packages/term-kit` (etc.) from repo root; full suite `npm test` must stay green (currently 501). The plugin launcher test runs STANDALONE with a ~30s bound (known chaining hang).
- The 80x24 frame fit (Task 9) is asserted by tests, not eyeballed — this is the checkwait lesson.

## File Structure

```
packages/term-kit/              → npm "termwait" (three-strikes extraction)
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/terminal.ts               (TerminalSession — copied from chess-client)
  src/caps.ts                   (detectColorMode, viewSize)
  src/claude.ts                 (startClaudeListener, busyElapsedSeconds, DEFAULT_DIR)
  src/input/parser.ts           (KeyParser, KeyEvent, MouseEvent, InputEvent)
  src/input/quit.ts             (QuitConfirm, QUIT_CONFIRM_MS)
  src/input/dismiss.ts          (waitForPress)
  test/{parser,terminal,caps,quit}.test.ts
packages/bomber-core/           → npm "boomwait-core"
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/constants.ts              (grid, tick, fuse, shrink, speed constants)
  src/grid.ts                   (Cell, spiral order, createMatch seeded layout)
  src/state.ts                  (BomberState, PlayerState, Bomb, Flame, Input, Result)
  src/step.ts                   (step(): movement, fuses, explosions, shrink, result)
  src/prng.ts                   (mulberry32 — copied from fragwait-core)
  src/bot.ts                    (dangerMap, botDecide, DIFFICULTY params)
  src/protocol.ts               (msg types, parseBomberClientMsg, parseBomberServerMsg,
                                 encodeGrid/decodeGrid compact snapshot helpers)
  test/*.test.ts                (grid, movement, explosion, shrink, bot, protocol, golden)
packages/server/src/
  bomber-lobby.ts               (BomberLobbyDO)  [new]
  bomber-match.ts               (BomberMatchDO)  [new]
  index.ts                      (add /bomber routes + DO exports) [modify]
  ../wrangler.jsonc             (BOMBER_LOBBY/BOMBER_MATCH bindings + migration v3 APPEND) [modify]
packages/bomber-client/         → npm "boomwait"
  package.json tsconfig.json bin/boomwait.js
  src/main.ts src/cliArgs.ts
  src/render.ts                 (arena+HUD → ANSI string; adaptive r; side HUD; glyph fallback)
  src/sprites.ts                (8x8 masks: players x4, bomb, flame, soft, hard, power-ups)
  src/input-latch.ts            (direction latch — fragwait movement lesson)
  src/game.ts                   (shared loop: state, latch→Input, redraw)
  src/offline.ts                (local step() loop vs 3 bots)
  src/net.ts src/online.ts      (lobby join, ws match, fallback to offline)
  src/share.ts                  (bomber share card)
  test/*.test.ts
plugin/games.json               (add boomwait entry) [modify]
plugin/test/launcher.test.sh    (three-entry rotation case) [modify]
README.md                       (bomber section) [modify]
```

---

### Task 1: termwait — the three-strikes extraction

**Files:** Create `packages/term-kit/{package.json,tsconfig.json,src/{index.ts,terminal.ts,caps.ts,claude.ts},src/input/{parser.ts,quit.ts,dismiss.ts},test/{parser.test.ts,terminal.test.ts,caps.test.ts,quit.test.ts}}`. Root workspaces glob `packages/*` already covers it — verify with `npm install`.

**Interfaces (Produces):** exactly what the chess-client copies export today — this is a COPY, not a redesign:
```ts
// terminal.ts
export class TerminalSession   // raw mode, alt screen, resize events, cleanup-on-exit
// caps.ts
export type ColorMode = 'truecolor' | '256' | 'mono'
export function detectColorMode(env: Record<string, string | undefined>): ColorMode
export function viewSize(cols: number, rows: number): { viewCols: number; viewRows: number }
// claude.ts
export const DEFAULT_DIR: string   // ~/.fragwait (shared arcade busy-file dir — unchanged)
export interface ClaudeListener { /* as in chess-client */ }
export async function startClaudeListener(dir?: string): Promise<ClaudeListener>
export function busyElapsedSeconds(dir?: string, now?: number): number | null
// input/parser.ts
export interface KeyEvent { key: string; kind: 'press' | 'repeat' | 'release' }
export interface MouseEvent { /* as in chess-client */ }
export type InputEvent = KeyEvent | MouseEvent
export class KeyParser
// input/quit.ts
export const QUIT_CONFIRM_MS = 2000
export class QuitConfirm
// input/dismiss.ts
export function waitForPress(stdin: NodeJS.ReadStream, parser: KeyParser): Promise<void>
```
`input/translate.ts` is NOT extracted (chess-specific typed-move buffer — stays in chess-client).

- [ ] **Step 1:** Scaffold package.json (`"name": "termwait"`, `"version": "0.0.0"`, ESM NodeNext, zero deps, exports dist, scripts mirroring packages/chess-core) + tsconfig extending the repo pattern. `npm install` to link the workspace.
- [ ] **Step 2:** Copy the 6 source files from `packages/chess-client/src/` VERBATIM (each keeps/updates its provenance comment: `// extracted from packages/chess-client (originally packages/client)`). Copy `packages/chess-client/test/parser.test.ts` and `terminal.test.ts` into `packages/term-kit/test/`, fixing only import paths. Add `src/index.ts` re-exporting everything above.
- [ ] **Step 3:** Run `npx vitest run packages/term-kit` → the two copied suites PASS unchanged (this IS the behavior lock: same tests, same code, new home).
- [ ] **Step 4:** Write NEW failing tests for the two previously-untested modules:

```ts
// test/caps.test.ts
import { describe, expect, it } from 'vitest'
import { detectColorMode, viewSize } from '../src/caps.js'
describe('caps', () => {
  it('COLORTERM=truecolor → truecolor', () =>
    expect(detectColorMode({ COLORTERM: 'truecolor' })).toBe('truecolor'))
  it('Apple Terminal (no COLORTERM, TERM_PROGRAM=Apple_Terminal) → not truecolor', () =>
    expect(detectColorMode({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).not.toBe('truecolor'))
  it('viewSize clamps to sane minimums', () => {
    const v = viewSize(80, 24)
    expect(v.viewCols).toBeGreaterThan(0); expect(v.viewRows).toBeGreaterThan(0)
  })
})
// test/quit.test.ts
import { describe, expect, it } from 'vitest'
import { QUIT_CONFIRM_MS, QuitConfirm } from '../src/input/quit.js'
describe('QuitConfirm', () => {
  it('first q arms, second q within window confirms', () => {
    const qc = new QuitConfirm()
    expect(qc.press(1000)).toBe('armed')
    expect(qc.press(1000 + QUIT_CONFIRM_MS - 1)).toBe('confirmed')
  })
  it('second q after the window re-arms instead', () => {
    const qc = new QuitConfirm()
    qc.press(1000)
    expect(qc.press(1000 + QUIT_CONFIRM_MS + 1)).toBe('armed')
  })
})
```
(Adjust method names to the REAL QuitConfirm API found in the copied file — read it first; the test pins whatever the actual contract is. Same for caps expectations: pin observed behavior, don't change it.)

- [ ] **Step 5:** Run → PASS. Build clean (`npm run build` in the package). Full suite `npm test` still 501+new green. Ledger + commit `feat(termwait): extract shared terminal plumbing (three-strikes)`.

### Task 2: bomber-core scaffold + grid + seeded layout

**Files:** Create `packages/bomber-core/{package.json,tsconfig.json,src/{index.ts,constants.ts,grid.ts,state.ts,prng.ts},test/grid.test.ts}`.

**Interfaces (Produces):**
```ts
// constants.ts
export const GRID_W = 13, GRID_H = 11
export const TICK_RATE = 20
export const FUSE_TICKS = 40           // 2s
export const FLAME_TICKS = 10          // 0.5s
export const BASE_STEP_TICKS = 5       // base speed: one step per 5 ticks
export const MIN_STEP_TICKS = 2        // speed power-up floor
export const SHRINK_START_TICK = 1800  // 90s
export const SHRINK_INTERVAL_TICKS = 20
export const MAX_PLAYERS = 4
export const SOFT_BLOCK_DENSITY = 0.75 // fraction of eligible tiles that get soft blocks
export const POWERUP_COUNTS = { bomb: 6, range: 6, speed: 4 }  // hidden under soft blocks
// state.ts
export type Cell = 'empty' | 'hard' | 'soft'
export type Dir = 'up' | 'down' | 'left' | 'right'
export type PowerupKind = 'bomb' | 'range' | 'speed'
export interface PlayerState {
  id: number; name: string; bot: boolean
  x: number; y: number; alive: boolean
  bombCap: number; range: number; speed: number   // speed 0.. → stepTicks
  dir: Dir | null                                  // latched heading (null = standing)
  stepCooldown: number                             // ticks until next step allowed
  activeBombs: number
}
export interface Bomb { owner: number; x: number; y: number; fuse: number; range: number }
export interface Flame { x: number; y: number; ticks: number }
export interface Drop { x: number; y: number; kind: PowerupKind }
export interface Input { dir: Dir | null; bomb: boolean }
export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }
export interface BomberState {
  tick: number
  grid: Cell[]                       // GRID_W*GRID_H, index = y*GRID_W+x
  hidden: (PowerupKind | null)[]     // parallel to grid: power-up under a soft block
  drops: Drop[]                      // revealed, walk-over-to-collect
  players: PlayerState[]             // length 4, index = player id
  bombs: Bomb[]
  flames: Flame[]
  shrinkIndex: number                // next SPIRAL position to close (-1 before start)
  result: Result | null
}
export function idx(x: number, y: number): number
export function stepTicks(speed: number): number   // max(MIN_STEP_TICKS, BASE_STEP_TICKS - speed)
// grid.ts
export const SPIRAL: { x: number; y: number }[]    // interior tiles, border-inward spiral order
export const SPAWNS: { x: number; y: number }[]    // the 4 corners (1,1) (11,1) (1,9) (11,9)
export function createMatch(seed: number, names: string[], bots: boolean[]): BomberState
```

- [ ] **Step 1:** Scaffold package.json (`"name": "boomwait-core"`, `"version": "0.0.0"`, zero deps) + tsconfig; copy mulberry32 into src/prng.ts with `// copied from packages/core/src/prng.ts (fragwait-core)`. `npm install`.
- [ ] **Step 2:** Write failing `test/grid.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GRID_H, GRID_W } from '../src/constants.js'
import { idx } from '../src/state.js'
import { createMatch, SPAWNS, SPIRAL } from '../src/grid.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]

describe('arena layout', () => {
  const s = createMatch(42, NAMES, BOTS)
  it('border is hard wall, pillars at even-even interior coords', () => {
    for (let x = 0; x < GRID_W; x++) { expect(s.grid[idx(x, 0)]).toBe('hard'); expect(s.grid[idx(x, GRID_H - 1)]).toBe('hard') }
    expect(s.grid[idx(2, 2)]).toBe('hard'); expect(s.grid[idx(4, 6)]).toBe('hard')
    expect(s.grid[idx(1, 1)]).not.toBe('hard')
  })
  it('spawn pockets are clear: corner + its two neighbors', () => {
    for (const { x, y } of SPAWNS) {
      expect(s.grid[idx(x, y)]).toBe('empty')
      const dx = x === 1 ? 1 : -1, dy = y === 1 ? 1 : -1
      expect(s.grid[idx(x + dx, y)]).toBe('empty')
      expect(s.grid[idx(x, y + dy)]).toBe('empty')
    }
  })
  it('same seed → identical layout; different seed → different', () => {
    expect(createMatch(42, NAMES, BOTS).grid).toEqual(s.grid)
    expect(createMatch(43, NAMES, BOTS).grid).not.toEqual(s.grid)
  })
  it('power-ups hidden only under soft blocks, counts per POWERUP_COUNTS', () => {
    let n = 0
    s.hidden.forEach((p, i) => { if (p) { n++; expect(s.grid[i]).toBe('soft') } })
    expect(n).toBe(16)
  })
  it('SPIRAL covers every interior tile exactly once, border-inward', () => {
    expect(SPIRAL.length).toBe((GRID_W - 2) * (GRID_H - 2))
    expect(SPIRAL[0]).toEqual({ x: 1, y: 1 })
    const seen = new Set(SPIRAL.map(p => idx(p.x, p.y)))
    expect(seen.size).toBe(SPIRAL.length)
  })
  it('players start at SPAWNS, alive, base stats', () => {
    s.players.forEach((p, i) => {
      expect({ x: p.x, y: p.y }).toEqual(SPAWNS[i])
      expect(p.alive).toBe(true); expect(p.bombCap).toBe(1); expect(p.range).toBe(2); expect(p.speed).toBe(0)
    })
  })
})
```

- [ ] **Step 3:** Run `npx vitest run packages/bomber-core` → FAIL (modules missing).
- [ ] **Step 4:** Implement constants.ts, state.ts, grid.ts. Layout algorithm: hard border + even-even pillars; eligible tiles = interior, non-pillar, non-spawn-pocket; seeded RNG picks `SOFT_BLOCK_DENSITY` of them as soft; then seeded shuffle assigns POWERUP_COUNTS power-ups to distinct soft tiles (if soft count < 16, cap at soft count — still deterministic). SPIRAL: walk the interior perimeter clockwise from (1,1), then the next ring, inward.
- [ ] **Step 5:** Run → PASS. Ledger + commit `feat(bomber-core): grid, seeded layout, spiral`.

### Task 3: movement (latched grid steps)

**Files:** Create `packages/bomber-core/src/step.ts`, `test/movement.test.ts`.

**Interfaces (Produces):**
```ts
// step.ts
export function step(state: BomberState, inputs: (Input | null)[]): BomberState
// pure; inputs[i] = player i's input this tick (null = no change / no input).
// input.dir sets the latch (null input leaves the latch; {dir:null} clears it — stop).
// This task: movement only. Bombs/flames/shrink land in Tasks 4-5 inside the same step().
```

- [ ] **Step 1:** Write failing `test/movement.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BASE_STEP_TICKS, MIN_STEP_TICKS } from '../src/constants.js'
import { createMatch } from '../src/grid.js'
import { step } from '../src/step.js'
import { stepTicks, type Input } from '../src/state.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]
const NOTHING: (Input | null)[] = [null, null, null, null]
const only = (i: Input): (Input | null)[] => [i, null, null, null]
function run(s: ReturnType<typeof createMatch>, inputs: (Input | null)[], n: number) {
  for (let k = 0; k < n; k++) s = step(s, k === 0 ? inputs : NOTHING)
  return s
}

describe('movement', () => {
  it('latched dir steps once per stepTicks, keeps going without input', () => {
    let s = createMatch(42, NAMES, BOTS)
    s = run(s, only({ dir: 'right', bomb: false }), BASE_STEP_TICKS)
    expect(s.players[0].x).toBe(2)                 // one step after cooldown
    s = run(s, NOTHING, BASE_STEP_TICKS)
    expect(s.players[0].x).toBe(3)                 // latch persists, no events
  })
  it('{dir:null} stops; hard/soft/pillar tiles block; blocked step keeps latch', () => {
    let s = createMatch(42, NAMES, BOTS)
    s = run(s, only({ dir: 'up', bomb: false }), BASE_STEP_TICKS * 3)
    expect(s.players[0].y).toBe(1)                 // wall at y=0 blocks
    s = run(s, only({ dir: null, bomb: false }), BASE_STEP_TICKS)
    expect(s.players[0]).toMatchObject({ x: 1, y: 1, dir: null })
  })
  it('speed power-up shortens the cooldown with a floor', () => {
    expect(stepTicks(0)).toBe(BASE_STEP_TICKS)
    expect(stepTicks(1)).toBe(BASE_STEP_TICKS - 1)
    expect(stepTicks(99)).toBe(MIN_STEP_TICKS)
  })
  it('step is pure: input state object is not mutated', () => {
    const s0 = createMatch(42, NAMES, BOTS)
    const snapshot = JSON.stringify(s0)
    step(s0, only({ dir: 'right', bomb: false }))
    expect(JSON.stringify(s0)).toBe(snapshot)
  })
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement step() movement phase: decrement cooldowns; for each alive player with a latched dir and expired cooldown, compute target tile; passable = inside grid, `empty` cell, no bomb on it, not a closed-by-shrink tile (shrink turns cells `hard`, so the grid check covers it); on move reset cooldown to `stepTicks(speed)`; blocked = stay, keep latch, reset cooldown (retry cadence). Structural sharing is fine; purity means the INPUT state is never mutated (return a new object).
- [ ] **Step 4:** Run → PASS. Ledger + commit `feat(bomber-core): latched grid movement`.

### Task 4: bombs, explosions, chains, deaths, result

**Files:** Modify `packages/bomber-core/src/step.ts`. Create `test/explosion.test.ts`.

**Interfaces (Produces):** step() now also: places bombs (input.bomb, capacity-limited, one per tile), ticks fuses, resolves explosions (rays stop at hard, destroy ≤1 soft per ray, transitive same-tick chains), spawns flames, kills players on flame tiles, decrements owner activeBombs on detonation, stamps `result` (`win` when ≤1 alive, `draw` when the last players die in the same tick — including 0 alive from tick one edge cases).

- [ ] **Step 1:** Write failing `test/explosion.test.ts` (build tiny fixtures by hand-editing a `createMatch` state — helper `clearArena(s)` sets all interior soft→empty for deterministic geometry):

```ts
import { describe, expect, it } from 'vitest'
import { FUSE_TICKS, FLAME_TICKS } from '../src/constants.js'
import { createMatch } from '../src/grid.js'
import { idx, type BomberState, type Input } from '../src/state.js'
import { step } from '../src/step.js'

const NAMES = ['a', 'b', 'c', 'd'], BOTS = [false, true, true, true]
const N: (Input | null)[] = [null, null, null, null]
function clearArena(s: BomberState): BomberState {
  return { ...s, grid: s.grid.map(c => (c === 'soft' ? 'empty' : c)), hidden: s.hidden.map(() => null) }
}
function ticks(s: BomberState, n: number) { for (let i = 0; i < n; i++) s = step(s, N); return s }

describe('bombs and explosions', () => {
  it('bomb placed at player tile, capacity enforced, detonates after FUSE_TICKS', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = step(s, [{ dir: null, bomb: true }, null, null, null])
    expect(s.bombs).toHaveLength(1)
    s = step(s, [{ dir: null, bomb: true }, null, null, null])   // cap 1: rejected
    expect(s.bombs).toHaveLength(1)
    s = ticks(s, FUSE_TICKS)
    expect(s.bombs).toHaveLength(0)
    expect(s.flames.length).toBeGreaterThan(0)
    expect(s.players[0].activeBombs).toBe(0)
  })
  it('rays stop at hard walls and destroy exactly one soft block per ray', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s.grid[idx(3, 1)] = 'soft'; s.grid[idx(4, 1)] = 'soft'   // two soft right of a range-2 bomb at (1,1)? range 2 reaches x=3 only
    s = step(s, [{ dir: null, bomb: true }, null, null, null])
    s = ticks(s, FUSE_TICKS)
    expect(s.grid[idx(3, 1)]).toBe('empty')   // first soft destroyed, ray stopped there
    expect(s.grid[idx(4, 1)]).toBe('soft')
  })
  it('chains detonate transitively in the SAME tick', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    // hand-place: bomb A about to blow at (1,1), fresh bombs B (3,1) and C (5,1), all range 2
    s = { ...s, bombs: [
      { owner: 1, x: 1, y: 1, fuse: 1, range: 2 },
      { owner: 1, x: 3, y: 1, fuse: 999, range: 2 },
      { owner: 1, x: 5, y: 1, fuse: 999, range: 2 },
    ] }
    s = step(s, N)
    expect(s.bombs).toHaveLength(0)           // A → B → C all gone this tick
  })
  it('flame kills; last-two dying same tick → draw; flames expire', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)) }
    // p0 at (1,1), move p1 onto (3,1); bomb between them kills both at once
    s = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, x: 3, y: 1 } : p)),
                bombs: [{ owner: 0, x: 2, y: 1, fuse: 1, range: 2 }] }
    // (2,1) is a pillar? even-even only → (2,1) is not a pillar (y=1 odd). Valid tile.
    s = step(s, N)
    expect(s.players[0].alive).toBe(false); expect(s.players[1].alive).toBe(false)
    expect(s.result).toEqual({ kind: 'draw' })
    s = ticks(s, FLAME_TICKS)
    expect(s.flames).toHaveLength(0)
  })
  it('sole survivor wins', () => {
    let s = clearArena(createMatch(1, NAMES, BOTS))
    s = { ...s, players: s.players.map((p, i) => (i >= 2 ? { ...p, alive: false } : p)),
                bombs: [{ owner: 0, x: 1, y: 2, fuse: 1, range: 1 }] }
    // p1 far away at (11,1); flame at (1,1) kills only p0? No — p0 must die, p1 survive → p1 wins
    s = step(s, N)
    expect(s.result).toEqual({ kind: 'win', winner: 1 })
  })
})
```
(The geometry comments in the fixtures are part of the test's documentation — keep them; adjust coordinates if the pillar math says otherwise when implementing, with the reasoning in the test.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement in step(), phase order per tick: (1) apply inputs (latch + bomb placement), (2) movement, (3) fuse decrement, (4) explosion resolution with a work-queue for same-tick chains (detonating bomb marks flame tiles; any bomb on a flame tile joins the queue), (5) soft destruction + drop reveal (reveal `hidden` → push to `drops`; flame on an exposed drop destroys it), (6) deaths (any alive player on a flame tile), (7) flame expiry, (8) result stamp. Bombs are solid to movement from the tick they are placed (the placer stands ON it and may walk off — standard bomberman: the bomb tile blocks re-entry, not exit).
- [ ] **Step 4:** Run → PASS, full suite green. Ledger + commit `feat(bomber-core): bombs, chains, deaths, result`.

### Task 5: power-up pickup + sudden-death shrink + golden master

**Files:** Modify `packages/bomber-core/src/step.ts`. Create `test/shrink.test.ts`, `test/golden.test.ts`.

**Interfaces (Produces):** step() now also: collects drops (alive player enters a drop tile → stat bump, drop removed; bombCap/range unbounded, speed effective-capped by MIN_STEP_TICKS), and runs the shrink: from SHRINK_START_TICK, every SHRINK_INTERVAL_TICKS the tile at `SPIRAL[shrinkIndex]` becomes `hard` (destroying any soft/bomb/drop there — a bomb crushed by shrink is removed WITHOUT detonating), killing any player standing on it; shrinkIndex advances. When the spiral is exhausted everyone left dies → draw. This guarantees the round ends by tick `SHRINK_START_TICK + SPIRAL.length * SHRINK_INTERVAL_TICKS` (1800 + 99*20 = 3780, ~189s).

- [ ] **Step 1:** Write failing tests. shrink.test.ts: pickup bumps the right stat and removes the drop; shrink closes SPIRAL[0] at exactly tick 1800 and kills a player parked there; a crushed bomb vanishes without flames; a full no-input run ends in `draw` at tick ≤ 3780. golden.test.ts — the determinism pin:

```ts
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
  expect(fnv1a(JSON.stringify(s))).toBe('RECORD_ME')  // record on first green run, then pinned
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement pickup + shrink phases (pickup after movement; shrink before result stamp). **Step 4:** Run, record the golden hash (replace `RECORD_ME`), run again → PASS. **Step 5:** Ledger + commit `feat(bomber-core): power-ups, sudden-death shrink, golden master`.

### Task 6: bots

**Files:** Create `packages/bomber-core/src/bot.ts`, `test/bot.test.ts`.

**Interfaces (Produces):**
```ts
export type Difficulty = 'easy' | 'normal' | 'hard'
export interface BotMind { rng: () => number; nextDecisionTick: number }  // per-bot, caller-owned
export function createBotMind(seed: number): BotMind
export function dangerMap(state: BomberState): number[]
// per tile: ticks until flame arrives (Infinity = safe). Includes active flames (0)
// and every ticking bomb's rays; 'hard' predicts one chain level deeper.
export function botDecide(state: BomberState, id: number, mind: BotMind, d: Difficulty): Input
// deterministic given (state, mind.rng state, d); mutates only mind (rng advance, decision cadence)
```
Policy (from the spec): in danger → BFS to nearest tile that stays safe long enough to reach; else approach nearest reachable soft block / enemy / drop; drop a bomb when adjacent to a target ONLY if a safe retreat exists post-placement. Difficulty = decision cadence + mistake rate: easy decides every 10 ticks and with p=0.15 skips the danger re-check; normal every 5 ticks; hard every 3 ticks + chain-aware dangerMap. All BFS bounded by grid size (143 tiles) — node budget is structural, never wall-clock.

- [ ] **Step 1:** Write failing `test/bot.test.ts`: (a) dangerMap marks the 4 rays of a ticking bomb and Infinity elsewhere; (b) never-suicides property — 200 seeded random states with a safe escape: after `botDecide`+step until the bomb resolves, bot is alive (skip states with no safe option); (c) bot adjacent to a soft block with a safe retreat eventually plants (run ≤ 200 ticks); (d) 4-bot seeded match at each difficulty reaches `result !== null` before tick 3780; (e) determinism: same seed → identical decision sequence.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS (property tests are seeded, never flaky). Ledger + commit `feat(bomber-core): danger-map bots, three difficulties`.

### Task 7: protocol

**Files:** Create `packages/bomber-core/src/protocol.ts`, `test/protocol.test.ts`. Modify `src/index.ts` re-exports (all tasks re-export as they go).

**Interfaces (Produces):**
```ts
export const MAX_RAW = 4096          // inbound size cap (matches fragwait)
export interface HelloMsg   { t: 'hello'; name: string }                       // client→server
export interface InputMsg   { t: 'input'; dir: Dir | null | 'keep'; bomb: boolean }  // 'keep' = don't touch latch
export interface StartMsg   { t: 'start'; you: number; seed: number; names: string[]; bots: boolean[]; startTick: number }
export interface SnapMsg    { t: 'snap'; state: WireState }                    // server→client, every tick
export interface EndMsg     { t: 'end'; result: Result }
export type BomberClientMsg = HelloMsg | InputMsg
export type BomberServerMsg = StartMsg | SnapMsg | EndMsg
export function parseBomberClientMsg(raw: unknown): BomberClientMsg | null    // size-capped, never throws
export function parseBomberServerMsg(raw: unknown): BomberServerMsg | null
// Compact wire form: grid/hidden as digit strings, entity arrays as tuples.
export interface WireState { /* tick, g: string, players: tuple[], bombs: tuple[], flames: tuple[], drops: tuple[], shrinkIndex, result */ }
export function toWire(s: BomberState): WireState
export function fromWire(w: WireState): BomberState
```
Note: `hidden` is NOT sent to clients (no map-hack); `fromWire` reconstructs it as all-null — clients only render, the server owns truth.

- [ ] **Step 1:** Failing tests: round-trip `fromWire(toWire(s))` equals s minus `hidden`; every parse rejects oversized raw (> MAX_RAW), wrong `t`, missing fields, and never throws on garbage (`null`, `{}`, `'x'.repeat(5000)`, binary-ish strings); snapshot JSON of a busy mid-game state stays under 2048 bytes (pin the ceiling).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (mirror checkwait-core protocol.ts's parse/validate discipline). **Step 4:** Run → PASS. Ledger + commit `feat(bomber-core): wire protocol + compact snapshots`.

### Task 8: server DOs (existing worker) + wrangler migration v3

**Files:** Create `packages/server/src/bomber-lobby.ts`, `packages/server/src/bomber-match.ts`, `packages/server/test/bomber.test.ts`. Modify `packages/server/src/index.ts` (routes + DO exports), `packages/server/wrangler.jsonc` (bindings `BOMBER_LOBBY`, `BOMBER_MATCH` + APPENDED migration `{ "tag": "v3", "new_sqlite_classes": ["BomberLobbyDO", "BomberMatchDO"] }` — v1/v2 untouched), `packages/server/package.json` (add `"boomwait-core": "0.0.0"` workspace dep — pin to the real version at release).

**Interfaces (Consumes):** boomwait-core Tasks 2–7 (createMatch, step, botDecide, protocol). **Produces:** `POST /bomber/join {name}` → `{ matchId, token }` after the ~10s gather window (bots backfill to 4 — never `noOpponent`; offline flag is the client's choice, not a server outcome); `GET /bomber/match/:id/ws?token=` (WebSocket).

- [ ] **Step 1:** Read `packages/server/src/{lobby-do.ts,lobby-logic.ts,match-do.ts,match-host.ts,chess-lobby.ts}` first — the lobby gather window, alarm-driven tick loop, WebSocket hibernation/attachment, inbound cap, and safe-parse patterns all come from there; bomber code follows the same shapes.
- [ ] **Step 2:** Failing tests (vitest + the existing server test harness pattern — read `packages/server/test/chess.test.ts` for the DO test setup): lobby fills 4 humans → match with 0 bots; 1 human after window → match with 3 bots; match DO advances the sim at 20Hz feeding `botDecide` for bot slots; client InputMsg updates that player's latch; disconnect → 5s grace → player eliminated, their bombs still resolve; oversized/garbage messages dropped without crashing; `wrangler.jsonc` contains tags v1, v2, v3 in order (a literal test reading the file — the append-only rule, enforced).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement BomberLobbyDO (lobby-logic shape, MAX 4) + BomberMatchDO (alarm tick loop at 50ms; on each tick: gather latest inputs per player, botDecide for bots, `step()`, broadcast `SnapMsg`; on `result` → `EndMsg`, stop alarms, tombstone). **Step 5:** Run → PASS, full suite green. Ledger + commit `feat(server): bomber lobby + match DOs, migration v3`. NO DEPLOY — deploy is user-gated at release.

### Task 9: client scaffold + renderer (the 80x24 gate, asserted)

**Files:** Create `packages/bomber-client/{package.json,tsconfig.json,bin/boomwait.js,src/{main.ts,cliArgs.ts,render.ts,sprites.ts,share.ts}}`, `test/{render.test.ts,cliArgs.test.ts,share.test.ts}`.

**Interfaces (Consumes):** termwait (TerminalSession, detectColorMode, viewSize, KeyParser, QuitConfirm, waitForPress, startClaudeListener), boomwait-core state types. **Produces:**
```ts
// render.ts
export interface Layout { r: number; sideHud: boolean; glyph: boolean }
export function chooseLayout(cols: number, rows: number, mode: ColorMode): Layout
// r = largest tile size fitting; sideHud when cols >= 26*r*... (exact rule below); glyph when r<2 or mode!=='truecolor'
export function renderFrame(s: BomberState, you: number, layout: Layout, claude: string): string
// full ANSI frame: arena + HUD + 1 status row; per-line ESC[K discipline (termwait/chess-4 pattern)
// sprites.ts
export const SPRITES: Record<string, number[]>   // 8x8 bitmasks: p0-p3, bomb0-bomb2 (fuse stages), flame, soft, hard, drop-bomb, drop-range, drop-speed
export function scaleMask(mask: number[], px: number): boolean[][]   // nearest-neighbor, chess-4 pipeline
```
Layout rule (the spec's frame math, pinned): board = 26r cols × 11r rows. Choose the largest r with `11r + 1 <= rows` and (`26r + 27 <= cols` → sideHud) or (`26r <= cols` and `11r + 8 <= rows` → below-HUD); r=1 or non-truecolor → glyph mode (2 cols/tile, letters). At 80x24: r=2, sideHud, 79 cols × 23 rows used.

- [ ] **Step 1:** Scaffold package.json (`"name": "boomwait"`, bin, deps `"boomwait-core": "0.0.0"`, `"termwait": "0.0.0"` workspace pins, `"ws": "8.21.0"`) + tsconfig + bin/boomwait.js (mirror bin/checkwait.js). cliArgs mirrors checkwait's (`--offline --difficulty --name --server --mute`), copied test included.
- [ ] **Step 2:** Failing `test/render.test.ts` — THE checkwait lesson as executable spec:

```ts
import { describe, expect, it } from 'vitest'
import { createMatch } from 'boomwait-core'
import { chooseLayout, renderFrame } from '../src/render.js'

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

describe('the 80x24 gate', () => {
  it('iTerm2 default (80x24, truecolor) → r=2 sprites with side HUD', () => {
    expect(chooseLayout(80, 24, 'truecolor')).toEqual({ r: 2, sideHud: true, glyph: false })
  })
  it('frame at 80x24 fits: ≤24 lines, every line ≤80 visible cols', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const lines = renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, 'Claude working…').split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(80)
  })
  it('bigger window → bigger r, same rule', () =>
    expect(chooseLayout(160, 50, 'truecolor').r).toBeGreaterThanOrEqual(3))
  it('tiny window or no truecolor → glyph mode, still fits', () => {
    expect(chooseLayout(40, 14, 'truecolor').glyph).toBe(true)
    expect(chooseLayout(80, 24, '256').glyph).toBe(true)
    const s = createMatch(42, ['a', 'b', 'c', 'd'], [false, true, true, true])
    const lines = renderFrame(s, 0, { r: 1, sideHud: false, glyph: true }, '').split('\n')
    expect(lines.length).toBeLessThanOrEqual(14)
  })
  it('HUD shows all four players + timer + shrink warning', () => {
    const s = createMatch(42, ['you', 'bot1', 'bot2', 'bot3'], [false, true, true, true])
    const flat = strip(renderFrame(s, 0, { r: 2, sideHud: true, glyph: false }, ''))
    for (const n of ['you', 'bot1', 'bot2', 'bot3']) expect(flat).toContain(n)
  })
})
```

- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement sprites.ts (8x8 masks; bombs get 3 fuse-stage variants; players 4 team colors) + render.ts (half-block ▀▄ compositing per the chess-4 `board-render.ts` pipeline — read it first; glyph mode: `##` hard, `▒▒` soft via ASCII fallback letters when mono, `@1-@4` players, `o` bomb, `*` flame). Share.ts mirrors checkwait's card with boomwait install commands. **Step 5:** Run → PASS. Ledger + commit `feat(boomwait): renderer passes the 80x24 gate day one`.

### Task 10: input latch + offline game loop

**Files:** Create `packages/bomber-client/src/{input-latch.ts,game.ts,offline.ts}`, `test/input-latch.test.ts`.

**Interfaces (Consumes):** termwait KeyParser events; core step/botDecide. **Produces:**
```ts
// input-latch.ts — fragwait feel lesson: movement is LATCHED, timing-free.
export interface LatchState { dir: Dir | null; bombQueued: boolean }
export function createLatch(): LatchState
export function onKey(l: LatchState, e: KeyEvent): LatchState
// press/repeat of a dir key (wasd/arrows): same dir → no-op; perpendicular → switch;
// OPPOSING dir → stop (stop-first, tap again to reverse). space → bombQueued.
// (repeat events are safe: same-dir no-op means OS auto-repeat can't toggle anything.)
export function drain(l: LatchState): { input: Input; next: LatchState }  // bombQueued is one-shot
// offline.ts
export function runOffline(opts: { difficulty: Difficulty; name: string; seed: number }): Promise<Result>
// 20Hz local loop: drain latch → inputs[0], botDecide → inputs[1..3], step, renderFrame
```

- [ ] **Step 1:** Failing `test/input-latch.test.ts`: dir press latches; same-key repeat is a no-op; opposing tap stops; second opposing tap reverses; perpendicular switches without stopping; space queues exactly one bomb per press; drain clears bombQueued but keeps dir.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement input-latch.ts (pure), game.ts (shared render/tick/quit-confirm/Claude-status glue used by offline and online), offline.ts. The loop's interval uses real time (client I/O layer — the no-Date.now rule binds core, not the client shell; same as fragwait/checkwait). **Step 4:** Run → PASS. Ledger + commit `feat(boomwait): direction latch + offline vs 3 bots`.

### Task 11: online flow

**Files:** Create `packages/bomber-client/src/{net.ts,online.ts}`, `test/net.test.ts`. Modify `src/main.ts` (online default → offline fallback on join failure, `--offline` skips join).

**Interfaces (Consumes):** protocol msgs, server routes from Task 8. **Produces:** `runOnline(opts): Promise<Result | 'fallback'>` — POST /bomber/join → ws connect → StartMsg seeds the local mirror → each SnapMsg replaces rendered state → latch changes send InputMsg (`'keep'` when unchanged, so quiet ticks send nothing) → EndMsg → result screen → share card. Quit-confirm during a match sends nothing special: closing the socket IS elimination (server's 5s grace covers accidental drops).

- [ ] **Step 1:** Failing `test/net.test.ts` against a local `ws` server fixture (mirror `packages/chess-client/test/net.test.ts` — read it first): join/start/snap/end sequence drives the state mirror; garbage server messages are ignored; socket close mid-game → clean 'fallback'-free elimination result; InputMsg only sent on latch change.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, full suite green. Ledger + commit `feat(boomwait): online matches with bot backfill`.

### Task 12: plugin registry + launcher rotation + README

**Files:** Modify `plugin/games.json` (append `{ "id": "boomwait", ... cmd: "npx -y boomwait@0.1.0" }` — the version Task 13 publishes), `plugin/test/launcher.test.sh` (THREE-entry rotation: 0→1→2→0), `README.md` (bomber section: what it is, controls — wasd/arrows latch, space bomb, q-q quit — and `npx -y boomwait`), `plugin/.claude-plugin/plugin.json` (minor bump: 0.3.0 — new game).

- [ ] **Step 1:** Extend launcher.test.sh for three entries; run it STANDALONE (`bash plugin/test/launcher.test.sh`, ~30s bound) → FAIL (2 entries). **Step 2:** Append the games.json entry + plugin.json bump + README section. **Step 3:** Launcher test standalone → PASS; `npm test` full suite green. Ledger + commit `feat(plugin): boomwait joins the rotation (FPS → chess → bomber)`.

### Task 13: release (USER-GATED — stop and hand over)

**Files:** Version pins across `packages/term-kit/package.json` (0.1.0), `packages/bomber-core/package.json` (0.1.0), `packages/bomber-client/package.json` (0.1.0, deps pinned to `termwait@0.1.0`, `boomwait-core@0.1.0`), `packages/server/package.json` (`boomwait-core@0.1.0`).

- [ ] **Step 1:** Re-verify npm names still free: `npm view termwait version` / `boomwait-core` / `boomwait` → all must E404. If any is taken, STOP and surface to the user.
- [ ] **Step 2:** Pin all versions, build all three packages, full suite green, commit `chore(release): boomwait 0.1.0 pins`.
- [ ] **Step 3:** STOP. Hand the user the exact commands to run in THEIR terminal (OTP redaction breaks `!`-publishes; `npm login` may have silently expired — a fresh `npm login` first if publish 404/401s):
  publish order `packages/term-kit` → `packages/bomber-core` → `packages/bomber-client`, then Cloudflare deploy from `packages/server` with `env -u CLOUDFLARE_API_TOKEN` and Node 22 PATH (`$HOME/.nvm/versions/node/v22.22.2/bin`) — deploy only on their explicit go (migration v3 ships here).
- [ ] **Step 4 (after user publishes/deploys):** smoke: `npx -y boomwait@0.1.0 --offline` reaches the arena; `curl -s https://fragwait-server.agthe7.workers.dev/` ok; `POST /bomber/join` answers. Tag `boomwait-v0.1.0`, push. FEEL GATE: user plays offline at 80x24 iTerm2 default — feel iterations follow the checkwait bump ritual (client package.json + games.json cmd + plugin.json move together).
- [ ] **Step 5:** Ledger entries: release + two FIX-LATER items — "migrate chess-client to termwait at next checkwait release" and "migrate packages/client to termwait at next fragwait release".

## Self-review notes

- Spec coverage: product scope (T9-12), 80x24-first frame asserted (T9), core trio power-ups (T5), grid-locked latch movement (T3, T10 — latch chosen over hold per fragwait's Apple-Terminal auto-repeat finding; spec's "hold a direction" is delivered BY the latch, since motion persists without events), single round + shrink w/ guaranteed end (T5), 4-player + bot backfill (T6, T8), online+offline (T10, T11), termwait extraction first with existing games untouched (T1), migration v3 append-only with a test enforcing it (T8), plugin rotation (T12), user-gated release + feel gate (T13).
- translate.ts deliberately NOT extracted (chess-specific) — spec amended to match.
- Type consistency: `Input {dir, bomb}` used by step/bot/protocol/latch; wire `'keep'` exists only in InputMsg and is resolved to latch state server-side; `Result` shared core↔protocol↔client.
- Golden-master `RECORD_ME` is an instructed record-then-pin step, not a placeholder.
