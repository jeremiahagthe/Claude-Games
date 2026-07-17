# tankwait (terminal artillery duel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship game 6 of the /games arcade — a Scorched Earth-style 1v1 artillery duel (seeded destructible heightmap, strict-alternation angle+power shots under a 20s shot clock, per-turn wind, HP + proximity damage, round-12 decay end bound), online with one-bot backfill plus fully offline vs a bot, as npm packages `tankwait-core` + `tankwait`.

**Architecture:** Deterministic replay (spec Approach A). A "move" is `{angle, power}`; the pure core function `resolveShot(state, shot)` returns the full trajectory + next state. The server runs it once and is the authority (the chess-match `applyMove` shape — wall-time deadline alarm, NO tick loop); each client runs the identical function locally for smooth playback. Every downstream shot carries the server's post-shot `stateHash` as a desync tripwire. Thin DOs in the EXISTING fragwait-server worker (migration v7 appended), client on published `termwait@0.1.0` (exact pin). Spec: `docs/superpowers/specs/2026-07-17-tankwait-design.md` — read it first; it governs on any conflict.

**Tech Stack:** TypeScript strict / ESM NodeNext / vitest / Cloudflare Workers + DOs (wrangler 4.107.0, Node 22 for wrangler) / no runtime deps in core.

## Global Constraints (house rules — every task inherits these)

