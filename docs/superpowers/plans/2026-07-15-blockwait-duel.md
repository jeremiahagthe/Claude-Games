# blockwait (terminal 1v1 block-stacking duel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship game 5 of the /games arcade — a 1v1 falling-block duel (SRS, 7-bag, hold, ghost; classic 0/1/2/4 attacks with cancellation; gravity ramp + sudden-death garbage end bound), online with one-bot backfill plus fully offline vs a bot, as npm packages `blockwait-core` + `blockwait`.

**Architecture:** Zero-dep deterministic core with a per-player pure reducer (`stepPlayer` — each board advances on its OWN tick clock; boards are independent except garbage) plus an offline/golden wrapper `step` that drives both on one clock. Online authority = input replay: clients send tick-stamped event batches; the MatchDO advances each player's board through the identical reducer (no rewind — per-player clocks), routes attacks, and broadcasts snaps. The client simulates its OWN board locally (offline-quality feel) and renders the opponent from snaps. Thin DOs in the EXISTING fragwait-server worker (migration v5 appended), client on published `termwait@0.1.0` (exact pin). Spec: `docs/superpowers/specs/2026-07-15-blockwait-design.md` — read it first; it governs on any conflict.

**Tech Stack:** TypeScript strict / ESM NodeNext / vitest / Cloudflare Workers + DOs (wrangler 4.107.0, Node 22 for wrangler) / no runtime deps in core.

## Global Constraints (house rules — every task inherits these)