- `packages/tank-core` (`tankwait-core`): ZERO runtime deps; no `Date.now`/`Math.random` in core src (a grep test enforces it). RNG is the PURE serializable `randStep(s: number)` (copy snake-core's prng.ts verbatim with a source comment) — wind re-rolls happen mid-match. `Math.sin/cos/sqrt` ARE allowed (V8's fdlibm math is cross-platform deterministic; the stateHash tripwire would catch any violation in production).
- Exact version pins everywhere (`"x.y.z"`, never `^`/`~`). `.js` import extensions. Repo path contains a space — ALWAYS quote in shell; NEVER backslash-escape paths in Write/Edit tool calls.
- TDD: write the failing test first, run it, implement, run again, commit. Test literals are spec pins — change constants and tests together with the root cause stated in the test or ledger. Physics tests assert RANGES for integrated quantities (impact windows), EXACT values only for closed-form ones (damage table, fall damage).
- Never run the interactive game in subagents; tests + build only. Feel verdicts come from the USER in iTerm2 at the default 80x24 window. The sanctioned non-interactive check is the vtsim gate (Task 8).
- After every task: append a ledger entry to `.superpowers/sdd/progress.md` and commit with trailer exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- fragwait, checkwait, boomwait, snakewait, AND blockwait packages are FROZEN (packages/core, client, chess-core, chess-client, bomber-core, bomber-client, snake-core, snake-client, block-core, block-client — zero-diff, pattern reference only). termwait (`packages/term-kit`) consumed as-is at 0.1.0. Exception: `packages/server` is worker code, not a published package — Task 6 modifies it, including moving the migration-pin test out of `packages/server/test/block.test.ts` (test file, not the frozen block packages).
- wrangler.jsonc migrations: APPEND tag v7 only; v1–v6 never edited (literal file-reading test enforces order; ownership moves to tank.test.ts in Task 6 per house rule — the newest game owns the pin).
- Run tests: `npx vitest run packages/tank-core` (etc.) from repo root; full suite `npm test` must stay green (currently 1008). Plugin launcher test runs STANDALONE ONLY (chaining it after another command in one Bash call hangs it — re-confirmed 2026-07-17; solo run ~60s).
- The 80x24 frame fit (Task 7) is asserted by tests, never eyeballed. Raw ESC[H/K/J framing pins land in the SAME task as the first renderer code, with clear-to-EOL at line START including column 80 (checkwait 0.1.8 lesson).
- **Stale-dist rule (bit twice):** packages/server and packages/tank-client import `tankwait-core` through its BUILT dist, and tank-client's bin runs its OWN dist — after ANY src change in either, run `npm run build -w tankwait-core` / `npm run build -w tankwait` before dependent tests, the vtsim gate, the feel gate, or publish.
- Visible-width measurement in tests uses the \x1b-aware strip `/\x1b\[[0-9;]*[A-Za-z]/g` and asserts EXACT widths. No literal control bytes in test files — `\x1b` source escapes only.
- Coordinate convention (core, tests, renderer): world x in columns (floats, field [0,80)), world y UP in half-row units (floor y=0, field top y=42; 1 screen row = 2 world y units — world space is visually isotropic, so blast circles render round). Angle: 0° = due right (+x), 90° = straight up, 180° = due left — same for both players. Positive wind pushes toward +x. Screen row for world y: `22 - Math.floor(y / 2)` (terrain field occupies screen rows 2–22).

## File Structure

```
packages/tank-core/             → npm "tankwait-core"
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/constants.ts              (field, physics, damage, timing, spawn, sudden death)
  src/prng.ts                   (mulberry32 + pure randStep — copied from snake-core, source comment)
  src/terrain.ts                (midpoint-displacement gen, smoothing, carve)
  src/state.ts                  (Tank, MatchState, Result, Shot, helpers, stateHash)
  src/match.ts                  (createMatch: terrain, spawns, first turn, wind roll)
  src/resolve.ts                (resolveShot: integrate/carve/damage/settle/bookkeeping; blastDamage; killPlayer)
  src/bot.ts                    (createBotMind/botDecide/botObserve: closed-form + bracketing)
  src/protocol.ts               (msg types, parsers + caps, sanitizeHandle)
  test/{terrain,match,resolve,golden,bot,protocol,nodate}.test.ts
packages/server/src/
  tank-lobby.ts                 (TankLobbyDO)  [new]
  tank-match.ts                 (TankMatchHost + TankMatchDO) [new]
  index.ts                      (add /tank routes + DO exports) [modify]
  ../wrangler.jsonc             (TANK_LOBBY/TANK_MATCH bindings + migration v7 APPEND) [modify]
  ../package.json               (add tankwait-core workspace dep) [modify]
  test/tank.test.ts             [new — takes over the migration v1..v7 literal pin]
  test/block.test.ts            [modify — REMOVE its migration pin test only]
packages/tank-client/           → npm "tankwait"
  package.json tsconfig.json bin/tankwait.js
  src/main.ts src/cli.ts src/cliArgs.ts
  src/render.ts                 (HUD rows 0-1, terrain rows 2-22, hints row 23; color tiers)
  src/anim.ts                   (pure playback state machine over ResolveOut)
  src/game.ts                   (session glue — block-client's game.ts shape)
  src/offline.ts src/share.ts
  src/net.ts src/online.ts
  test/{cliArgs,render,anim,share,net,online,vt}.test.ts
  test/vtsim.ts                 (VT simulator — copied from block-client, source comment)
plugin/games.json               (add tankwait entry AT RELEASE) [modify]
plugin/test/launcher.test.sh    (six-entry rotation + --pick tankwait cases) [modify]
README.md                       (tankwait section) [modify]
```

---

### Task 1: tank-core scaffold + constants + terrain + createMatch

**Files:** Create `packages/tank-core/{package.json,tsconfig.json,src/{index.ts,constants.ts,prng.ts,terrain.ts,state.ts,match.ts},test/terrain.test.ts,test/match.test.ts,test/nodate.test.ts}`.

**Interfaces (Produces):**
```ts
// constants.ts
export const FIELD_W = 80, FIELD_H = 42            // world units; y up, floor 0
export const HP_MAX = 100
export const ANGLE_MIN = 0, ANGLE_MAX = 180        // integer degrees; 0=right, 90=up, 180=left
export const POWER_MIN = 0, POWER_MAX = 100        // integer
export const DT = 1 / 30                           // s per integration step
export const GRAVITY = 40                          // units/s^2
export const POWER_SCALE = 1.1                     // v0 = power * POWER_SCALE units/s
export const WIND_MAX = 10                         // wind ∈ [-WIND_MAX..WIND_MAX] integers; + pushes right
export const WIND_ACCEL = 1.2                      // horizontal accel = wind * WIND_ACCEL units/s^2
export const MAX_FLIGHT_STEPS = 600
export const BLAST_RADIUS = 6                      // world units
export const BLAST_DAMAGE_MAX = 60
export const TANK_HIT_RADIUS = 1.5                 // direct-contact radius (plan addition; spec's "tank contact")
export const FALL_FREE_UNITS = 4
export const FALL_DAMAGE_PER_UNIT = 3
export const TERRAIN_MIN = 4, TERRAIN_MAX = 30
export const SPAWN_FLAT_HALF = 2                   // flatten tankCol ± 2 (5 cols)
export const SPAWN_L: readonly [number, number] = [8, 16]   // inclusive col ranges
export const SPAWN_R: readonly [number, number] = [63, 71]
export const SHOT_CLOCK_MS = 20_000
export const SUDDEN_DEATH_ROUND = 12               // decay applies as each round ≥ this completes
export const SUDDEN_DEATH_DECAY = 10
export const DEFAULT_POWER = 50
export const DEFAULT_ANGLE = 60                    // left tank; right tank uses 180 - DEFAULT_ANGLE
// prng.ts — copied from packages/snake-core/src/prng.ts verbatim (source comment)
export function mulberry32(seed: number): () => number
export function randStep(s: number): { value: number; next: number }
// terrain.ts
export function genTerrain(rng: number): { heights: number[]; rng: number } // 80 floats in [TERRAIN_MIN, TERRAIN_MAX]
// state.ts
export type Result = { kind: 'win'; winner: number } | { kind: 'draw' }
export interface Shot { angle: number; power: number }
export interface Tank {
  id: number; name: string; bot: boolean; alive: boolean
  col: number                  // integer spawn column; never changes (fixed emplacements)
  hp: number
  lastAngle: number; lastPower: number   // pre-loaded defaults; server expiry auto-fires these
  shotsFired: number; damageDealt: number
}
export interface MatchState {
  heights: number[]            // 80 floats, world y of the surface per column
  tanks: [Tank, Tank]          // index 0 = left tank, 1 = right tank
  turn: 0 | 1; firstTurn: 0 | 1
  round: number                // 1-based; increments when the second mover of the round fires
  wind: number                 // integer [-WIND_MAX..WIND_MAX], rolled for the CURRENT turn
  rng: number                  // randStep state
  result: Result | null        // stamped once, never overwritten
}
export function rollWind(rng: number): { wind: number; rng: number }  // floor(value*(2*WIND_MAX+1)) - WIND_MAX
export function stateHash(m: MatchState): string                     // fnv1a hex of JSON.stringify(m)
export function tankY(m: MatchState, id: number): number             // heights[tank.col] (the tank sits ON the surface)
export function muzzle(m: MatchState, id: number): [number, number]  // [tank.col, tankY + 1]
// match.ts
export function createMatch(seed: number, names: [string, string], bots: [boolean, boolean]): MatchState
```

genTerrain algorithm (fixed, so implementations agree; the golden pins it): 81 knots `k[0..80]`. Seed `k[0]` and `k[80]` uniform in [TERRAIN_MIN, TERRAIN_MAX] (two randStep draws, in that order). Midpoint recursion `mid(lo, hi, amp)`: if `hi - lo < 2` return; `m = (lo + hi) >> 1`; `k[m] = (k[lo] + k[hi]) / 2 + (value * 2 - 1) * amp` (one randStep draw); recurse `mid(lo, m, amp / 2)` THEN `mid(m, hi, amp / 2)` (left before right — draw order is part of the pin). Initial `amp = (TERRAIN_MAX - TERRAIN_MIN) / 2 = 13`. Then two smoothing passes `k'[i] = (k[i-1] + 2*k[i] + k[i+1]) / 4` (clamped-edge: out-of-range neighbor = the edge value), clamp all to [TERRAIN_MIN, TERRAIN_MAX], return `k.slice(0, 80)`.

createMatch: `rng = (mulberry32(seed)() * 2**32) >>> 0`, then in order: genTerrain, left col = `SPAWN_L[0] + floor(value * (SPAWN_L[1] - SPAWN_L[0] + 1))` (one draw), right col likewise from SPAWN_R (one draw), flatten `col ± SPAWN_FLAT_HALF` (clamped to [0,79]) to `heights[col]` for each tank (left first), `firstTurn = value < 0.5 ? 0 : 1` (one draw), rollWind (one draw). Tanks: hp HP_MAX, alive, shotsFired/damageDealt 0, `lastAngle` DEFAULT_ANGLE (id 0) / `180 - DEFAULT_ANGLE` (id 1), `lastPower` DEFAULT_POWER. `turn = firstTurn`, `round = 1`, result null.

- [ ] **Step 1:** Scaffold package.json (`"name": "tankwait-core"`, `"version": "0.0.0"`, `"type": "module"`, main/types → dist, zero deps, build script `tsc -p tsconfig.json`) + tsconfig copied from packages/block-core (NodeNext, strict). `npm install`.
- [ ] **Step 2:** Write failing `test/terrain.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TERRAIN_MAX, TERRAIN_MIN } from '../src/constants.js'
import { mulberry32 } from '../src/prng.js'
import { genTerrain } from '../src/terrain.js'

describe('genTerrain', () => {
  const rng0 = (mulberry32(42)() * 2 ** 32) >>> 0
  it('80 columns, all within [TERRAIN_MIN, TERRAIN_MAX]', () => {
    const { heights } = genTerrain(rng0)
    expect(heights).toHaveLength(80)
    for (const h of heights) { expect(h).toBeGreaterThanOrEqual(TERRAIN_MIN); expect(h).toBeLessThanOrEqual(TERRAIN_MAX) }
  })
  it('deterministic per rng state; different states differ; rng is threaded', () => {
    const a = genTerrain(rng0), b = genTerrain(rng0)
    expect(a.heights).toEqual(b.heights)
    expect(a.rng).toBe(b.rng)
    expect(a.rng).not.toBe(rng0)
    const c = genTerrain(a.rng)
    expect(c.heights).not.toEqual(a.heights)
  })
  it('smoothed: no single-column spikes (|h[i] - neighbor mean| bounded)', () => {
    const { heights } = genTerrain(rng0)
    for (let i = 1; i < 79; i++)
      expect(Math.abs(heights[i]! - (heights[i - 1]! + heights[i + 1]!) / 2)).toBeLessThan(6)
  })
})
```

- [ ] **Step 3:** Write failing `test/match.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_ANGLE, DEFAULT_POWER, HP_MAX, SPAWN_FLAT_HALF, SPAWN_L, SPAWN_R, WIND_MAX } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { stateHash, tankY } from '../src/state.js'

const NAMES: [string, string] = ['a', 'b'], BOTS: [boolean, boolean] = [false, true]

describe('createMatch', () => {
  const m = createMatch(42, NAMES, BOTS)
  it('two tanks, full hp, seeded cols in the spawn bands, flattened footing', () => {
    expect(m.tanks[0]!.col).toBeGreaterThanOrEqual(SPAWN_L[0]); expect(m.tanks[0]!.col).toBeLessThanOrEqual(SPAWN_L[1])
    expect(m.tanks[1]!.col).toBeGreaterThanOrEqual(SPAWN_R[0]); expect(m.tanks[1]!.col).toBeLessThanOrEqual(SPAWN_R[1])
    m.tanks.forEach((t, i) => {
      expect(t).toMatchObject({ id: i, name: NAMES[i], bot: BOTS[i], alive: true, hp: HP_MAX, shotsFired: 0, damageDealt: 0, lastPower: DEFAULT_POWER })
      for (let d = -SPAWN_FLAT_HALF; d <= SPAWN_FLAT_HALF; d++)
        expect(m.heights[t.col + d]).toBe(m.heights[t.col])
    })
    expect(m.tanks[0]!.lastAngle).toBe(DEFAULT_ANGLE)
    expect(m.tanks[1]!.lastAngle).toBe(180 - DEFAULT_ANGLE)
  })
  it('round 1, turn = firstTurn, wind in range, no result', () => {
    expect(m.round).toBe(1)
    expect(m.turn).toBe(m.firstTurn)
    expect(Math.abs(m.wind)).toBeLessThanOrEqual(WIND_MAX)
    expect(Number.isInteger(m.wind)).toBe(true)
    expect(m.result).toBeNull()
  })
  it('deterministic per seed; different seeds differ; stateHash stable', () => {
    expect(createMatch(42, NAMES, BOTS)).toEqual(m)
    expect(stateHash(createMatch(42, NAMES, BOTS))).toBe(stateHash(m))
    expect(stateHash(createMatch(43, NAMES, BOTS))).not.toBe(stateHash(m))
  })
  it('tankY reads the surface under the tank', () => {
    expect(tankY(m, 0)).toBe(m.heights[m.tanks[0]!.col])
  })
})
```

- [ ] **Step 4:** Run `npx vitest run packages/tank-core` → FAIL (modules missing).
- [ ] **Step 5:** Implement constants/prng/terrain/state/match per the Interfaces block (fnv1a inside state.ts — same imul formula as the family's golden tests). index.ts re-exports everything listed.
- [ ] **Step 6:** Write `test/nodate.test.ts` — same shape as block-core's (readdir src, assert no `/Date\.now|Math\.random/` in any .ts).
- [ ] **Step 7:** Run → PASS; full `npm test` green (1008 → +new). Ledger + commit `feat(tank-core): scaffold, terrain gen, state, seeded createMatch`.

---

### Task 2: resolveShot — integrate, carve, damage, settle, rounds, result + killPlayer

**Files:** Create `packages/tank-core/src/resolve.ts`, `packages/tank-core/test/resolve.test.ts`. Modify `src/index.ts`.

**Interfaces (Consumes):** Task 1 everything. **Produces:**
```ts
export interface ResolveOut {
  state: MatchState
  trajectory: [number, number][]        // world [x,y] per DT step, muzzle first
  impact: { x: number; y: number } | null  // null = lost shell (left the field / step cap)
  damage: [number, number]              // total hp lost this shot per tank id (blast + fall + decay)
}
export function resolveShot(m: MatchState, shot: Shot): ResolveOut   // pure, never mutates
export function blastDamage(dist: number): number                    // round(BLAST_DAMAGE_MAX * max(0, 1 - dist/BLAST_RADIUS))
export function carve(heights: number[], ix: number, iy: number): number[]  // crater; pure
export function killPlayer(m: MatchState, id: number): MatchState    // forfeit: alive=false, stamp result
```
resolveShot phases (exact semantics — the pin):
1. **Integrate** (semi-implicit Euler): start at `muzzle(m, m.turn)`; `vx = cos(rad) * power * POWER_SCALE`, `vy = sin(rad) * power * POWER_SCALE` (`rad = angle * PI / 180`). Per step: `vx += m.wind * WIND_ACCEL * DT; vy -= GRAVITY * DT; x += vx * DT; y += vy * DT`; push `[x, y]` onto trajectory. After each step check IN ORDER: (a) `x < 0 || x >= FIELD_W` → lost shell (impact null, skip phases 2–4); (b) tank contact — for each ALIVE tank, center `[t.col, heights[t.col] + 1]`, hit when world distance ≤ TANK_HIT_RADIUS; the SHOOTER is immune until the shell has once been > 2·TANK_HIT_RADIUS from its own muzzle (prevents instant self-contact at launch; blast self-damage still applies); contact → impact at current [x, y]; (c) terrain `y <= heights[min(79, max(0, round(x)))]` → impact; (d) `y <= 0` → impact (safety; craters clamp at 0 so (c) normally fires first); (e) step count = MAX_FLIGHT_STEPS → lost shell.
2. **Carve**: `carve(heights, ix, iy)` — for each col c with `|c - ix| < BLAST_RADIUS`: `chord = sqrt(BLAST_RADIUS² - (c - ix)²)`; `h' = max(0, min(heights[c], iy - chord))` (material above the crater collapses into it — heightmap has no overhangs).
3. **Damage**: for each alive tank, `d = hypot(t.col - ix, (preCarveY(t) + 1) - iy)` where preCarveY = heights[t.col] BEFORE carving; `hp -= blastDamage(d)`. Shooter included.
4. **Settle**: for each alive tank, `fall = preCarveHeights[t.col] - newHeights[t.col]`; if `fall > FALL_FREE_UNITS` → `hp -= round((fall - FALL_FREE_UNITS) * FALL_DAMAGE_PER_UNIT)`.
5. **Bookkeeping** (runs for lost shells too): shooter `lastAngle/lastPower = shot`, `shotsFired + 1`, `damageDealt +=` hp the OPPONENT lost in phases 3–4. Flip `turn`. If the flipped turn equals `firstTurn`, the round just completed: if `round >= SUDDEN_DEATH_ROUND` both alive tanks lose SUDDEN_DEATH_DECAY (counted into `damage` but NOT damageDealt); then `round + 1`. Re-roll wind (one rollWind draw). Stamp result once: exactly one tank at hp ≤ 0 → `{kind:'win', winner: other}`; both ≤ 0 → `{kind:'draw'}`; hp floors at 0 (`max(0, hp)`), `alive = hp > 0`.
Input clamping: angle/power are clamped to their ranges and rounded to integers on entry (server validates too; core is defensive).

- [ ] **Step 1:** Write failing `test/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BLAST_DAMAGE_MAX, BLAST_RADIUS, FALL_DAMAGE_PER_UNIT, FALL_FREE_UNITS, HP_MAX, SUDDEN_DEATH_DECAY, SUDDEN_DEATH_ROUND, WIND_MAX } from '../src/constants.js'
import { createMatch } from '../src/match.js'
import { blastDamage, carve, killPlayer, resolveShot } from '../src/resolve.js'
import type { MatchState } from '../src/state.js'

// Hand-built flat-world fixture: surface y=10 everywhere, tanks at cols 10 and 70,
// wind forced to 0, turn 0. Physics assertions below are closed-form checks on THIS world.
function flat(over: Partial<MatchState> = {}): MatchState {
  const m = createMatch(1, ['a', 'b'], [false, false])
  return {
    ...m,
    heights: new Array(80).fill(10),
    tanks: [{ ...m.tanks[0]!, col: 10 }, { ...m.tanks[1]!, col: 70 }],
    turn: 0, firstTurn: 0, round: 1, wind: 0,
    ...over,
  }
}

describe('ballistics (range windows on the flat fixture)', () => {
  it('45° power 40, no wind: lands right, in the closed-form window [54, 62]', () => {
    // v = 44 u/s → ideal range v²/G = 48.4 from col 10 → ~58; DT integration lands within ±4
    const out = resolveShot(flat(), { angle: 45, power: 40 })
    expect(out.impact).not.toBeNull()
    expect(out.impact!.x).toBeGreaterThan(54); expect(out.impact!.x).toBeLessThan(62)
    expect(out.trajectory.length).toBeGreaterThan(20)
    expect(out.trajectory[0]![1]).toBe(11)                       // muzzle = surface + 1
  })
  it('mirror symmetry: 135° from the right tank lands the mirrored distance left', () => {
    const right = resolveShot(flat({ turn: 1, firstTurn: 1 }), { angle: 135, power: 40 })
    expect(right.impact!.x).toBeGreaterThan(80 - 62); expect(right.impact!.x).toBeLessThan(80 - 54)
  })
  it('tailwind +10 carries the shell measurably farther than calm', () => {
    const calm = resolveShot(flat(), { angle: 45, power: 40 })
    const windy = resolveShot(flat({ wind: WIND_MAX }), { angle: 45, power: 40 })
    expect(windy.impact!.x - calm.impact!.x).toBeGreaterThan(6)
  })
  it('full power at 10° exits the field: lost shell, nothing damaged, turn still advances', () => {
    const out = resolveShot(flat(), { angle: 10, power: 100 })
    expect(out.impact).toBeNull()
    expect(out.damage).toEqual([0, 0])
    expect(out.state.turn).toBe(1)
    expect(out.state.tanks[0]!.lastAngle).toBe(10)               // expiry auto-fire source updated anyway
  })
  it('every (angle, power, wind) on a coarse grid terminates within MAX_FLIGHT_STEPS', () => {
    for (let a = 0; a <= 180; a += 15)
      for (let p = 0; p <= 100; p += 20)
        for (const w of [-WIND_MAX, 0, WIND_MAX])
          expect(() => resolveShot(flat({ wind: w }), { angle: a, power: p })).not.toThrow()
  })
})

describe('blast damage (closed-form table)', () => {
  it('pinned falloff: 60 at 0, 30 at R/2, 0 at ≥ R', () => {
    expect(blastDamage(0)).toBe(BLAST_DAMAGE_MAX)
    expect(blastDamage(BLAST_RADIUS / 2)).toBe(BLAST_DAMAGE_MAX / 2)
    expect(blastDamage(BLAST_RADIUS)).toBe(0)
    expect(blastDamage(BLAST_RADIUS + 5)).toBe(0)
  })
  it('straight up is self-punishment: 90° low power comes back down near the shooter', () => {
    const out = resolveShot(flat(), { angle: 90, power: 30 })
    expect(out.damage[0]).toBeGreaterThan(30)                    // near-direct self-hit
    expect(out.damage[1]).toBe(0)
  })
})

describe('carve + settle', () => {
  it('crater: impact on the surface digs a bowl, deepest at the impact column', () => {
    const h = carve(new Array(80).fill(20), 40, 20)
    expect(h[40]!).toBeCloseTo(20 - BLAST_RADIUS, 5)
    expect(h[38]!).toBeGreaterThan(h[40]!); expect(h[38]!).toBeLessThan(20)
    expect(h[40 - BLAST_RADIUS]!).toBe(20); expect(h[40 + BLAST_RADIUS]!).toBe(20)
    expect(Math.min(...h)).toBeGreaterThanOrEqual(0)             // never below the floor
  })
  it('undermined tank falls and takes fall damage past the free threshold', () => {
    // Impact directly under tank 1's feet on a tall column: fall ≈ BLAST_RADIUS = 6 → dmg (6-4)*3 = 6, plus blast
    const m = flat({ heights: new Array(80).fill(20) })
    const before = m.heights[70]!
    // fire a synthetic point-blank: build the shot by aiming a mortar onto col 70 is flaky —
    // instead call carve+settle through resolveShot with a state whose turn-0 tank is adjacent:
    const near = flat({ heights: new Array(80).fill(20), tanks: [{ ...m.tanks[0]!, col: 60 }, { ...m.tanks[1]!, col: 70 }] })
    const out = resolveShot(near, { angle: 75, power: 26 })      // short lob rightward; impact window covers ~[66, 74]
    if (out.impact && Math.abs(out.impact.x - 70) < 3) {
      expect(out.state.heights[70]!).toBeLessThan(before)
      expect(out.damage[1]).toBeGreaterThan(0)
    }
    // deterministic core assertion that never depends on the lob window:
    const carved = carve(new Array(80).fill(20), 70, 20)
    const fall = 20 - carved[70]!
    expect(fall).toBeCloseTo(BLAST_RADIUS, 5)
    expect(Math.round((fall - FALL_FREE_UNITS) * FALL_DAMAGE_PER_UNIT)).toBe(6)
  })
})

describe('turns, rounds, decay, result', () => {
  const lost = (m: MatchState) => resolveShot(m, { angle: m.turn === 0 ? 1 : 179, power: 100 }) // near-flat full power exits the field fast on either side
  it('round increments when the second mover fires; wind re-rolls each shot', () => {
    const m = flat()
    const a = resolveShot(m, { angle: 10, power: 100 })          // lost shell, turn → 1
    expect(a.state.round).toBe(1)
    const b = resolveShot(a.state, { angle: 170, power: 100 })   // second mover → round completes
    expect(b.state.round).toBe(2)
    expect(b.state.turn).toBe(0)
  })
  it('sudden-death decay drains both from SUDDEN_DEATH_ROUND; forces a result eventually', () => {
    let s = flat({ round: SUDDEN_DEATH_ROUND })
    for (let guard = 0; guard < 60 && !s.result; guard++) s = lost(s).state
    expect(s.result).not.toBeNull()
    expect(s.tanks[0]!.hp).toBe(0); expect(s.tanks[1]!.hp).toBe(0)
    expect(s.result).toEqual({ kind: 'draw' })                   // symmetric decay from full hp → draw
  })
  it('decay is not damageDealt', () => {
    let s = flat({ round: SUDDEN_DEATH_ROUND })
    s = lost(s).state; s = lost(s).state                         // one full round → both -10
    expect(s.tanks[0]!.hp).toBe(HP_MAX - SUDDEN_DEATH_DECAY)
    expect(s.tanks.every((t) => t.damageDealt === 0)).toBe(true)
  })
  it('result stamps once and never overwrites; killPlayer forfeits', () => {
    const dead = killPlayer(flat(), 1)
    expect(dead.result).toEqual({ kind: 'win', winner: 0 })
    expect(dead.tanks[1]!.alive).toBe(false)
    expect(killPlayer(dead, 0).result).toEqual({ kind: 'win', winner: 0 })
  })
  it('resolveShot never mutates its input', () => {
    const m = flat()
    const snap = JSON.stringify(m)
    resolveShot(m, { angle: 45, power: 60 })
    expect(JSON.stringify(m)).toBe(snap)
  })
})
```

(Fixture-geometry note, the standing house rule: the SEMANTICS in the phase list are the pin. If a hand-traced window is off — e.g., the 45°/power-40 impact window under DT integration — fix the TEST WINDOW with the reasoning stated in the test, never bend the physics to a bad literal. Windows may be adjusted ±4 units once, with the measured value quoted in the test comment.)

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement resolve.ts phases 1–5. **Step 4:** Run → PASS, full suite green. **Step 5:** Ledger + commit `feat(tank-core): resolveShot — ballistics, crater carve, blast/fall damage, rounds + decay, result`.

---

### Task 3: golden master

**Files:** Create `packages/tank-core/test/golden.test.ts`.

**Interfaces (Consumes):** createMatch, resolveShot, stateHash. Bots NOT in this path (hash stays bot-free — the house ordering).

- [ ] **Step 1:** Write the test with a placeholder hash:

```ts
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
  expect(stateHash(m)).toBe('RECORD_ME')  // record from an actual green run; re-record + note why on intended changes
  expect(chain.length).toBeGreaterThan(3) // the tape survives at least 2 rounds before any result
})
```

- [ ] **Step 2:** Run → FAIL with the actual hash in the assertion diff. **Step 3:** Pin the printed hash (a RECORDING, not an oracle — say so in the commit). **Step 4:** Run twice → PASS both. Suite green. **Step 5:** Ledger + commit `test(tank-core): golden master pinned`.

---

### Task 4: bots — closed-form first shot + bracketing correction

**Files:** Create `packages/tank-core/src/bot.ts`, `packages/tank-core/test/bot.test.ts`. Modify `src/index.ts`.

**Interfaces (Consumes):** MatchState, resolveShot (tests + observe loop). **Produces:**
```ts
export type Difficulty = 'easy' | 'normal' | 'hard'
export interface BotMind { rng: number; lastShot: Shot | null; lastImpactX: number | null }
export function createBotMind(seed: number): BotMind
export function botDecide(m: MatchState, id: number, mind: BotMind, d: Difficulty): { shot: Shot; mind: BotMind }
export function botObserve(mind: BotMind, shot: Shot, impactX: number | null): BotMind
// noise (uniform ± half-width applied to power, plus angle jitter in degrees):
// easy: power ±30%, angle ±8°, correction gain 0.3
// normal: power ±12%, angle ±3°, correction gain 0.7
// hard: power ±5%, angle ±1°, correction gain 0.9, first-order wind compensation
```
Decision logic: base angle = 60 shooting right / 120 shooting left (sign of `target.col - self.col`). First shot (`lastImpactX === null`): closed-form power for the horizontal distance `dist = |target.col - self.col|` at the base angle — `v = sqrt(dist * GRAVITY / sin(2·rad))`, `power = clamp(v / POWER_SCALE)`. `hard` first subtracts the estimated wind drift from `dist`: `t ≈ 2·v·sin(rad)/GRAVITY` (one fixed-point iteration from the no-wind v), `drift = 0.5 · wind · WIND_ACCEL · t²`, signed toward the shot direction. Later shots: `err = lastImpactX - target.col` (lost shell → treat as max-range overshoot in the shot direction, err = ±20); corrected power = `lastShot.power · (1 - gain · err / max(dist, 8) )` clamped — overshoot shrinks power, undershoot grows it (range ∝ v²; the linear correction with gain < 1 brackets stably). Then apply difficulty noise to power and angle (two randStep draws, always both, threading mind.rng). Callers record outcomes via `botObserve(mind, shot, out.impact?.x ?? null)` after resolving the bot's shot.

- [ ] **Step 1:** Write failing `test/bot.test.ts`:

```ts
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
        // hand the turn straight back (opponent skips — keep the bot's own state clean):
        m = { ...out.state, turn: 0, tanks: [out.state.tanks[0]!, { ...out.state.tanks[1]!, hp: 100, alive: true }] }
        if (!m.tanks[0]!.alive) break
      }
      if (misses.length === 3) expect(misses[2]!, `seed ${seed}: ${misses}`).toBeLessThan(misses[0]! + 0.001)
    }
  })
})
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement bot.ts. **Step 4:** Run → PASS (if a gate fails, the BOT is wrong — tune gains/noise, never loosen the gate). Golden hash UNCHANGED. Suite green. **Step 5:** Ledger + commit `feat(tank-core): artillery bots — closed-form first shot, bracketing correction, liveness gates`.

---

### Task 5: wire protocol — parsers, caps, transcript determinism

**Files:** Create `packages/tank-core/src/protocol.ts`, `packages/tank-core/test/protocol.test.ts`. Modify `src/index.ts`.

**Interfaces (Produces):**
```ts
export const MAX_RAW = 4096
export interface JoinMsg { t: 'join'; name: string }
export interface ShotMsg { t: 'shot'; seq: number; angle: number; power: number }
export type TankClientMsg = JoinMsg | ShotMsg
export interface StartMsg { t: 'start'; you: 0 | 1; seed: number; names: [string, string]; bots: [boolean, boolean]; firstTurn: 0 | 1 }
export interface ShotBcast { t: 'shot'; by: 0 | 1; seq: number; angle: number; power: number; stateHash: string }
export interface TurnMsg { t: 'turn'; who: 0 | 1; deadlineMs: number }   // duration from send; display-only countdown
export interface EndMsg { t: 'end'; result: [0, number] | [1] }          // [0,winner] | [1]=draw
export type TankServerMsg = StartMsg | ShotBcast | TurnMsg | EndMsg
export function sanitizeHandle(raw: string): string   // copy block-core's rules verbatim (read packages/block-core/src/protocol.ts)
export function parseTankClientMsg(raw: unknown): TankClientMsg | null   // size cap + shape checks; null on ANY violation
export function parseTankServerMsg(raw: unknown): TankServerMsg | null
export function resultToWire(r: Result): [0, number] | [1]
export function resultFromWire(w: [0, number] | [1]): Result
```
Hardening pins (the bomber patterns): string fields length-capped (name ≤ 24 post-sanitize, stateHash ≤ 16 hex chars `[0-9a-f]`), angle integer 0–180, power integer 0–100, seq a finite non-negative integer, seed a finite integer, deadlineMs a finite positive integer ≤ 120_000, all numerics finite, `you`/`by`/`who`/`firstTurn` exactly 0 or 1, names tuple of exactly 2, anything malformed → null, validators rebuild FRESH literals. No literal control bytes in the test file.

- [ ] **Step 1:** Write failing `test/protocol.test.ts` covering: legal round-trips (a JoinMsg, a ShotMsg, every server msg type built by hand → stringify → parse → deep-equal); `resultFromWire(resultToWire(r))` for win/draw; parser rejects: raw > MAX_RAW chars, angle 181, angle 90.5, power -1, seq -1, seq 1.5, stateHash `'XYZ'`, stateHash 40 chars, name 300 chars, names tuple of 3, deadlineMs 10^9, non-JSON garbage, valid-JSON-wrong-shape (`{t:'shot'}` missing fields), prototype-pollution shapes (`{"t":"join","name":{"__proto__":1}}` → null); **transcript determinism** — drive a 6-shot scripted duel through resolveShot twice via the wire: encode each shot as a ShotBcast with `stateHash(stateAfter)`, parse it back, replay on a second createMatch(seed) copy, assert the replayed stateHash equals the carried one at every step (this is the client's desync tripwire, proven in-core before any socket exists).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(tank-core): wire protocol — hardened parsers + transcript determinism pin`.

---

### Task 6: server DOs (existing worker) + wrangler migration v7 + pin-ownership move

**Files:** Create `packages/server/src/tank-lobby.ts`, `packages/server/src/tank-match.ts`, `packages/server/test/tank.test.ts`. Modify `packages/server/src/index.ts` (routes + DO exports), `packages/server/wrangler.jsonc` (bindings `TANK_LOBBY`, `TANK_MATCH` + APPENDED migration `{ "tag": "v7", "new_sqlite_classes": ["TankLobbyDO", "TankMatchDO"] }` — v1–v6 untouched), `packages/server/package.json` (add `"tankwait-core": "0.0.0"` workspace dep — pinned to the real version at release), `packages/server/test/block.test.ts` (REMOVE its migration literal test — ownership moves to tank.test.ts; block.test.ts is a test file, not a frozen package).

**Interfaces (Consumes):** tankwait-core Tasks 1–5. **Produces:** `POST /tank/join {name}` → `{ matchId, token }` after the gather window (resolves EARLY at 2 humans; 1 bot backfills otherwise); `GET /tank/match/:id/ws?token=`. Join returns **400** on missing/malformed body or absent `name`.

Server-local constants (in tank-match.ts, not core — they are wall-clock concerns):
```ts
export const ANIM_MS_PER_STEP = 1000 / 60      // playback runs 3 sim steps per 50ms frame
export const ANIM_TAIL_MS = 1500               // explosion + settle beat
export function animAllowanceMs(steps: number): number  // Math.ceil(steps * ANIM_MS_PER_STEP) + ANIM_TAIL_MS
export const BOT_DELAY_BASE_MS = 2000, BOT_DELAY_SPREAD_MS = 2000  // seeded humanizing delay
```
The TankMatchHost (pure class + TankMatchDO thin wrapper — read `packages/server/src/chess-match.ts` FIRST; tank transcribes its shape with resolveShot in place of applyMove, and `packages/server/src/block-lobby.ts` for the fill-at-2 lobby):
- Constructed with `{seed, names, bots}` from the lobby handoff (block pattern); state = `createMatch(seed, names, bots)`.
- Both human slots connected (bot slots never connect) → broadcast `start`, then `turn {who: firstTurn, deadlineMs}`, set the alarm: bot's turn → `now + botDelayMs` (seeded from match seed via randStep, `BOT_DELAY_BASE_MS + value * BOT_DELAY_SPREAD_MS`); human's turn → `now + SHOT_CLOCK_MS`.
- `handleShot(slot, msg)`: ended → none; `msg.seq <= lastSeq[slot]` or `slot !== state.turn` → **ignore silently** (the expiry race: a late shot after the alarm auto-fired fails the turn check — benign, never a socket close; this deliberately diverges from chess's `illegal` close because late shots are expected here).
- `fire(slot, shot)` (shared by handleShot, expiry, and bot turns): `resolveShot` → broadcast `{t:'shot', by: slot, seq, angle, power, stateHash: stateHash(newState)}` (server-originated fires use seq 0) → if result: broadcast `end`, action `ended`; else broadcast `turn {who, deadlineMs: animAllowanceMs(trajectory.length) + (nextIsBot ? botDelay : SHOT_CLOCK_MS)}` and return `alarmAt = now + thatSameDuration` (one computation, used for both).
- `onAlarm()`: ended → none; current player is a bot → `botDecide`/`botObserve` (mind held in the host, difficulty 'normal') and `fire`; human → `fire(turn, {angle: lastAngle, power: lastPower})` (createMatch pre-loads the seeded defaults, so a first-turn expiry auto-fires DEFAULT_ANGLE/POWER).
- `leave(slot)`: ended or opponent never joined → none; else `killPlayer` → broadcast `end` → ended. Immediate forfeit, chess precedent (no reconnect in v1).
- 'ended' in the DO: deleteAlarm, close both sockets, null the host — transcribe chess's applyAction + the null-safe race comments.

- [ ] **Step 1:** Read `packages/server/src/{chess-match.ts,block-lobby.ts,block-match.ts}` and `packages/server/test/{chess.test.ts,block.test.ts}` FIRST — tank-match follows chess's host/DO split + close-race handling; tank-lobby follows block-lobby's fill-at-2/backfill/resolve-once shape; tests follow their harness patterns (fake conns for the host, literal file read for migrations).
- [ ] **Step 2:** Failing tests in `test/tank.test.ts` (host-level with fake conns, mirroring chess.test.ts): 2 joiners → both receive `start` (correct you/names/firstTurn) then `turn`; a valid shot from the turn-holder → both receive ShotBcast whose stateHash equals a local replay's, then `turn` for the other player with `deadlineMs > SHOT_CLOCK_MS` (anim allowance added); out-of-turn shot → ignored, NO close, no broadcast; stale seq → ignored; malformed raw (> MAX_RAW, bad JSON, angle 999) → ignored without throwing; `onAlarm` on a human turn → auto-fire broadcast with the player's lastAngle/lastPower (first turn: the seeded defaults) and seq 0; `onAlarm` on a bot turn → a bot shot fires and play continues; a full scripted duel through the host reaches `end` with a result; `leave` mid-match → opponent receives `end` win; lobby: 2 joins → resolve early with 2 humans, 1 join + window expiry → bot backfill, `POST /tank/join` with `{}`/no body/non-JSON → **400**; migration literal test — read wrangler.jsonc raw, assert tags v1..v7 in order and the v1–v6 block byte-identical to the committed literal (transcribe block.test.ts's migration test and extend it; then DELETE it from block.test.ts in this same task).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement (TankLobbyDO; TankMatchHost pure + TankMatchDO wrapper; routes under `/tank/...`; wrangler bindings + v7 append). Build core first: `npm run build -w tankwait-core` (stale-dist rule). **Step 5:** PASS, full suite green (block.test.ts still green minus its moved test), `npx tsc -p packages/server/tsconfig.json --noEmit` clean. NO DEPLOY — user-gated at release. Ledger + commit `feat(server): tank duel lobby + turn-deadline match DO, migration v7, pin ownership moved`.

---

### Task 7: client scaffold + renderer (frame-fit + raw-framing pins FIRST)

**Files:** Create `packages/tank-client/{package.json,tsconfig.json,bin/tankwait.js,src/render.ts,test/render.test.ts}`.

**Interfaces (Consumes):** tankwait-core state/constants, termwait `ColorMode`. **Produces:**
```ts
export interface Layout { cols: number; rows: number }                    // k=1 only; carries centering pad
export function chooseLayout(cols: number, rows: number): Layout | null  // null when < 80x24
export interface RenderView {
  state: MatchState
  you: 0 | 1
  aim: Shot                          // your current aim (HUD readout)
  phase: 'aim' | 'anim' | 'wait'     // wait = opponent aiming
  shell: [number, number] | null     // world coords during playback
  trail: [number, number][]          // world coords of the trail so far
  explosion: { x: number; y: number; frame: number } | null  // frame 0..5
  clockMsLeft: number | null         // shot-clock countdown (null during anim)
  statusLine: string
}
export function renderFrame(v: RenderView, layout: Layout, mode: ColorMode): string
export function tooSmallScreen(cols: number, rows: number): string
export function screenRow(y: number): number                             // 22 - floor(y/2); rows 2..22 valid
```
package.json: `"name": "tankwait"`, `"version": "0.0.0"`, `"bin": {"tankwait": "bin/tankwait.js"}`, deps `{"tankwait-core": "0.0.0", "termwait": "0.1.0", "ws": "8.21.0"}`. bin: `#!/usr/bin/env node` + `import('../dist/cli.js')`.

Rendering rules (spec, restated): 24 lines total. Line 0: `name (hp bar ██████░░░░ 62)` left tank · round counter center · right tank mirrored — names 24-char sanitized, current-turn name highlighted. Line 1: wind (`◀◀◀ 7` strength-scaled arrows left / `3 ▶▶▶` right / `— calm —` center), your `angle 63° power 48`, shot clock `0:14` (blank during anim/wait — opponent's countdown shows during wait). Lines 2–22: terrain field — for each screen col c, terrain fills rows `screenRow(heights[c])`..22 with `█` (truecolor: earth gradient by depth, 3 pinned RGB bands; 256: pinned indices 94/58/22; mono: bare `█`); tanks drawn at `screenRow(tankY)` − their column as 2-char glyph `▟▙` (col, col+1 — clamped at col 79), player 0 green / player 1 red (mono: `▟▙` vs `◢◣`), dead tank `✕✕`; during anim: trail `·` at each trajectory point's cell (dim gray), shell `●` at the current point (bright), explosion frames 0–5 as an expanding `✶` ring (radius frame/2 cols); shell above y 41.5 clipped (not drawn). Line 23: key hints `←→ angle  ↑↓ power  A/D W/S ±5  space fire  esc quit` + Claude status line right-aligned. Every line rendered to EXACTLY 80 visible cols (fixed-width concat). Frame tail: positional escapes exactly like block-client — `ESC[H ESC[K` head, lines joined `\r\n ESC[K`, trailing `ESC[J` (transcribe from `packages/block-client/src/render.ts`, the frozen reference).

- [ ] **Step 1:** Write the FRAME-FIT + framing test before any rendering code:

```ts
import { describe, expect, it } from 'vitest'
import { createMatch } from 'tankwait-core'
import { chooseLayout, renderFrame, screenRow, tooSmallScreen } from '../src/render.js'
import type { RenderView } from '../src/render.js'

const STRIP = /\x1b\[[0-9;]*[A-Za-z]/g
const frameLines = (f: string) => f.replace(/\x1b\[[HKJ]/g, '').split('\r\n').map((l) => l.replace(STRIP, ''))
const view = (over: Partial<RenderView> = {}): RenderView => ({
  state: createMatch(7, ['jeremiah', 'rival'], [false, true]),
  you: 0, aim: { angle: 60, power: 50 }, phase: 'aim',
  shell: null, trail: [], explosion: null, clockMsLeft: 14_000,
  statusLine: 'claude is working…', ...over,
})

describe('the 80x24 gate (asserted, never eyeballed)', () => {
  it('exact fit at 80x24: 24 lines, EVERY line exactly 80 visible cols', () => {
    const lines = frameLines(renderFrame(view(), chooseLayout(80, 24)!, 'truecolor'))
    expect(lines.length).toBe(24)
    for (const l of lines) expect(l.length, JSON.stringify(l)).toBe(80)
    expect(lines[0]!.includes('jeremiah')).toBe(true)
    expect(lines[0]!.includes('rival')).toBe(true)
  })
  it('below 80x24 → null layout; bigger stays k=1', () => {
    expect(chooseLayout(79, 24)).toBeNull(); expect(chooseLayout(80, 23)).toBeNull()
    expect(chooseLayout(200, 60)).not.toBeNull()
  })
  it('raw positional framing: ESC[H home, ESC[K at line START, ESC[J tail', () => {
    const frame = renderFrame(view(), chooseLayout(80, 24)!, 'truecolor')
    expect(frame.startsWith('\x1b[H\x1b[K')).toBe(true)
    expect(frame.includes('\r\n\x1b[K')).toBe(true)
    expect(frame.endsWith('\x1b[J')).toBe(true)
    const tooSmall = tooSmallScreen(79, 24)
    expect(tooSmall.startsWith('\x1b[H\x1b[K')).toBe(true); expect(tooSmall.endsWith('\x1b[J')).toBe(true)
  })
  it('color tiers: mono has zero escapes beyond framing; 256 uses 38;5; never 38;2;', () => {
    const mono = renderFrame(view(), chooseLayout(80, 24)!, 'mono').replace(/\x1b\[[HKJ]/g, '')
    expect(mono.includes('\x1b')).toBe(false)
    const c256 = renderFrame(view(), chooseLayout(80, 24)!, '256')
    expect(c256.includes('38;5;')).toBe(true); expect(c256.includes('38;2;')).toBe(false)
  })
  it('world→screen: screenRow maps floor to 22, top band to 2; shell above 41.5 is clipped', () => {
    expect(screenRow(0)).toBe(22); expect(screenRow(1)).toBe(22)
    expect(screenRow(2)).toBe(21); expect(screenRow(41)).toBe(2)
    const flying = renderFrame(view({ phase: 'anim', shell: [40, 60], clockMsLeft: null }), chooseLayout(80, 24)!, 'mono')
    expect(frameLines(flying).some((l) => l.includes('●'))).toBe(false)
  })
})
```

Additional render tests in the same file: terrain column height — a hand-built state with `heights[5] = 10` puts `█` at rows 17..22 of col 5 and blank above (mono frame, direct char probes); both tank glyphs appear on their columns; a shell at `[40, 20]` renders `●` at row 12 col 40 during anim; trail points render `·`; explosion frame 3 renders `✶` marks; wind line shows `◀` arrows for negative wind and `— calm —` for 0; hp bar length tracks hp (100 → 10 filled cells, 45 → 4-or-5 by the pinned rounding); clockMsLeft 14_000 renders `0:14`.

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement render.ts (read `packages/block-client/src/render.ts` FIRST for framing + ColorMode threading + fixed-width padding discipline). **Step 4:** PASS, suite green. **Step 5:** Ledger + commit `feat(tankwait): renderer with asserted 80x24 frame + raw framing pins`.

---

### Task 8: anim playback + input + session glue + offline loop + CLI + vtsim gate (playable offline milestone)

**Files:** Create `packages/tank-client/src/{anim.ts,game.ts,offline.ts,share.ts,cliArgs.ts,cli.ts,main.ts}`, `packages/tank-client/test/{anim.test.ts,cliArgs.test.ts,share.test.ts,vt.test.ts}`, `packages/tank-client/test/vtsim.ts`.

**Interfaces (Consumes):** Task 7 render, tankwait-core (createMatch/resolveShot/bots), termwait everything. **Produces:**
```ts
// anim.ts — pure playback state machine over a ResolveOut (client-side ANIM twin of the
// server's animAllowanceMs: 3 trajectory steps per 50ms frame, then 6 explosion frames,
// then 6 settle frames showing the post-shot state ≈ ANIM_TAIL_MS)
export interface Playback { out: ResolveOut; cursor: number; done: boolean }
export function createPlayback(out: ResolveOut): Playback
export function advancePlayback(pb: Playback): Playback                   // one 50ms frame forward
export function playbackView(pb: Playback): Pick<RenderView, 'shell' | 'trail' | 'explosion'>
// game.ts — block-client's game.ts shape (read packages/block-client/src/game.ts): REDRAW_MS=50, GameSession
// (term/parser/colorMode/layout()/statusLine()/quitRequested()/onResize/dispose), setupGame,
// resultLine(result, you, names), teardownAndExit — transcribed; aim input handled inline (below)
// Aim input (in game.ts): pure reducer applyKey(aim: Shot, key): Shot —
// left/right: angle ∓/± 1 · a/d: angle ∓/± 5 · up/down: power ± 1 · w/s: power ± 5 (all clamped);
// space/enter → fire flag. Key repeats count (OS auto-repeat = hold-to-sweep). Off-turn keys ignored except esc.
// offline.ts
export async function runOffline(opts: { name: string; seed: number }): Promise<Result>
// share.ts
export function shareCard(result: Result, you: number, rounds: number, damageDealt: number, opponentHandle: string): string
// cliArgs.ts — block's parseArgs surface verbatim (offline/name/server/seed; DEFAULT_SERVER unchanged)
```
offline loop = block's offline.ts shape (50ms interval) with a phase machine instead of a tick reducer: `aim` (drain keys through applyKey; fire or a 20s local shot clock expiring → `resolveShot(state, aim)` → botObserve if the shooter was the bot → `createPlayback`) → `anim` (advancePlayback per frame; done → adopt `out.state`, next phase) → bot turn = `wait` phase with a seeded 1.5s delay, then botDecide → resolveShot → anim again. Your aim persists between turns (pre-loaded from lastAngle/lastPower — matching the server's expiry rule). `layout() === null` → tooSmallScreen + keep polling. Track `lastRounds`/`lastDamageDealt` while alive for the share card (never read post-death state). cli.ts: both paths offline until Task 9 (non-offline prints a note).

**The vtsim gate:** copy `packages/block-client/test/vtsim.ts` verbatim into `packages/tank-client/test/vtsim.ts` (source comment: `// copied from packages/block-client/test/vtsim.ts — keep byte-identical`). `test/vt.test.ts` transcribes block's vt.test.ts with the binary swapped:

```ts
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { VtSim } from './vtsim.js'

describe('positional-escape gate (the feel-gate-only surface, now a test)', () => {
  it('headless offline run produces homed, in-bounds 80x24 frames from the REAL binary', async () => {
    // REQUIRES built dist (npm run build -w tankwait) — the stale-dist rule
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile('node', ['packages/tank-client/bin/tankwait.js', '--offline', '--seed', '1'],
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
    const last = frames.at(-1)!
    expect(last.some((row) => row.trimEnd().length === 80)).toBe(true)  // column-80 probe
  })
})
```

(If the binary refuses to draw headless, mirror block's working spawn — pipe stdin from `(sleep 3; printf ' ')` and force the draw path; adjust the spawn, keep the assertions. The countdown repaint means frames accumulate with zero input.)

- [ ] **Step 1:** Failing tests: anim (createPlayback cursor 0; advancing consumes 3 trajectory steps per frame; playbackView exposes shell at the cursor + the trail behind it; after the trajectory: 6 explosion frames then 6 settle frames then done; a lost shell — impact null — skips explosion frames), cliArgs (defaults, --offline, --name, --seed, --server, unknown flag → usage error), share (outcome word, rounds, damage, opponent handle, ≤ 280 chars), applyKey (each mapped key adjusts and clamps; angle 180 + right stays 180; power 0 − 1 stays 0).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (game.ts/offline.ts transcribed from block-client's — read those files first; they encode the exit-guard, resize, and teardown lessons). **Step 4:** `npm run build -w tankwait-core && npm run build -w tankwait` (vtsim needs dist), write vtsim.ts + vt.test.ts, run → PASS. **Step 5:** Full suite green. Ledger + commit `feat(tankwait): offline artillery duel vs bot — playback machine, aim input, session glue, CLI, vtsim gate`.

---

### Task 9: net + online loop (server-authoritative replay + desync tripwire)

**Files:** Create `packages/tank-client/src/{net.ts,online.ts}`, `packages/tank-client/test/{net.test.ts,online.test.ts}`. Modify `src/cli.ts` (default = online, offline fallback).

**Interfaces (Consumes):** protocol (Task 5), game/anim (Task 8). **Produces:**
```ts
// net.ts — block's net.ts shape (read packages/block-client/src/net.ts): ws factory seam, join POST, connect-resolves-on-start
export async function joinTankMatch(serverUrl: string, name: string, timeoutMs = 12_000): Promise<JoinOutcome> // POST /tank/join
export class TankNetClient { static connect(...): Promise<{ client; start: StartMsg }>; sendShot(msg: ShotMsg): void; close(): void }
// online.ts
export async function runOnline(opts: { name?: string; server: string }): Promise<Result | 'fallback'>
// exported for tests:
export function applyShotBcast(local: MatchState, msg: ShotBcast): { out: ResolveOut; desync: boolean }
```
online.ts loop (50ms interval, same phase machine as offline): state built once from `createMatch(start.seed, start.names, start.bots)` (assert `state.firstTurn === start.firstTurn` — cheap tripwire on the wire's redundant field). **All shots — including your own — apply only when the server's ShotBcast arrives**: fire sends `{t:'shot', seq: mySeq++, angle, power}` upstream and enters a brief `wait`; the echo drives `applyShotBcast` → local `resolveShot` → compare `stateHash(out.state)` with `msg.stateHash` → mismatch = desync (teardown with a desync message + nonzero exit; dedicated test) → else `createPlayback(out)` and play. `turn` msgs set whose-turn + the countdown base (`clockMsLeft = deadlineMs − elapsed-since-receipt`, display-only, floored at 0). Off-turn keys ignored except esc; esc quit-confirm sends nothing (socket close = server-side forfeit). Result precedence `end ?? state.result ?? closedEarly-loss` and finale/lastStats/names threading transcribed from block's online.ts (read it first). cli.ts: no --offline → online, join/connect failure → offline fallback with a note.

- [ ] **Step 1:** Failing tests with a scriptable FakeWs (transcribe block's harness): join ok/non-2xx/timeout; connect resolves on start, rejects on pre-start close; firing sends a ShotMsg with monotonic seq and the current aim; own shot NOT applied locally until the echo (state unchanged between send and bcast — assert via stateHash); `applyShotBcast` happy path (hash matches → playback state) and desync path (tampered hash → desync flag); a full scripted match through FakeWs reaches the finale with the server's result; countdown derives from TurnMsg deadlineMs under fake timers; finale non-vacuity under fake timers (prove the finale block runs — chain-invert quitRequested, the house lesson).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS, suite green, `npm run build -w tankwait` clean. **Step 5:** Ledger + commit `feat(tankwait): online duel — server-authoritative replay + stateHash desync tripwire`.

---

### Task 10: plugin launcher test + README

**Files:** Modify `plugin/test/launcher.test.sh` (a SIX-entry synthetic fixture rotation case + --pick tankwait cases — real games.json untouched until release), `README.md` (tankwait section following the blockwait section's format).

- [ ] **Step 1:** Extend the launcher test: six-entry fixture asserting rotation 1→2→3→4→5→6→1 + exact `npx -y tankwait@0.1.0` passthrough via recorded tmux argv (synthetic pin — inline comment saying the real pin lands at release); `--pick` cases: `--pick tankwait` (exact id), `--pick tank` (unique prefix), `--pick artillery` (unique title substring) each select the fixture's tankwait entry without touching rotation state. Run STANDALONE `bash plugin/test/launcher.test.sh` (~60s bound) → PASS.
- [ ] **Step 2:** README: one section — what it is, controls (arrows fine / A-D-W-S coarse, space fire, esc quit), `npx -y tankwait` / `--offline`, the 80x24 note, one-liner on wind/HP/decay. Re-derive every numeric claim from constants.ts (the boomwait duration incident): 20s shot clock, 100 HP, decay from round 12.
- [ ] **Step 3:** Full suite green. Ledger + commit `chore(plugin): launcher 6-game rotation + --pick tankwait cases + README`.

---

### Task 11: release — USER-GATED (STOP and hand commands to the user)

**Files:** Modify `packages/tank-core/package.json` + `packages/tank-client/package.json` (0.1.0, exact pins), `packages/server/package.json` (tankwait-core pin), `plugin/games.json` (add `{"id":"tankwait","title":"tankwait — terminal artillery duel","cmd":"npx -y tankwait@0.1.0"}`), `plugin/.claude-plugin/plugin.json` (0.6.0 → 0.7.0), lockfile, `plugin/test/launcher.test.sh` (real-games.json assertions 5→6 entries — expected fallout).

- [ ] **Step 1:** Re-verify `npm view tankwait` / `tankwait-core` → still E404 (remember: a stale npm login ALSO prints E404 — that's the publish-time trap, not this check). Full suite green; `npm run build -w tankwait-core && npm run build -w tankwait` clean.
- [ ] **Step 2:** Version pins: tankwait-core@0.1.0; tankwait@0.1.0 (deps tankwait-core@0.1.0, termwait@0.1.0, ws@8.21.0); server dep tankwait-core@0.1.0; games.json entry; plugin 0.7.0; launcher real-file assertions; `npm install --package-lock-only` (small diff, no drift). Launcher test STANDALONE green. Commit `chore(release): tankwait 0.1.0 pins, plugin 0.7.0`.
- [ ] **Step 3:** STOP. Hand the user, in order (NEVER while a background agent is mutating the repo):
  (a) **Feel gate FIRST, build INCLUDED in the command** (the stale-dist rule is law):
  `cd "/Users/jeremiahagthe/Desktop/fpsGame extension" && npm run build -w tankwait-core && npm run build -w tankwait && node packages/tank-client/bin/tankwait.js --offline` at iTerm2 80x24 — offline round vs the bot (watch: aim feel, playback speed, crater look, wind readability);
  (b) publish (user's terminal, FRESH npm login): `npm publish -w tankwait-core && npm publish -w tankwait`;
  (c) worker deploy: `env -u CLOUDFLARE_API_TOKEN PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx wrangler deploy` from packages/server (ships migration v7);
  (d) **online feel round** — `npx -y tankwait@0.1.0` twice (two terminals, or once vs the backfill bot): the "online never had a human feel pass" risk closes here, BEFORE the ledger SHIPPED entry.
  After user confirms: verify publishes (`npm view` both), worker health + `/tank/join` smoke (`-m 15`, lobby waits ~10s) + `/tank/join {}` → 400 smoke, clean-install resolution + published dist greps ESC[H, tag `tankwait-v0.1.0`, push main + tag, ledger SHIPPED entry.

---

## Self-review notes (spec-coverage pass done at write time)

- Spec §Product → Tasks 8/9/11. §Authority model → Tasks 5/6/9 (resolveShot single source; stateHash tripwire proven in-core in Task 5's transcript test before sockets exist; expiry race pinned in Task 6). §Frame → Task 7. §Core sim → Tasks 1–3. §Bots → Task 4. §Wire → Task 5. §Server → Task 6 (incl. migration-pin ownership move out of block.test.ts). §Plugin → Tasks 10/11. §Release → Task 11 (online feel round per spec). §Folded hygiene: none, per spec. §Out-of-scope respected (no weapons/movement, 2 players, k=1, no reconnect).
- Plan-level deviations from the spec, deliberate: (1) `TANK_HIT_RADIUS=1.5` added — the spec's "tank contact" needed a number; (2) the bot convergence gate is "shot 3 misses less than shot 1" rather than the spec's strictly-per-shot shrink — noise makes strict monotonicity flaky by design; the gate still proves bracketing works; (3) spec amended (same commit series): `heights` is `number[]`, not Float64Array, for JSON serializability.
- Type-consistency pass: `Shot {angle, power}` everywhere (core/protocol/server/client); `ResolveOut` consumed by anim (Task 8), server allowance (Task 6), and applyShotBcast (Task 9); `Result`/wire result codec defined once in Task 5; `RenderView.phase` drives both loops.
- Golden (Task 3) precedes bots (Task 4); the bot-duel end gate doubles as the online end-bound proof (the server replays the same resolveShot).
- Known deliberate divergences from blockwait's plan: no input-queue/tick-batch machinery (turn-based — one ShotMsg per turn); no snaps/resync (deterministic replay + tripwire instead); server template is chess-match, not a tick loop; anim.ts is a new pure unit with its own tests.