- `packages/block-core` (`blockwait-core`): ZERO runtime deps; no `Date.now`/`Math.random` in core src (a grep test enforces it). RNG is the PURE serializable `randStep(s: number)` (copy snake-core's prng.ts verbatim with a source comment) — bag shuffles and garbage holes happen mid-match.
- Exact version pins everywhere (`"x.y.z"`, never `^`/`~`). `.js` import extensions. Repo path contains a space — ALWAYS quote in shell; NEVER backslash-escape paths in Write/Edit tool calls (snakewait Task 4 incident).
- TDD: write the failing test first, run it, implement, run again, commit. Test literals are spec pins — change constants and tests together with the root cause stated in the test or ledger.
- Never run the interactive game in subagents; tests + build only. Feel verdicts come from the USER in iTerm2 at the default 80x24 window. The sanctioned non-interactive check is the vtsim gate (Task 9) — headless capture replayed through a VT simulator.
- After every task: append a ledger entry to `.superpowers/sdd/progress.md` and commit with trailer exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- fragwait, checkwait, boomwait, AND snakewait packages are FROZEN (packages/core, client, chess-core, chess-client, bomber-core, bomber-client, snake-core, snake-client — zero-diff, pattern reference only). termwait (`packages/term-kit`) consumed as-is at 0.1.0. Exception: Task 12 touches `packages/server` (worker code, not a published package) and its tests ONLY.
- wrangler.jsonc migrations: APPEND tag v5 only; v1–v4 never edited (literal file-reading test enforces order).
- Run tests: `npx vitest run packages/block-core` (etc.) from repo root; full suite `npm test` must stay green (currently 816). Plugin launcher test runs STANDALONE with a ~30s bound (known chaining hang).
- The 80x24 frame fit (Task 8) is asserted by tests, never eyeballed. Raw ESC[H/K/J framing pins land in the SAME task as the first renderer code (snakewait feel-gate lesson 813d2a9), with clear-to-EOL at line START (col-80 lesson 8f417db).
- **Stale-dist rule (bit twice):** packages/server and packages/block-client import `blockwait-core` through its BUILT dist, and block-client's bin runs its OWN dist — after ANY src change in either, run `npm run build -w blockwait-core` / `npm run build -w blockwait` before dependent tests, the vtsim gate, the feel gate, or publish.
- Visible-width measurement in tests uses the \x1b-aware strip `/\x1b\[[0-9;]*[A-Za-z]/g` and asserts EXACT widths (snakewait Task 8 lesson — never `≤` on padded rows). No literal control bytes in test files — `\x1b` source escapes only (binary-test-file incident, twice).
- Coordinate convention (used consistently in core, tests, renderer): board is y-DOWN, row 0 = top. Rows 0–3 hidden spawn buffer, rows 4–23 visible. Piece-box coords y-down. Published SRS kick tables are y-UP: this plan's kick literals are ALREADY y-flipped — do not flip again.

## File Structure

```
packages/block-core/            → npm "blockwait-core"
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/constants.ts              (board, tick, gravity schedule, lock delay, attack table, sudden death)
  src/prng.ts                   (mulberry32 + pure randStep — copied from snake-core, source comment)
  src/pieces.ts                 (PieceKind, SHAPES, rotation, SRS kick tables, cellsOf)
  src/state.ts                  (PlayerState, MatchState, GameEvent, Result, helpers)
  src/match.ts                  (createMatch / createPlayer: seeded bags, empty boards)
  src/step.ts                   (stepPlayer per-player reducer; step offline wrapper; queueGarbage; killPlayer)
  src/bot.ts                    (botDecide: placement enumeration, 4-term heuristic, event emission)
  src/protocol.ts               (msg types, hex-row board codec, parse + caps, sanitizeHandle)
  test/{pieces,match,step,garbage,golden,bot,protocol,nodate}.test.ts
packages/server/src/
  block-lobby.ts                (BlockLobbyDO)  [new]
  block-match.ts                (BlockMatchDO + BlockMatchHost) [new]
  index.ts                      (add /block routes + DO exports; Task 12: snake join 400) [modify]
  ../wrangler.jsonc             (BLOCK_LOBBY/BLOCK_MATCH bindings + migration v5 APPEND) [modify]
  ../package.json               (add blockwait-core workspace dep) [modify]
  test/block.test.ts            [new]
  test/snake.test.ts            (Task 12 only: join-400 + de-vacuous food assertion) [modify]
packages/block-client/          → npm "blockwait"
  package.json tsconfig.json bin/blockwait.js
  src/main.ts src/cli.ts src/cliArgs.ts
  src/render.ts                 (two 22-col boards + 36-col center HUD; 2-char cells; ghost; color tiers)
  src/input-queue.ts            (ordered per-tick event queue, cap 8)
  src/game.ts                   (session glue — snake-client's game.ts shape)
  src/offline.ts src/share.ts
  src/net.ts src/online.ts
  test/{cliArgs,input-queue,render,share,net,online,vt}.test.ts
  test/vtsim.ts                 (checked-in VT simulator — the promoted positional-escape gate)
plugin/games.json               (add blockwait entry AT RELEASE) [modify]
plugin/test/launcher.test.sh    (five-entry rotation case) [modify]
README.md                       (blockwait section) [modify]
```

---

### Task 1: block-core scaffold + pieces (shapes, SRS rotation, kicks) + state + createMatch

**Files:** Create `packages/block-core/{package.json,tsconfig.json,src/{index.ts,constants.ts,prng.ts,pieces.ts,state.ts,match.ts},test/pieces.test.ts,test/match.test.ts,test/nodate.test.ts}`.

**Interfaces (Produces):**
```ts
// constants.ts
export const BOARD_W = 10, BOARD_H = 20, HIDDEN_ROWS = 4, TOTAL_ROWS = 24 // rows 0-3 hidden (top), 4-23 visible
export const TICK_RATE = 20
export const PREVIEW = 3
export const LOCK_DELAY_TICKS = 10
export const LOCK_RESETS_MAX = 15
export const ATTACK: readonly number[] = [0, 0, 1, 2, 4]      // index = lines cleared
export const GRAVITY_SCHEDULE: readonly [number, number][] =  // [fromTick, ticksPerCell]
  [[0, 20], [400, 15], [800, 10], [1200, 6], [1600, 4], [2000, 3], [2400, 2]]
export const SUDDEN_DEATH_TICK = 2400
export const SUDDEN_DEATH_INTERVAL = 100
export const MAX_EVENTS_PER_TICK = 8
export const GARBAGE = 8                                       // board cell value for garbage
// prng.ts — copied from packages/snake-core/src/prng.ts verbatim (source comment)
export function mulberry32(seed: number): () => number
export function randStep(s: number): { value: number; next: number }
// pieces.ts
export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'L' | 'J'
export type Rot = 0 | 1 | 2 | 3
export const KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'L', 'J'] // wire/board code = index+1
export const BOX: Record<PieceKind, number>          // I:4, O:2, others:3
export const SHAPES: Record<PieceKind, [number, number][]>  // rotation-0 cells in box, y-DOWN
export function cellsAt(kind: PieceKind, rot: Rot, x: number, y: number): [number, number][] // absolute board cells
export const KICKS_JLSTZ: Record<string, [number, number][]> // keys '01','10','12','21','23','32','30','03' (rot from→to)
export const KICKS_I: Record<string, [number, number][]>     // O: no kicks (rotation is identity)
export function spawnPiece(kind: PieceKind): ActivePiece      // rot 0, y=2, x=3 (x=4 for O)
// state.ts
export type GameEvent = 'left' | 'right' | 'rotCW' | 'rotCCW' | 'softDrop' | 'hardDrop' | 'hold'
export const EVENT_CODES: readonly GameEvent[]                // wire code = index
export interface ActivePiece { kind: PieceKind; rot: Rot; x: number; y: number }
export interface GarbageEntry { rows: number; holeCol: number }
export interface PlayerState {
  id: number; name: string; bot: boolean; alive: boolean
  tick: number                 // OWN sim clock (the per-player-clock model)
  board: number[]              // TOTAL_ROWS*BOARD_W cells, idx=y*BOARD_W+x; 0 empty, 1-7 KINDS index+1, 8 garbage
  piece: ActivePiece | null    // null only after death
  queue: PieceKind[]           // upcoming pieces; refilled to ≥ PREVIEW+1 by bag shuffles
  bagRng: number               // randStep state — IDENTICAL for both players at creation (same sequence)
  hold: PieceKind | null
  holdUsed: boolean            // one hold per piece
  fallCooldown: number         // ticks until next gravity fall
  lockTicks: number | null     // countdown while grounded, null when airborne
  lockResets: number           // per-piece, cleared on spawn
  pendingGarbage: GarbageEntry[]
  linesCleared: number; linesSent: number
}
export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }
export interface MatchState { players: [PlayerState, PlayerState]; garbageRng: number; result: Result | null }
export function bIdx(x: number, y: number): number            // y*BOARD_W+x
export function gravityTicksAt(tick: number): number          // from GRAVITY_SCHEDULE
export function collides(board: number[], p: ActivePiece): boolean // any cell OOB (x<0|x≥10|y<0|y≥24) or occupied
// match.ts
export function createMatch(seed: number, names: string[], bots: boolean[]): MatchState
```

SHAPES rotation-0 literals (y-down inside the box; row 0 = box top):
`I:[[0,1],[1,1],[2,1],[3,1]]  O:[[0,0],[1,0],[0,1],[1,1]]  T:[[1,0],[0,1],[1,1],[2,1]]  S:[[1,0],[2,0],[0,1],[1,1]]  Z:[[0,0],[1,0],[1,1],[2,1]]  L:[[2,0],[0,1],[1,1],[2,1]]  J:[[0,0],[0,1],[1,1],[2,1]]`
Rotation is algorithmic from rotation 0 (never stored): one CW turn in box size N maps `(x,y) → (N-1-y, x)`; apply `rot` times. O returns its cells unchanged.

Kick tables (SRS, ALREADY converted to our y-down convention — published tables are y-up, dy negated here):
```ts
export const KICKS_JLSTZ = {
  '01': [[0,0],[-1,0],[-1,-1],[0, 2],[-1, 2]], '10': [[0,0],[ 1,0],[ 1, 1],[0,-2],[ 1,-2]],
  '12': [[0,0],[ 1,0],[ 1, 1],[0,-2],[ 1,-2]], '21': [[0,0],[-1,0],[-1,-1],[0, 2],[-1, 2]],
  '23': [[0,0],[ 1,0],[ 1,-1],[0, 2],[ 1, 2]], '32': [[0,0],[-1,0],[-1, 1],[0,-2],[-1,-2]],
  '30': [[0,0],[-1,0],[-1, 1],[0,-2],[-1,-2]], '03': [[0,0],[ 1,0],[ 1,-1],[0, 2],[ 1, 2]],
} as const
export const KICKS_I = {
  '01': [[0,0],[-2,0],[ 1,0],[-2, 1],[ 1,-2]], '10': [[0,0],[ 2,0],[-1,0],[ 2,-1],[-1, 2]],
  '12': [[0,0],[-1,0],[ 2,0],[-1,-2],[ 2, 1]], '21': [[0,0],[ 1,0],[-2,0],[ 1, 2],[-2,-1]],
  '23': [[0,0],[ 2,0],[-1,0],[ 2,-1],[-1, 2]], '32': [[0,0],[-2,0],[ 1,0],[-2, 1],[ 1,-2]],
  '30': [[0,0],[ 1,0],[-2,0],[ 1, 2],[-2,-1]], '03': [[0,0],[-1,0],[ 2,0],[-1,-2],[ 2, 1]],
} as const
```

createMatch: two players, empty boards, `bagRng` for BOTH = `(mulberry32(seed)() * 2**32) >>> 0` (identical → identical piece sequences), `garbageRng` = one further mulberry32 draw from the same generator. Fill each queue by bag shuffles (Fisher–Yates over a fresh `[...KINDS]` using randStep, appending 7 kinds) until `queue.length ≥ PREVIEW + 1`, then `piece = spawnPiece(queue.shift())` — after createMatch each player has an active piece + 3 previews. `fallCooldown = gravityTicksAt(0)`, `tick 0`, hold null, pendingGarbage [], stats 0.

- [ ] **Step 1:** Scaffold package.json (`"name": "blockwait-core"`, `"version": "0.0.0"`, `"type": "module"`, main/types → dist, zero deps, build script `tsc -p tsconfig.json`) + tsconfig copied from packages/snake-core (NodeNext, strict). `npm install`.
- [ ] **Step 2:** Write failing `test/pieces.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cellsAt, KICKS_I, KICKS_JLSTZ, KINDS, spawnPiece } from '../src/pieces.js'

describe('shapes & rotation (hand-traced pins)', () => {
  it('T rotations at (3,10)', () => {
    expect(new Set(cellsAt('T', 0, 3, 10).map(String))).toEqual(new Set([[4,10],[3,11],[4,11],[5,11]].map(String)))
    expect(new Set(cellsAt('T', 1, 3, 10).map(String))).toEqual(new Set([[4,10],[5,11],[4,11],[4,12]].map(String)))
    expect(new Set(cellsAt('T', 2, 3, 10).map(String))).toEqual(new Set([[3,11],[4,11],[5,11],[4,12]].map(String)))
    expect(new Set(cellsAt('T', 3, 3, 10).map(String))).toEqual(new Set([[4,10],[3,11],[4,11],[4,12]].map(String)))
  })
  it('I vertical (rot 1) occupies column x+2, rows y..y+3', () => {
    expect(new Set(cellsAt('I', 1, 7, 20).map(String))).toEqual(new Set([[9,20],[9,21],[9,22],[9,23]].map(String)))
  })
  it('O rotation is identity', () => {
    for (const r of [0,1,2,3] as const) expect(new Set(cellsAt('O', r, 4, 2).map(String))).toEqual(new Set([[4,2],[5,2],[4,3],[5,3]].map(String)))
  })
  it('every kind/rot yields 4 distinct in-box cells', () => {
    for (const k of KINDS) for (const r of [0,1,2,3] as const) expect(new Set(cellsAt(k, r, 0, 0).map(String)).size).toBe(4)
  })
  it('spawn: rot 0, y=2, x=3 (O at x=4); all spawn cells in hidden rows 2-3', () => {
    for (const k of KINDS) {
      const p = spawnPiece(k)
      expect(p.rot).toBe(0); expect(p.y).toBe(2); expect(p.x).toBe(k === 'O' ? 4 : 3)
      for (const [, y] of cellsAt(k, p.rot, p.x, p.y)) expect(y).toBeLessThan(4)
    }
  })
  it('kick tables have 8 transitions × 5 offsets, first always (0,0)', () => {
    for (const t of [KICKS_JLSTZ, KICKS_I]) {
      expect(Object.keys(t)).toHaveLength(8)
      for (const offs of Object.values(t)) { expect(offs).toHaveLength(5); expect(offs[0]).toEqual([0,0]) }
    }
  })
})
```

- [ ] **Step 3:** Write failing `test/match.test.ts`:

```ts
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
```

- [ ] **Step 4:** Run `npx vitest run packages/block-core` → FAIL (modules missing).
- [ ] **Step 5:** Implement constants/prng/pieces/state/match per the Interfaces block. index.ts re-exports everything listed.
- [ ] **Step 6:** Write `test/nodate.test.ts` — same shape as snake-core's (readdir src, assert no `/Date\.now|Math\.random/` in any .ts).
- [ ] **Step 7:** Run → PASS; full `npm test` green (816 → +new). Ledger + commit `feat(block-core): scaffold, pieces + SRS data, state, seeded createMatch`.

---

### Task 2: stepPlayer — gravity, events, kicks, lock delay, clears, hold, top-out

**Files:** Create `packages/block-core/src/step.ts`, `packages/block-core/test/step.test.ts`. Modify `src/index.ts`.

**Interfaces (Consumes):** Task 1 everything. **Produces:**
```ts
export interface StepOut { player: PlayerState; attack: number; locked: boolean }
export function stepPlayer(p: PlayerState, events: GameEvent[]): StepOut  // pure, never mutates; one tick of ONE board
```
Attack routing, garbage QUEUING, sudden death, and the offline two-player wrapper arrive in Task 3 — this task is one board in isolation (`attack` is computed and returned; nothing consumes it yet). `pendingGarbage` materialization is ALSO Task 3; here locks simply return attack BEFORE cancellation is defined — to keep this task self-contained, `attack` in THIS task = `ATTACK[linesClearedThisLock]` raw; Task 3 adds cancellation and may adjust this task's tests only by ADDING pending-garbage fixtures (raw-attack pins stay valid with empty pendingGarbage).

Per-tick order inside stepPlayer (dead player: return unchanged with attack 0):
1. `tick + 1` (all later phases see the new tick).
2. Apply `events` in array order, cap MAX_EVENTS_PER_TICK (excess silently dropped), at most ONE lock per tick (events after a lock this tick are dropped):
   - `left`/`right`: try `x ∓/± 1`; keep on collision (no-op).
   - `rotCW`/`rotCCW`: target rot = (rot ± 1 + 4) & 3; try the 5 kicks from `KICKS_*[`${rot}${target}`]` in order (O: identity, always succeeds); first non-colliding offset wins (`x += dx, y += dy`); all fail → no-op.
   - `softDrop`: try `y + 1`; on collision no-op (grounding is phase 3's job).
   - `hardDrop`: advance `y` while free, then LOCK immediately (phase 4 logic inline).
   - `hold`: if `holdUsed` no-op; else swap `piece.kind` with `hold` (empty hold → take `queue.shift()` + refill), respawn via `spawnPiece(newKind)`, `holdUsed = true`, reset fallCooldown/lockTicks/lockResets. Spawn collision → top-out (alive=false).
   - Any successful left/right/rot while `lockTicks !== null` and `lockResets < LOCK_RESETS_MAX`: `lockTicks = LOCK_DELAY_TICKS`, `lockResets + 1`.
3. Gravity: `fallCooldown - 1`; at 0 → try `y + 1`, reset `fallCooldown = gravityTicksAt(tick)`. Each `softDrop` event in phase 2 already did one extra fall attempt.
4. Grounded bookkeeping: piece grounded ⇔ `collides(board, {...piece, y: piece.y + 1})`. Grounded & `lockTicks === null` → `lockTicks = LOCK_DELAY_TICKS`. Airborne → `lockTicks = null` (lockResets KEEPS counting for this piece). Grounded → `lockTicks - 1`; at 0 → LOCK.
5. LOCK: stamp piece cells into board (value = KINDS.indexOf(kind)+1). If ALL stamped cells have y < HIDDEN_ROWS → top-out (alive=false, piece=null, return). Clear full rows (all 10 cells ≠ 0): remove, shift everything above down, `linesCleared += n`, `attack = ATTACK[n]`. Spawn `queue.shift()` (refill queue to ≥ PREVIEW+1 by bag shuffle first if needed), `holdUsed = false`, `lockResets = 0`, `lockTicks = null`, `fallCooldown = gravityTicksAt(tick)`. Spawn collision → top-out.

- [ ] **Step 1:** Write failing `test/step.test.ts`. Board-building helpers keep fixtures readable:

```ts
import { describe, expect, it } from 'vitest'
import { BOARD_W, LOCK_DELAY_TICKS, LOCK_RESETS_MAX, TOTAL_ROWS } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { stepPlayer } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { GameEvent, PlayerState } from '../src/state.js'

const P = (): PlayerState => createMatch(42, ['a','b'], [false,true]).players[0]!
// fillRow: set row y to solid (value 1) except the listed hole columns
const fillRow = (board: number[], y: number, holes: number[] = []) => {
  for (let x = 0; x < BOARD_W; x++) if (!holes.includes(x)) board[bIdx(x, y)] = 1
}
const withPiece = (p: PlayerState, kind: 'I'|'O'|'T'|'S'|'Z'|'L'|'J', rot: 0|1|2|3, x: number, y: number): PlayerState =>
  ({ ...p, piece: { kind, rot, x, y }, board: [...p.board] })
const tick = (p: PlayerState, ev: GameEvent[] = []) => stepPlayer(p, ev)

describe('movement & rotation', () => {
  it('left/right shift; blocked shift is a silent no-op', () => {
    let p = withPiece(P(), 'T', 0, 3, 10)
    expect(tick(p, ['left']).player.piece!.x).toBe(2)
    expect(tick(p, ['right']).player.piece!.x).toBe(4)
    p = withPiece(P(), 'T', 0, 0, 10)              // leftmost cell already at col 0
    expect(tick(p, ['left']).player.piece!.x).toBe(0)
  })
  it('plain CW rotation uses kick (0,0)', () => {
    const out = tick(withPiece(P(), 'T', 0, 3, 10), ['rotCW']).player.piece!
    expect(out.rot).toBe(1); expect(out.x).toBe(3); expect(out.y).toBe(10)
  })
  it('SRS wall kick: vertical T hugging the left wall rotates 1→2 via kick (+1,0)', () => {
    // T rot 1 at x=-1 is legal (occupied cells are cols x+1..x+2); plain 1→2 collides at col x+0
    const out = tick(withPiece(P(), 'T', 1, -1, 10), ['rotCW']).player.piece!
    expect(out.rot).toBe(2); expect(out.x).toBe(0); expect(out.y).toBe(10)
  })
  it('all five kicks failing leaves the piece unchanged', () => {
    const p = withPiece(P(), 'I', 1, 7, 20)        // vertical I in a col-9 shaft
    for (let y = 18; y < TOTAL_ROWS; y++) fillRow(p.board, y, [9])
    const out = tick(p, ['rotCW']).player.piece!
    expect(out).toEqual({ kind: 'I', rot: 1, x: 7, y: 20 })
  })
})

describe('gravity, soft drop, lock delay', () => {
  it('piece falls one cell every gravityTicksAt ticks (20 at tick 0)', () => {
    let p = withPiece(P(), 'T', 0, 3, 10)
    for (let i = 0; i < 19; i++) p = tick(p).player
    expect(p.piece!.y).toBe(10)
    p = tick(p).player
    expect(p.piece!.y).toBe(11)
  })
  it('each softDrop event is one immediate fall', () => {
    const p = withPiece(P(), 'T', 0, 3, 10)
    expect(tick(p, ['softDrop']).player.piece!.y).toBe(11)
    expect(tick(p, ['softDrop','softDrop']).player.piece!.y).toBe(12)
  })
  it('grounded piece locks after LOCK_DELAY_TICKS; a shift resets the timer', () => {
    let p = withPiece(P(), 'O', 0, 4, 20)          // O cells rows 20-21… move to floor: y=22 → rows 22-23
    p = withPiece(p, 'O', 0, 4, 22)
    for (let i = 0; i < LOCK_DELAY_TICKS - 1; i++) { const o = tick(p); expect(o.locked).toBe(false); p = o.player }
    const beforeReset = tick(p, ['left'])           // successful shift on the last tick → reset
    expect(beforeReset.locked).toBe(false)
    let q = beforeReset.player
    for (let i = 0; i < LOCK_DELAY_TICKS - 1; i++) q = tick(q).player
    expect(tick(q).locked).toBe(true)
  })
  it('lock-delay resets cap at LOCK_RESETS_MAX', () => {
    let p = withPiece(P(), 'O', 0, 4, 22)
    let locked = false
    // alternate left/right forever; without the cap this never locks
    for (let i = 0; i < (LOCK_RESETS_MAX + 2) * LOCK_DELAY_TICKS && !locked; i++) {
      const o = tick(p, [i % 2 ? 'left' : 'right']); locked = o.locked; p = o.player
    }
    expect(locked).toBe(true)
  })
})

describe('hard drop, clears, attack', () => {
  it('vertical I into a col-9 well clears a double and returns ATTACK[2]=1', () => {
    const p = withPiece(P(), 'I', 1, 7, 4)
    fillRow(p.board, 22, [9]); fillRow(p.board, 23, [9])
    const out = tick(p, ['hardDrop'])
    expect(out.locked).toBe(true)
    expect(out.player.linesCleared).toBe(2)
    expect(out.attack).toBe(1)
    // the two uncleared I cells slid down to the bottom of col 9
    expect(out.player.board[bIdx(9, 23)]).not.toBe(0)
    expect(out.player.board[bIdx(0, 23)]).toBe(0)   // cleared rows really gone
    expect(out.player.piece).not.toBeNull()          // next piece spawned
  })
  it('single clears send nothing; tetris sends 4', () => {
    const single = withPiece(P(), 'I', 0, 0, 22)     // horizontal I lands on row 23, completing it (cols 0-3 were the holes)
    fillRow(single.board, 23, [0,1,2,3])
    expect(tick(single, ['hardDrop']).attack).toBe(0)
    const tetris = withPiece(P(), 'I', 1, 7, 4)
    for (let y = 20; y < 24; y++) fillRow(tetris.board, y, [9])
    const out = tick(tetris, ['hardDrop'])
    expect(out.player.linesCleared).toBe(4); expect(out.attack).toBe(4)
  })
})

describe('hold & top-out', () => {
  it('hold swaps, locks out until next spawn', () => {
    const p = P()
    const firstKind = p.piece!.kind, nextKind = p.queue[0]!
    const held = tick(p, ['hold']).player
    expect(held.hold).toBe(firstKind); expect(held.piece!.kind).toBe(nextKind); expect(held.holdUsed).toBe(true)
    expect(tick(held, ['hold']).player.piece!.kind).toBe(nextKind)  // second hold ignored
  })
  it('spawn into an occupied buffer = top-out', () => {
    // TWO holes per row (cols 0,1) so nothing clears; vertical I locks in the col-0 shaft, next spawn is blocked
    const p = withPiece(P(), 'I', 1, -2, 20)               // rot-1 I occupies col x+2 = 0, rows 20-23
    for (let y = 2; y < 24; y++) fillRow(p.board, y, [0, 1])
    const out = tick(p, ['hardDrop'])                       // already at the floor → locks, no full rows, spawn cells occupied
    expect(out.player.linesCleared).toBe(0)
    expect(out.player.alive).toBe(false)
  })
  it('a piece locking entirely inside the hidden buffer = top-out', () => {
    const p = withPiece(P(), 'O', 0, 4, 2)                  // O at spawn height, rows 2-3
    for (let y = 4; y < 24; y++) fillRow(p.board, y, [0, 1]) // stack reaches the buffer; two holes → no clears
    const out = tick(p, ['hardDrop'])                       // grounded immediately on row 4 → locks at rows 2-3 (all y < 4)
    expect(out.player.alive).toBe(false)
  })
  it('stepPlayer never mutates its input', () => {
    const p = withPiece(P(), 'T', 0, 3, 10)
    const snap = JSON.stringify(p)
    stepPlayer(p, ['left', 'rotCW', 'softDrop'])
    expect(JSON.stringify(p)).toBe(snap)
  })
})
```

(Fixture-geometry note, the standing house rule: the SEMANTICS in the phase list are the pin. If a hand-traced coordinate is off — e.g., the O-piece floor y — fix the TEST COORDS with the reasoning stated in the test, never bend the reducer to a bad literal.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement step.ts phases 1-5. **Step 4:** Run → PASS, full suite green. **Step 5:** Ledger + commit `feat(block-core): stepPlayer — gravity, SRS moves, lock delay, clears, hold, top-out`.

---

### Task 3: garbage + cancellation + sudden death + offline step() + result + killPlayer

**Files:** Modify `packages/block-core/src/step.ts`. Create `packages/block-core/test/garbage.test.ts`. Modify `src/index.ts`.

**Interfaces (Consumes):** Task 2 stepPlayer. **Produces:**
```ts
export function queueGarbage(p: PlayerState, rows: number, holeCol: number): PlayerState // pure push to pendingGarbage
export function killPlayer(p: PlayerState): PlayerState                                   // alive=false, piece=null (grace forfeit)
export function step(m: MatchState, events: [GameEvent[], GameEvent[]]): MatchState       // offline/golden wrapper
export function suddenDeathHole(k: number): number                                        // (5 + 3*k) % 10 — pinned formula
```
Additions inside stepPlayer (extending Task 2's phases):
- Phase 5 LOCK extension: after computing raw `attack = ATTACK[n]`, cancel 1:1 against `pendingGarbage` (consume entries FIFO, partial entries shrink), `linesSent += remaining attack`; returned `attack` = the remainder. THEN, if `pendingGarbage` still non-empty, materialize ALL of it now: for each entry in order, shift the whole board UP by `entry.rows` (cells pushed above row 0 vanish), fill the vacated bottom rows with GARBAGE cells with `holeCol` empty. The active (just-spawned) piece is unaffected (it lives in the buffer rows).
- New phase 6 (sudden death, per-OWN-clock): if `tick ≥ SUDDEN_DEATH_TICK && (tick - SUDDEN_DEATH_TICK) % SUDDEN_DEATH_INTERVAL === 0` → immediately materialize 1 garbage row with hole `suddenDeathHole((tick - SUDDEN_DEATH_TICK) / SUDDEN_DEATH_INTERVAL)` (bypasses pendingGarbage, uncancellable). If the shift pushes the ACTIVE piece into collision, move the piece up until free; can't → top-out.
- `step(m, events)`: stepPlayer both players in id order; if player i's StepOut.attack > 0 → roll `holeCol = floor(randStep(garbageRng).value * BOARD_W)` (thread garbageRng) and `queueGarbage(opponent, attack, holeCol)`. Result stamp (set once, never overwritten): both newly dead → draw; one dead → win by the other; else carry.

- [ ] **Step 1:** Write failing `test/garbage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BOARD_W, GARBAGE, SUDDEN_DEATH_INTERVAL, SUDDEN_DEATH_TICK } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { killPlayer, queueGarbage, step, stepPlayer, suddenDeathHole } from '../src/step.js'
import { bIdx } from '../src/state.js'
import type { PlayerState } from '../src/state.js'

const M = () => createMatch(42, ['a','b'], [false,true])
const fillRow = (board: number[], y: number, holes: number[] = []) => {
  for (let x = 0; x < BOARD_W; x++) if (!holes.includes(x)) board[bIdx(x, y)] = 1
}

describe('pending garbage', () => {
  it('materializes at the victim own next lock: rows rise, hole column open, stack shifted up', () => {
    let p: PlayerState = { ...M().players[0]!, piece: { kind: 'O', rot: 0, x: 4, y: 22 } , board: [...M().players[0]!.board] }
    p.board[bIdx(0, 23)] = 3                              // a marker cell to watch shift up
    p = queueGarbage(p, 2, 3)
    const out = stepPlayer(p, ['hardDrop'])
    expect(out.player.pendingGarbage).toEqual([])
    for (const y of [22, 23]) for (let x = 0; x < BOARD_W; x++)
      expect(out.player.board[bIdx(x, y)]).toBe(x === 3 ? 0 : GARBAGE)
    expect(out.player.board[bIdx(0, 21)]).toBe(3)         // marker moved up 2
  })
  it('attack cancels pending 1:1 before sending; remainder materializes', () => {
    let p: PlayerState = { ...M().players[0]!, piece: { kind: 'I', rot: 1, x: 7, y: 4 }, board: [...M().players[0]!.board] }
    fillRow(p.board, 22, [9]); fillRow(p.board, 23, [9])  // double coming → raw attack 1
    p = queueGarbage(p, 2, 3)
    const out = stepPlayer(p, ['hardDrop'])
    expect(out.attack).toBe(0)                            // 1 attack swallowed by 2 pending
    expect(out.player.linesSent).toBe(0)
    // 1 pending row remains and materializes at this same lock:
    for (let x = 0; x < BOARD_W; x++) expect(out.player.board[bIdx(x, 23)]).toBe(x === 3 ? 0 : GARBAGE)
  })
})

describe('sudden death', () => {
  it('from SUDDEN_DEATH_TICK a neutral row lands every interval at the pinned hole', () => {
    let p: PlayerState = { ...M().players[0]!, tick: SUDDEN_DEATH_TICK - 1 }
    const out = stepPlayer(p, [])
    expect(out.player.tick).toBe(SUDDEN_DEATH_TICK)
    for (let x = 0; x < BOARD_W; x++) expect(out.player.board[bIdx(x, 23)]).toBe(x === suddenDeathHole(0) ? 0 : GARBAGE)
    expect(suddenDeathHole(0)).toBe(5); expect(suddenDeathHole(1)).toBe(8); expect(suddenDeathHole(2)).toBe(1)
  })
  it('interval spacing: no second row until +SUDDEN_DEATH_INTERVAL', () => {
    let p: PlayerState = { ...M().players[0]!, tick: SUDDEN_DEATH_TICK - 1 }
    p = stepPlayer(p, []).player
    for (let i = 0; i < SUDDEN_DEATH_INTERVAL - 1; i++) p = stepPlayer(p, []).player
    const rows23to22 = [22, 23].map((y) => p.board.slice(y * BOARD_W, (y + 1) * BOARD_W).filter((c) => c === GARBAGE).length)
    expect(rows23to22[1]).toBeGreaterThan(0)              // first row present
    // second arrives exactly on the next boundary:
    const before22 = rows23to22[0]
    p = stepPlayer(p, []).player
    expect(p.board.slice(22 * BOARD_W, 23 * BOARD_W).filter((c) => c === GARBAGE).length).toBeGreaterThan(before22!)
  })
})

describe('offline step() routing + result', () => {
  it('p0 double → p1 pendingGarbage 1 row with a seeded hole', () => {
    const m = M()
    m.players[0] = { ...m.players[0]!, piece: { kind: 'I', rot: 1, x: 7, y: 4 }, board: [...m.players[0]!.board] }
    fillRow(m.players[0]!.board, 22, [9]); fillRow(m.players[0]!.board, 23, [9])
    const out = step(m, [['hardDrop'], []])
    expect(out.players[1]!.pendingGarbage).toHaveLength(1)
    expect(out.players[1]!.pendingGarbage[0]!.rows).toBe(1)
    expect(out.players[0]!.linesSent).toBe(1)
    expect(out.garbageRng).not.toBe(m.garbageRng)
  })
  it('result stamps once: kill p1 → p0 wins; both dead same step → draw', () => {
    const m = M()
    const won = step({ ...m, players: [m.players[0]!, killPlayer(m.players[1]!)] }, [[], []])
    expect(won.result).toEqual({ kind: 'win', winner: 0 })
    const draw = step({ ...m, players: [killPlayer(m.players[0]!), killPlayer(m.players[1]!)] }, [[], []])
    expect(draw.result).toEqual({ kind: 'draw' })
    // never overwritten:
    expect(step(won, [[], []]).result).toEqual({ kind: 'win', winner: 0 })
  })
})
```

(Check `suddenDeathHole` pins by the formula: (5+0)%10=5, (5+3)%10=8, (5+6)%10=11%10=1.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, Task 2 tests still green (raw-attack fixtures had empty pendingGarbage), full suite green. **Step 5:** Ledger + commit `feat(block-core): garbage queue/cancel/materialize, sudden death, offline step, result`.

---

### Task 4: golden master

**Files:** Create `packages/block-core/test/golden.test.ts`.

**Interfaces (Consumes):** createMatch, step. Bots NOT in this path (hash stays bot-free — the house ordering).

- [ ] **Step 1:** Write the test with a placeholder hash (fnv1a helper copied from snakewait's golden test):

```ts
import { expect, it } from 'vitest'
import { createMatch } from '../src/match.js'
import { step } from '../src/step.js'
import type { GameEvent } from '../src/state.js'

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}
// Two scripted humans: rotations, shifts, holds, soft/hard drops on a fixed cadence.
// Every 31 ticks p0 acts, every 37 ticks p1 acts (coprime cadences exercise interleaving);
// action cycles through this tape:
const TAPE: GameEvent[] = ['rotCW','left','left','softDrop','hardDrop','hold','right','rotCCW','hardDrop']
it('golden master: seed 7 + scripted duel → pinned state hash at tick 600', () => {
  let m = createMatch(7, ['a','b'], [false,false])
  let i0 = 0, i1 = 0
  for (let t = 1; t <= 600; t++) {
    const e0: GameEvent[] = t % 31 === 0 ? [TAPE[i0++ % TAPE.length]!] : []
    const e1: GameEvent[] = t % 37 === 0 ? [TAPE[i1++ % TAPE.length]!] : []
    m = step(m, [e0, e1])
  }
  expect(fnv1a(JSON.stringify(m))).toBe('RECORD_ME') // record from an actual green run; re-record + note why on intended changes
})
```

- [ ] **Step 2:** Run → FAIL with the actual hash in the assertion diff. **Step 3:** Pin the printed hash (a RECORDING, not an oracle — say so in the commit). **Step 4:** Run twice → PASS both. Suite green. **Step 5:** Ledger + commit `test(block-core): golden master pinned`.

---

### Task 5: bots — placement enumeration + 4-term heuristic

**Files:** Create `packages/block-core/src/bot.ts`, `packages/block-core/test/bot.test.ts`. Modify `src/index.ts`.

**Interfaces (Consumes):** PlayerState, stepPlayer/step (tests). **Produces:**
```ts
export type Difficulty = 'easy' | 'normal' | 'hard'
export interface BotMind { rng: number; plan: GameEvent[]; planForPiece: number; nextEventTick: number }
export function createBotMind(seed: number): BotMind
export function botDecide(p: PlayerState, mind: BotMind, d: Difficulty): { events: GameEvent[]; mind: BotMind }
// weights (El-Tetris/Lee, published): W_HEIGHT=-0.510066, W_LINES=0.760666, W_HOLES=-0.35663, W_BUMP=-0.184483
// cadence (ticks per emitted event): easy 8 / normal 4 / hard 2; EASY_TOP3_RATE = 0.25
```
Decision logic: when `mind.plan` is empty for the current piece (track via a piece counter on PlayerState stats or planForPiece = linesCleared+pieces placed — simplest: recompute when plan empty AND piece airborne-fresh), enumerate placements: for each rot 0-3 and each x where `cellsAt(kind, rot, x, spawnY)` is in-bounds and collision-free at spawn height, drop y until collision, stamp, score = `W_HEIGHT·Σ colHeights + W_LINES·fullRows + W_HOLES·holes + W_BUMP·Σ|h[i]-h[i+1]|` (heights/holes computed over the post-clear board). `hard` also enumerates the hold-swap piece (prefix plan with `hold` if it wins). `easy`: with probability 0.25 (randStep on mind.rng) pick uniformly among the top-3 scores instead of the best. Plan = rotations (`rot` diff as 1×rotCW / 2×rotCW / 1×rotCCW) then shifts (sign of dx, one event per cell) then `hardDrop`. Emission: one event from the plan every cadence ticks (`nextEventTick` bookkeeping); between events `{events: []}`.

- [ ] **Step 1:** Write failing `test/bot.test.ts`:

```ts
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
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement bot.ts. **Step 4:** Run → PASS (if a gate fails, the BOT is wrong — fix the bot, never loosen the gate). Golden hash UNCHANGED. Suite green. **Step 5:** Ledger + commit `feat(block-core): duel bots — placement enumeration + pinned heuristic + liveness gates`.

---

### Task 6: wire protocol — hex-row codec, batches, caps, parsers

**Files:** Create `packages/block-core/src/protocol.ts`, `packages/block-core/test/protocol.test.ts`. Modify `src/index.ts`.

**Interfaces (Produces):**
```ts
export const MAX_RAW = 4096
export const LEAD_TICKS = 5          // client may run at most this far ahead of server wall clock
export const LAG_TICKS = 25          // further behind → server force-advances with empty inputs
export const BATCH_TICKS = 5         // client batch cadence
export interface HelloMsg { t: 'hello'; name: string }
export interface InputMsg { t: 'input'; seq: number; upTo: number; events: [number, number][] } // [tick, eventCode]
export interface StartMsg { t: 'start'; you: number; seed: number; names: string[]; bots: boolean[] }
export interface SnapMsg { t: 'snap'; state: WireState }
export interface GarbageMsg { t: 'garbage'; rows: number; holeCol: number; atTick: number } // atTick on the VICTIM's own clock
export interface EndMsg { t: 'end'; result: [0, number] | [1] }   // [0,winner] | [1]=draw
export type BlockClientMsg = HelloMsg | InputMsg
export type BlockServerMsg = StartMsg | SnapMsg | GarbageMsg | EndMsg
// WirePlayer round-trips the FULL PlayerState (resync needs it):
// [id, name, bot, alive, tick, boardRows(24 hex strings, 10 nibbles: 0 empty/1-7 kind/8 garbage, index 0 = top),
//  piece [kindCode(1-7), rot, x, y] | 0, queueCodes: number[], bagRng, holdCode(0=none), holdUsed(0|1),
//  fallCooldown, lockTicks(-1=null), lockResets, pending: [rows, holeCol][], linesCleared, linesSent]
export type WirePlayer = [number, string, number, number, number, string[], [number,number,number,number] | 0,
  number[], number, number, number, number, number, number, [number, number][], number, number]
export interface WireState { players: [WirePlayer, WirePlayer]; garbageRng: number; result: [0, number] | [1] | null }
export function sanitizeHandle(raw: string): string   // copy snake-core's rules verbatim (read packages/snake-core/src/protocol.ts)
export function toWire(m: MatchState): WireState
export function fromWire(w: WireState): MatchState
export function toWirePlayer(p: PlayerState): WirePlayer
export function fromWirePlayer(w: WirePlayer): PlayerState
export function parseBlockClientMsg(raw: unknown): BlockClientMsg | null   // size cap + shape checks; null on ANY violation
export function parseBlockServerMsg(raw: unknown): BlockServerMsg | null
```
Hardening pins (the boomwait patterns + the snakewait fromWire lesson): string fields length-capped (name ≤ 24 post-sanitize), board must be exactly 24 rows × 10 hex chars `[0-8]`, queue length ≤ 16, pending entries ≤ 40 with rows ≤ 20 each, coords/rot range-checked, InputMsg events ≤ BATCH_TICKS*MAX_EVENTS_PER_TICK entries with codes 0-6 and ticks ≤ upTo, all numerics finite integers, anything malformed → null, validators rebuild FRESH literals. No literal control bytes in the test file.

- [ ] **Step 1:** Write failing `test/protocol.test.ts` covering: `fromWire(toWire(m))` deep-equals m for (a) a fresh createMatch and (b) a mid-duel state (run the Task 4 golden loop to tick 300 and round-trip THAT); hex-row codec spot pin (a board with cell (0,23)=8 and (9,4)=1 → row strings match by hand); snapshot size pin — worst case: both boards fully non-empty in a 1-8 nibble checkerboard, queues of 16, 40 pending entries, 24-char names → `JSON.stringify({t:'snap',state:toWire(worst)}).length < 2048`... if the worst case exceeds 2048 the CAP LITERALS above are wrong — shrink queue/pending caps in protocol.ts and this test together, never raise 2048 (it is the family-wide envelope pin); parser rejects: raw > MAX_RAW, event code 7, event tick > upTo, board row `'zzzzzzzzzz'`, board of 23 rows, name 300 chars, seq -1, non-JSON garbage, valid-JSON-wrong-shape; parser accepts a legal InputMsg and a legal round-tripped SnapMsg.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(block-core): wire protocol — hex-row codec, event batches, hardened parsers`.

---

### Task 7: server DOs (existing worker) + wrangler migration v5

**Files:** Create `packages/server/src/block-lobby.ts`, `packages/server/src/block-match.ts`, `packages/server/test/block.test.ts`. Modify `packages/server/src/index.ts` (routes + DO exports), `packages/server/wrangler.jsonc` (bindings `BLOCK_LOBBY`, `BLOCK_MATCH` + APPENDED migration `{ "tag": "v5", "new_sqlite_classes": ["BlockLobbyDO", "BlockMatchDO"] }` — v1–v4 untouched), `packages/server/package.json` (add `"blockwait-core": "0.0.0"` workspace dep — pinned to the real version at release).

**Interfaces (Consumes):** blockwait-core Tasks 1-6. **Produces:** `POST /block/join {name}` → `{ matchId, token }` after the gather window (resolves EARLY at 2 humans; 1 bot backfills otherwise); `GET /block/match/:id/ws?token=`. Join returns **400** on missing/malformed body or absent `name` (the snakewait CF-1101 lesson — read how bomber's join tolerates it and do better: explicit 400).

The per-player-clock host loop (BlockMatchHost, pure class + BlockMatchDO wrapper — the bomber/snake split):
- Wall clock: 50ms alarm; `wallTick + 1` per alarm.
- Human slots: buffered InputMsg batches applied in seq order: validate (seq/upTo strictly monotonic, events in (lastUpTo, upTo], ≤ MAX_EVENTS_PER_TICK per tick, upTo ≤ wallTick + LEAD_TICKS — violating batch DROPPED silently), then advance that player's board tick-by-tick from its current tick to `upTo` via stepPlayer (events at their stamped ticks, empty elsewhere).
- Force-advance: after applying batches, any ALIVE player whose `tick < wallTick - LAG_TICKS` is advanced to `wallTick - LAG_TICKS` with empty events (gravity + sudden death still run → the end bound holds online).
- Bot slot: advanced to wallTick every alarm with botDecide events (mind server-side, difficulty 'normal').
- Attack routing: every StepOut with attack > 0 → roll holeCol from the host's garbageRng (randStep, same formula as core step()), `queueGarbage(victim)` **at the victim's current own tick**, and send that victim's socket `{t:'garbage', rows, holeCol, atTick: victimTickAtQueue}`.
- Result: after each alarm sweep — newly-dead players collected; both in one sweep → draw, one → win by the other; stamp once; broadcast `end`; tombstone.
- Snaps: every 5 alarms (4Hz) broadcast `{t:'snap', state: toWire(hostMatchState)}`.
- Disconnect → 5s grace → `killPlayer` through the host state (forfeit); 'empty' stop when no sockets; monotonic connId + start-time compaction; start-deadline backfill (the no-show lesson).

- [ ] **Step 1:** Read `packages/server/src/{snake-lobby.ts,snake-match.ts}` and `packages/server/test/snake.test.ts` FIRST — block follows those shapes with the loop swapped for the per-player-clock model above.
- [ ] **Step 2:** Failing tests (mirror snake.test.ts's structure): 2 joiners → resolve immediately with humanCount 2; 1 human after window → 1 'normal' bot; join with `{}` body or no body → **400** (not a throw); an InputMsg batch moves that player's piece (assert via next snap board/piece position); a batch with upTo > wallTick + LEAD_TICKS is dropped (state unchanged); a silent player is force-advanced (tick grows without batches); a scripted double on p0's board lands 1 pendingGarbage row on p1 AND p1's socket receives a garbage msg with matching holeCol/atTick; oversized/garbage messages dropped without crashing; disconnect → grace → forfeit end msg; wrangler.jsonc literal test — tags v1,v2,v3,v4,v5 in order, v1-v4 byte-identical to the committed file (extend snake's pattern).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement (BlockLobbyDO from snake-lobby's queue shape with fill-at-2; BlockMatchHost pure + BlockMatchDO wrapper; routes under `/block/...`). Build core first: `npm run build -w blockwait-core` (stale-dist rule). **Step 5:** PASS, full suite green, `npx tsc -p packages/server/tsconfig.json --noEmit` clean. NO DEPLOY — user-gated at release. Ledger + commit `feat(server): block duel lobby + per-player-clock match DO, migration v5`.

---

### Task 8: client scaffold + renderer (frame-fit + raw-framing pins FIRST)

**Files:** Create `packages/block-client/{package.json,tsconfig.json,bin/blockwait.js,src/render.ts,test/render.test.ts}`.

**Interfaces (Consumes):** blockwait-core state/constants, termwait `ColorMode`. **Produces:**
```ts
export interface Layout { cols: number; rows: number }                    // k=1 only in v1; carries centering pad
export function chooseLayout(cols: number, rows: number): Layout | null  // null when < 80x24
export function renderFrame(m: MatchState, you: number, layout: Layout, statusLine: string, mode: ColorMode): string
export function tooSmallScreen(cols: number, rows: number): string
export function ghostY(board: number[], piece: ActivePiece): number      // hard-drop landing y (renderer + bot reuse candidate)
```
package.json: `"name": "blockwait"`, `"version": "0.0.0"`, `"bin": {"blockwait": "bin/blockwait.js"}`, deps `{"blockwait-core": "0.0.0", "termwait": "0.1.0", "ws": "8.21.0"}`. bin: `#!/usr/bin/env node` + `import('../dist/cli.js')`.

Rendering rules (spec, restated): one cell = 2 chars. Row layout (23 lines total): line 0 = top borders of both boards + HUD title; lines 1-20 = board rows (visible board rows 4-23) with 1-char side borders; line 21 = bottom borders; line 22 = status line. Column layout: cols 0-21 YOUR board (`│` + 20 + `│`), cols 22-57 HUD (36), cols 58-79 opponent. Every line rendered to EXACTLY 80 visible cols (fixed-width concat — padHud is pure fixed-width, the snakewait Task 8 lesson). Piece colors truecolor RGB: I(0,255,255) O(255,255,0) T(160,80,255) S(0,220,80) Z(255,70,70) L(255,160,0) J(80,120,255), garbage (130,130,130); 256-mode nearest xterm indices (pin the 8 chosen indices as literals); mono glyphs per kind `II OO TT SS ZZ LL JJ`, garbage `▒▒`, NO escapes at all in mono. Active piece cells bright; ghost at `ghostY` as dim `··` (skip cells overlapping the real piece). HUD: names + alive marks, hold box + next-3 as 4x2-cell minis, `incoming: N` garbage meter (red when > 0), lines/sent, clock `mm:ss` from `players[you].tick/TICK_RATE`, gravity level number, `SUDDEN DEATH` flag when past tick 2400, key hints. Frame tail: positional escapes exactly like snake-client post-8f417db — `ESC[H ESC[K` head, lines joined `\r\n ESC[K`, trailing `ESC[J` (transcribe from `packages/snake-client/src/render.ts`, the frozen reference).

- [ ] **Step 1:** Write the FRAME-FIT + framing test before any rendering code:

```ts
import { describe, expect, it } from 'vitest'
import { createMatch } from 'blockwait-core'
import { chooseLayout, renderFrame, tooSmallScreen } from '../src/render.js'

const STRIP = /\x1b\[[0-9;]*[A-Za-z]/g
const frameLines = (f: string) => f.replace(/\x1b\[[HKJ]/g, '').split('\r\n').map((l) => l.replace(STRIP, ''))

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  const m = createMatch(7, ['jeremiah', 'rival'], [false, true])
  it('exact fit at 80x24: 23 lines, EVERY line exactly 80 visible cols', () => {
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 'claude is working…', 'truecolor')
    const lines = frameLines(frame)
    expect(lines.length).toBe(23)
    for (const l of lines) expect(l.length, JSON.stringify(l)).toBe(80)
    expect(lines.some((l) => l.includes('jeremiah'))).toBe(true)
    expect(lines.some((l) => l.includes('rival'))).toBe(true)
  })
  it('below 80x24 → null layout; bigger stays k=1 (no scaling in v1)', () => {
    expect(chooseLayout(79, 24)).toBeNull(); expect(chooseLayout(80, 23)).toBeNull()
    expect(chooseLayout(200, 60)).not.toBeNull()
  })
  it('raw positional framing (the 813d2a9/8f417db pins): ESC[H home, ESC[K at line START, ESC[J tail', () => {
    const frame = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'truecolor')
    expect(frame.startsWith('\x1b[H\x1b[K')).toBe(true)
    expect(frame.includes('\r\n\x1b[K')).toBe(true)
    expect(frame.endsWith('\x1b[J')).toBe(true)
    expect(/\x1b\[K(\x1b\[[0-9;]*m)*\s*$/m.test(frame.split('\r\n').at(-2) ?? '')).toBe(false) // no trailing ESC[K on content lines
    const tooSmall = tooSmallScreen(79, 24)
    expect(tooSmall.startsWith('\x1b[H\x1b[K')).toBe(true); expect(tooSmall.endsWith('\x1b[J')).toBe(true)
  })
  it('color tiers: mono has zero escapes beyond framing; 256 uses 38;5; and never 38;2;', () => {
    const mono = renderFrame(m, 0, chooseLayout(80, 24)!, 's', 'mono').replace(/\x1b\[[HKJ]/g, '')
    expect(mono.includes('\x1b')).toBe(false)
    const c256 = renderFrame(m, 0, chooseLayout(80, 24)!, 's', '256')
    expect(c256.includes('38;5;')).toBe(true); expect(c256.includes('38;2;')).toBe(false)
  })
})
```

Additional render tests in the same file: ghost cells appear at `ghostY` for an empty board (piece at spawn → ghost at the floor); a board cell set to GARBAGE renders in every mode (mono `▒▒`); `incoming` count visible in the HUD when pendingGarbage non-empty; `ghostY` unit pins (empty board T rot 0 x=3 → lands so its bottom row is 23; over a full row 23 → one higher).

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement render.ts (read `packages/snake-client/src/render.ts` FIRST for framing + ColorMode threading + padHud discipline; block's compositor is simpler — 2-char cells, no half-blocks). **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(blockwait): renderer with asserted 80x24 frame + raw framing pins`.

---

### Task 9: input + session glue + offline loop + CLI + vtsim gate (playable offline milestone)

**Files:** Create `packages/block-client/src/{input-queue.ts,game.ts,offline.ts,share.ts,cliArgs.ts,cli.ts,main.ts}`, `packages/block-client/test/{input-queue.test.ts,cliArgs.test.ts,share.test.ts,vt.test.ts}`, `packages/block-client/test/vtsim.ts`.

**Interfaces (Consumes):** Task 8 render, blockwait-core (createMatch/step/botDecide/TICK_RATE), termwait everything. **Produces:**
```ts
// input-queue.ts — ordered event queue (NOT a latch: taps are discrete, order matters)
export interface QueueState { events: GameEvent[] }
export function createQueue(): QueueState
export function onKey(q: QueueState, e: KeyEvent): QueueState
// key map: left/a→left, right/d→right, up/w/x→rotCW, z→rotCCW, down/s→softDrop, space→hardDrop, c→hold
// press AND repeat both push (OS auto-repeat = DAS/soft-drop rate); release ignored; queue hard-capped at MAX_EVENTS_PER_TICK
export function drain(q: QueueState): { events: GameEvent[]; next: QueueState }
// game.ts — snake-client's game.ts shape (read packages/snake-client/src/game.ts): REDRAW_MS, GameSession
// (term/parser/colorMode/layout()/drainEvents()/statusLine()/quitRequested()/onResize/dispose), setupGame,
// resultLine(result, you, names?), teardownAndExit — transcribed with Input swapped for GameEvent[]
// offline.ts
export async function runOffline(opts: { difficulty: Difficulty; name: string; seed: number }): Promise<Result>
// share.ts
export function shareCard(result: Result, you: number, ownTick: number, lines: number, sent: number, opponentHandle: string): string
// cliArgs.ts — snake's parseArgs surface verbatim (offline/name/server/seed/difficulty; DEFAULT_SERVER unchanged)
```
offline loop = snake's offline.ts shape: 50ms interval, `step(m, [drainedEvents, botEvents])`, bot mind seeded `(seed + 1) >>> 0`, quit/result exits, finale + share card through teardownAndExit. `layout() === null` → tooSmallScreen + keep polling. Track `lastLines`/`lastSent` while alive for the share card (the b985dc8 lesson — never read post-death state). cli.ts: both paths offline until Task 10 (non-offline prints a note).

**The vtsim gate** (promoted from snakewait's scratchpad, ledger LESSON progress.md:268): `test/vtsim.ts` — a ~90-line VT terminal simulator class: `new VtSim(cols, rows)`, `feed(chunk: string)`, `frames(): string[][]`. Handles: `ESC[H` (home, frame boundary — snapshot the current grid into frames[]), `ESC[r;cH` (cursor position), `ESC[K` (clear to EOL), `ESC[J` (clear below), `\r`/`\n`, SGR sequences skipped, printable chars advance the cursor with pending-wrap semantics at the last column (the col-80 defect surface — model it: writing col 80 sets pending-wrap instead of advancing). `test/vt.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { VtSim } from './vtsim.js'

describe('positional-escape gate (the feel-gate-only surface, now a test)', () => {
  it('headless offline run produces homed, in-bounds 80x24 frames from the REAL binary', async () => {
    // REQUIRES built dist (npm run build -w blockwait) — the stale-dist rule
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile('node', ['packages/block-client/bin/blockwait.js', '--offline', '--seed', '1'],
        { env: { ...process.env, COLUMNS: '80', LINES: '24', TERM: 'xterm-256color' }, timeout: 8000, killSignal: 'SIGTERM' },
        (err, stdout) => (stdout.length > 0 ? resolve(stdout) : reject(err)))
      setTimeout(() => child.kill('SIGTERM'), 3000)
      child.stdin?.end()
    })
    const sim = new VtSim(80, 24)
    sim.feed(out)
    const frames = sim.frames()
    expect(frames.length).toBeGreaterThan(10)                       // repainting, not scrolling
    for (const frame of frames.slice(2)) {
      expect(frame.length).toBeLessThanOrEqual(24)
      for (const row of frame) expect(row.length).toBeLessThanOrEqual(80)
    }
    // column-80 defect probe: the last visible column of full-width rows survives
    const last = frames.at(-1)!
    expect(last.some((row) => row.trimEnd().length === 80)).toBe(true)
  })
})
```

(If the binary needs a TTY and refuses to draw headless, mirror how snake's headless capture worked — `progress.md:268`: pipe stdin from `(sleep 3; printf 'x')` and force the draw path; adjust the spawn, keep the assertions.)

- [ ] **Step 1:** Failing tests: input-queue (each mapped key pushes its event; order preserved; repeat pushes again; unmapped key ignored; cap at 8; drain empties), cliArgs (defaults, --offline, --name, --seed, --server, --difficulty, unknown flag → usage error), share (outcome word, `m:ss`, lines/sent, opponent handle, ≤ 280 chars).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (game.ts/offline.ts transcribed from snake-client's — read those files first; they encode the exit-guard, resize, TDZ, and teardown lessons). **Step 4:** `npm run build -w blockwait` (vtsim needs dist), write vtsim.ts + vt.test.ts, run → PASS. **Step 5:** Full suite green. Ledger + commit `feat(blockwait): offline duel vs bot — input queue, session glue, CLI, vtsim gate`.

---

### Task 10: net + online loop (local own-board sim + resync)

**Files:** Create `packages/block-client/src/{net.ts,online.ts}`, `packages/block-client/test/{net.test.ts,online.test.ts}`. Modify `src/cli.ts` (default = online, offline fallback).

**Interfaces (Consumes):** protocol (Task 6), game.ts (Task 9). **Produces:**
```ts
// net.ts — snake's net.ts shape (read packages/snake-client/src/net.ts): ws factory seam, join POST, connect-resolves-on-start
export async function joinBlockMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> // POST /block/join
export class BlockNetClient { static connect(...): Promise<{ client; start: StartMsg }>; sendInput(msg: InputMsg): void; close(): void }
// online.ts
export async function runOnline(opts: { name?: string; server: string }): Promise<Result | 'fallback'>
// exported for tests:
export function batchDue(tick: number): boolean                       // tick % BATCH_TICKS === 0
export function shouldAdoptSnap(local: PlayerState, snapYou: PlayerState, resyncFlag: boolean): boolean
```
online.ts loop (50ms interval): local `you: PlayerState` stepped every tick with drained events (`stepPlayer` — full local feel); accumulate `[tick, code]` pairs; every BATCH_TICKS send `{t:'input', seq: seq++, upTo: localTick, events: accumulated}` and clear. Opponent board: rendered from the latest snap's other WirePlayer (`fromWirePlayer`). Garbage msgs: `atTick > localTick` → schedule (apply `queueGarbage` when the local clock reaches atTick); `atTick ≤ localTick` → set `resyncFlag`. Snap handling — `shouldAdoptSnap` pins the THREE adoption triggers: (1) `resyncFlag` set, (2) `snapYou.tick ≥ local.tick` (server force-advanced us), (3) `snapYou.alive === false`. Adopt = hard-replace local PlayerState from the snap (and clear resyncFlag/unsent events older than the snap tick). Otherwise local wins. Result precedence `end ?? synthesized-from-snap ?? closedEarly-loss` and finale/lastStats/names threading transcribed from snake's online.ts (read it first — TDZ hoist, quit-sends-nothing, socket close = forfeit via server grace). cli.ts: no --offline → online, join/connect failure → offline fallback with a note.

- [ ] **Step 1:** Failing tests with a scriptable FakeWs (transcribe snake's harness): join ok/non-2xx/timeout; connect resolves on start, rejects on pre-start close; batches sent every BATCH_TICKS with correct seq/upTo/event stamps and cleared after send; garbage future → applied exactly at atTick (assert pendingGarbage appears when local clock hits it); garbage past → next snap adopted; `shouldAdoptSnap` truth table (all three triggers + the local-wins default); opponent renders from snap without touching local you-state; finale non-vacuity under fake timers (the d187fe5 lesson — prove the finale block runs: chain-invert quitRequested).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green, `npm run build -w blockwait` clean. **Step 5:** Ledger + commit `feat(blockwait): online duel — local sim + input batches + pinned resync triggers`.

---

### Task 11: plugin + README

**Files:** Modify `plugin/test/launcher.test.sh` (a FIVE-entry synthetic fixture rotation case — real games.json untouched until release), `README.md` (blockwait section following the snakewait section's format).

- [ ] **Step 1:** Extend the launcher test: five-entry fixture asserting rotation 1→2→3→4→5→1 + exact `npx -y blockwait@0.1.0` passthrough via recorded tmux argv (synthetic pin — inline comment saying the real pin lands at release, the Task-11 lesson). Run STANDALONE `bash plugin/test/launcher.test.sh` (~30s bound) → PASS.
- [ ] **Step 2:** README: one section — what it is, controls (arrows/wasd, z/x rotate, space drop, c hold), `npx -y blockwait` / `--offline`, the 80x24 note, attack table one-liner. Re-derive every numeric claim from constants.ts (the boomwait duration incident): sudden death at 2:00, forced end by ~3:40, gravity 1 cell/s → 10 cells/s.
- [ ] **Step 3:** Full suite green. Ledger + commit `chore(plugin): launcher 5-game rotation test + blockwait README`.

---

### Task 12: snake server hygiene (folded FIX-LATER — worker code only, no frozen packages)

**Files:** Modify `packages/server/src/index.ts` (or snake-lobby.ts, wherever `/snake/join` body parsing lives), `packages/server/test/snake.test.ts`.

Two review-verified items from the snakewait ledger (progress.md:265 + :271):

- [ ] **Step 1:** Failing test: `POST /snake/join` with body `{}`, with no body, and with non-JSON → **400** response (currently throws CF 1101). Mirror Task 7's block-join 400 test shape.
- [ ] **Step 2:** Fix the snake join handler: parse defensively, absent/invalid `name` → 400 (match the block route's implementation from Task 7 exactly — same helper if one was extracted).
- [ ] **Step 3:** De-vacuous `packages/server/test/snake.test.ts:187`: the disconnect-grace food assertion currently passes against INITIAL food. Rewrite to diff food sets before/after the grace kill and assert a NEW food item exists at one of the dead snake's even-indexed corpse cells specifically.
- [ ] **Step 4:** Run server suite + full suite → green. Confirm zero diff in packages/snake-core, packages/snake-client, packages/bomber-* (`git diff --stat` shows only server files). **Step 5:** Ledger + commit `fix(server): snake join 400s on bad body; de-vacuous disconnect food assertion`.

---

### Task 13: release — USER-GATED (STOP and hand commands to the user)

**Files:** Modify `packages/block-core/package.json` + `packages/block-client/package.json` (0.1.0, exact pins), `packages/server/package.json` (blockwait-core pin), `plugin/games.json` (add `{"id":"blockwait","title":"blockwait — terminal block-stacking duel","cmd":"npx -y blockwait@0.1.0"}`), `plugin/.claude-plugin/plugin.json` (0.4.0 → 0.5.0), lockfile, `plugin/test/launcher.test.sh` (real-games.json assertions 4→5 entries — the snakewait Task 12 fallout, expected this time).

- [ ] **Step 1:** Re-verify `npm view blockwait` / `blockwait-core` → still E404 (remember: a stale npm login ALSO prints E404 — that's the publish-time trap, not this check). Full suite green; `npm run build -w blockwait-core && npm run build -w blockwait` clean.
- [ ] **Step 2:** Version pins: blockwait-core@0.1.0; blockwait@0.1.0 (deps blockwait-core@0.1.0, termwait@0.1.0, ws@8.21.0); server dep blockwait-core@0.1.0; games.json entry; plugin 0.5.0; launcher real-file assertions; `npm install --package-lock-only` (3-line-scale diff, no drift). Launcher test STANDALONE green. Commit `chore(release): blockwait 0.1.0 pins`.
- [ ] **Step 3:** STOP. Hand the user, in order:
  (a) **Feel gate FIRST, build INCLUDED in the command** (the stale-dist rule is law):
  `cd "/Users/jeremiahagthe/Desktop/fpsGame extension" && npm run build -w blockwait-core && npm run build -w blockwait && node packages/block-client/bin/blockwait.js --offline` at iTerm2 80x24 — offline round;
  (b) publish (user's terminal, FRESH npm login): `npm publish -w blockwait-core && npm publish -w blockwait`;
  (c) worker deploy: `env -u CLOUDFLARE_API_TOKEN PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler deploy` from packages/server (ships migration v5 + the Task 12 snake fix);
  (d) **online feel round** — `npx -y blockwait@0.1.0` twice (two terminals, or once vs the backfill bot): the "online never had a human feel pass" risk closes here, BEFORE the ledger SHIPPED entry.
  After user confirms: verify publishes (`npm view` both), worker health + `/block/join` smoke (`-m 15`, lobby waits ~10s) + `/snake/join {}`→400 smoke, clean-install resolution + published dist greps ESC[H, tag `blockwait-v0.1.0`, push main + tag, ledger SHIPPED entry.

---

## Self-review notes (spec-coverage pass done at write time)

- Spec §Product → Tasks 9/10/13. §Authority model → Tasks 6/7/10 (per-player clocks; LEAD/LAG clamps; resync triggers pinned in Task 10). §Frame → Task 8. §Core sim → Tasks 1-4. §Bots → Task 5. §Wire → Task 6. §Server → Task 7. §Folded hygiene → Task 12 (+ block join 400 born-correct in Task 7). §Plugin → Tasks 11/13. §Release → Task 13 (online feel round added per spec's Release section). §Out-of-scope respected (no T-spins/b2b/combos, k=1 only, 2 players).
- `killPlayer` lives in Task 3 (offline result tests need it) unlike snake's Task-7 placement — both players' forfeit path is core-visible here.
- Golden (Task 4) precedes bots (Task 5); bot-vs-bot end-bound gate (≤ 4400) substitutes for a passive-player bound test (empty-input players top out early from center stacking, which would test nothing).
- Type-consistency pass: `stepPlayer` returns `StepOut` everywhere (Tasks 2/3/7/10); `GameEvent` string union in core, numeric codes only on the wire (Task 6 EVENT_CODES); `WirePlayer` field order fixed in Task 6 and consumed only via to/fromWirePlayer.
- Known deliberate divergences from snakewait's plan: input-queue (ordered events) replaces input-latch (single dir); no k=2 layout; duel lobby fills at 2; vtsim is a real test not a scratchpad tool.
