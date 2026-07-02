# fragwait Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship fragwait v0.1.0 — a terminal-rendered multiplayer FPS Claude Code plugin: shared deterministic sim, offline-playable raycaster client, Cloudflare Durable Objects match server, and a Claude Code plugin that launches the game and pulls the player back when Claude finishes.

**Architecture:** One deterministic TypeScript sim package (`@fragwait/core`) runs as both client prediction and server authority. The terminal client (`fragwait` on npm) renders a half-block raycaster and works fully offline against bots. A Cloudflare Worker with a Lobby DO (per continent) and Match DOs (per match, 20 Hz tick) provides multiplayer. A Claude Code plugin (hooks + skill + launcher) integrates launch and "Claude finished" notification via sanctioned surfaces only.

**Tech Stack:** TypeScript 5.x (strict, ESM/NodeNext), Node ≥ 20, npm workspaces, vitest, `ws` (client's only runtime dep), Cloudflare Workers + Durable Objects (wrangler), bash for plugin hooks.

**Spec:** `docs/superpowers/specs/2026-07-02-fragwait-design.md` — read it before starting. Milestone order and the feel gate (after Task 15) are non-negotiable.

## Global Constraints

- Node ≥ 20; TypeScript `strict: true`; ESM only (`module: NodeNext`, imports use `.js` extensions).
- Exact dependency pins (`"x.y.z"`, never `^`/`~`). Versions below are known-good floors; at execution time resolve current with `npm view <pkg> version` and pin that exact value.
- `packages/core` has ZERO runtime dependencies and never calls `Date.now()`, `new Date()`, or `Math.random()` — time is a tick counter, randomness is the seeded PRNG in `prng.ts`.
- `packages/client` runtime deps: exactly one — `ws`. Everything else is hand-rolled (supply-chain policy: copy small utilities, don't depend).
- MIT license, `LICENSE` at repo root. No telemetry anywhere. The client and plugin write only under `~/.fragwait/` (and the repo itself).
- Terminal state restore is a hard invariant: every exit path (quit, SIGINT, SIGTERM, uncaught exception) pops kitty keyboard flags, shows cursor, leaves alt screen, disables raw mode.
- Package names: `@fragwait/core` (published), `fragwait` (client, published), `@fragwait/server` (private), plugin is not an npm package.
- Game constants live only in `packages/core/src/constants.ts`; never duplicate literal values.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Milestone C (netcode/server) MUST NOT start until the Milestone B feel gate (Task 15, Step "Feel gate") passes with the user's explicit sign-off.

## Deliberate deviation from the spec (flag to the user at execution start)

- Spec §6 specifies a "5 s reconnect window w/ resume token" on WebSocket drop. Phase 1 ships without resume tokens: a dropped socket returns the player to the menu / offline fallback, and rejoining through the lobby (drop-in) restores near-equivalent UX. Scores are banked per-frag anyway. Revisit post-launch if drops are reported.

## File Structure

```
fragwait/                                (this repo, /Users/jeremiahagthe/Desktop/fpsGame extension)
  package.json                           # npm workspaces root (private)
  tsconfig.base.json                     # shared strict TS config
  vitest.config.ts                       # single test runner for all packages
  LICENSE                                # MIT
  .gitignore
  .claude-plugin/marketplace.json        # repo doubles as a Claude Code plugin marketplace
  packages/core/                         # @fragwait/core — deterministic sim (zero deps)
    package.json  tsconfig.json
    src/constants.ts                     # all tunables
    src/types.ts                         # Vec2, PlayerInput, PlayerState, MatchState, ...
    src/map.ts                           # GameMap, parseMap, isWall
    src/maps.ts                          # 3 built-in maps (ASCII grids)
    src/prng.ts                          # mulberry32, fnv1a
    src/names.ts                         # anonymous handle generator (embedded word lists)
    src/movement.ts                      # stepPlayer (shared by prediction + authority)
    src/combat.ts                        # castWall (DDA), fireHitscan
    src/room.ts                          # MatchRoom: authoritative match state machine
    src/bots.ts                          # BotBrain (same PlayerInput interface as humans)
    src/protocol.ts                      # ClientMsg/ServerMsg + validating parsers
    src/index.ts                         # public re-exports
    test/*.test.ts
  packages/client/                       # fragwait — terminal client CLI
    package.json  tsconfig.json
    bin/fragwait.js                      # #!/usr/bin/env node shim
    src/cli.ts                           # arg parsing, mode dispatch (play/doctor/--offline)
    src/caps.ts                          # color-mode + terminal capability detection
    src/framebuffer.ts                   # pixel buffer + diffing ANSI renderer (half-block)
    src/raycast.ts                       # column raycaster: walls, sprites, crosshair
    src/hud.ts                           # status rows, HP bar, kill feed, Claude-busy line
    src/input/parser.ts                  # escape-sequence → KeyEvent (incl. kitty CSI-u)
    src/input/intent.ts                  # KeyEvents → per-tick PlayerInput (tier1/tier2)
    src/terminal.ts                      # raw mode, alt screen, kitty push/pop, restore invariant
    src/claude.ts                        # localhost listener, ~/.fragwait/client.json, busy files
    src/offline.ts                       # offline match loop vs bots
    src/net/client.ts                    # WebSocket wrapper + 10 Hz input batching
    src/net/predictor.ts                 # local prediction + reconciliation
    src/net/interp.ts                    # remote snapshot interpolation
    src/online.ts                        # online match loop
    src/doctor.ts                        # capability report
    test/*.test.ts
  packages/server/                       # @fragwait/server — CF Worker + DOs (private)
    package.json  tsconfig.json  wrangler.jsonc
    src/index.ts                         # Worker router
    src/match-host.ts                    # transport-agnostic match hosting (unit-testable)
    src/match-do.ts                      # MatchDO: thin DO wrapper around MatchHost
    src/lobby-logic.ts                   # pure open-match registry (unit-testable)
    src/lobby-do.ts                      # LobbyDO: thin DO wrapper
    scripts/soak.ts                      # bot/synthetic-client soak + cost check
    test/*.test.ts
  plugin/                                # Claude Code plugin
    .claude-plugin/plugin.json
    hooks/hooks.json  hooks/busy.sh  hooks/notify.sh
    skills/play/SKILL.md
    bin/fragwait-launch
    test/hooks.test.sh
  docs/superpowers/specs/2026-07-02-fragwait-design.md   (exists)
  docs/superpowers/plans/2026-07-02-fragwait-phase1.md   (this file)
```

---

# Milestone A — `@fragwait/core`: the deterministic game

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `LICENSE`, `.gitignore`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`

**Interfaces:**
- Produces: a repo where `npm install` and `npm test` succeed; all later tasks assume this layout and the root test command `npx vitest run`.

- [ ] **Step 1: Resolve current dependency versions**

Run and record outputs (pin these exact values in the files below in place of the floors shown):
```bash
npm view typescript version && npm view vitest version && npm view @types/node version
```

- [ ] **Step 2: Create root files**

`package.json`:
```json
{
  "name": "fragwait-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "build": "npm run build --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "vitest": "3.0.5",
    "@types/node": "20.17.10"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    passWithNoTests: true,
  },
})
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.wrangler/
```

`LICENSE`: standard MIT text, copyright line `Copyright (c) 2026 fragwait contributors`.

- [ ] **Step 3: Create @fragwait/core package**

`packages/core/package.json`:
```json
{
  "name": "@fragwait/core",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0'
```

- [ ] **Step 4: Verify install, test, build**

Run: `npm install && npm test && npm run build`
Expected: install clean; vitest reports "no tests" but exits 0; tsc emits `packages/core/dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold with @fragwait/core

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Core constants and types

**Files:**
- Create: `packages/core/src/constants.ts`, `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/constants.test.ts`

**Interfaces:**
- Produces (used by every later task — exact names):
  - constants: `TICK_RATE=20`, `TICK_MS=50`, `MATCH_TICKS=3600`, `MOVE_SPEED`, `TURN_SPEED`, `PLAYER_RADIUS=0.3`, `HIT_RADIUS=0.45`, `MAX_HP=100`, `BLASTER_DMG=25`, `BLASTER_COOLDOWN_TICKS=10`, `RAIL_DMG=100`, `RAIL_RESPAWN_TICKS=600`, `RAIL_PICKUP_RADIUS=0.6`, `SPAWN_PROTECTION_TICKS=40`, `MIN_COMBATANTS=4`, `MAX_PLAYERS=8`, `INPUT_BATCH_MS=100`, `INTERP_DELAY_MS=120`, `MAX_WALL_DIST=64`
  - types: `Vec2 {x,y}`, `Weapon = 'blaster'|'rail'`, `PlayerInput {seq, forward, strafe, turn, fire}`, `PlayerState {id, handle, bot, pos, dir, hp, frags, deaths, fireCooldown, spawnProtection, hasRail, lastInputSeq}`, `RailState {pos, present, respawnTimer}`, `KillEvent {tick, killerId, victimId, weapon}`, `MatchState {tick, timeLeftTicks, mapId, players, rail, kills}`

- [ ] **Step 1: Write the failing test**

`packages/core/test/constants.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MATCH_TICKS, TICK_MS, TICK_RATE } from '../src/constants.js'

describe('constants', () => {
  it('tick math is consistent', () => {
    expect(TICK_MS * TICK_RATE).toBe(1000)
    expect(MATCH_TICKS).toBe(3 * 60 * TICK_RATE)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/constants.test.ts`
Expected: FAIL — cannot find module `../src/constants.js`.

- [ ] **Step 3: Implement**

`packages/core/src/constants.ts`:
```ts
export const TICK_RATE = 20
export const TICK_MS = 1000 / TICK_RATE
export const MATCH_TICKS = 3 * 60 * TICK_RATE

export const MOVE_SPEED = 3.2 / TICK_RATE // map cells per tick
export const TURN_SPEED = 2.6 / TICK_RATE // radians per tick
export const PLAYER_RADIUS = 0.3
export const HIT_RADIUS = 0.45 // generous, replaces lag compensation (spec §4.3)

export const MAX_HP = 100
export const BLASTER_DMG = 25
export const BLASTER_COOLDOWN_TICKS = 10
export const RAIL_DMG = 100
export const RAIL_RESPAWN_TICKS = 30 * TICK_RATE
export const RAIL_PICKUP_RADIUS = 0.6
export const SPAWN_PROTECTION_TICKS = 2 * TICK_RATE

export const MIN_COMBATANTS = 4
export const MAX_PLAYERS = 8

export const INPUT_BATCH_MS = 100 // client → server packet cadence (free-tier friendly)
export const INTERP_DELAY_MS = 120 // remote-player render delay
export const MAX_WALL_DIST = 64
```

`packages/core/src/types.ts`:
```ts
export interface Vec2 { x: number; y: number }

export type Weapon = 'blaster' | 'rail'

export interface PlayerInput {
  seq: number
  forward: -1 | 0 | 1
  strafe: -1 | 0 | 1
  turn: -1 | 0 | 1
  fire: boolean
}

export interface PlayerState {
  id: string
  handle: string
  bot: boolean
  pos: Vec2
  dir: number // radians
  hp: number
  frags: number
  deaths: number
  fireCooldown: number // ticks
  spawnProtection: number // ticks of invulnerability; firing cancels it
  hasRail: boolean
  lastInputSeq: number
}

export interface RailState { pos: Vec2; present: boolean; respawnTimer: number }

export interface KillEvent { tick: number; killerId: string; victimId: string; weapon: Weapon }

export interface MatchState {
  tick: number
  timeLeftTicks: number
  mapId: string
  players: Record<string, PlayerState>
  rail: RailState
  kills: KillEvent[] // events from the current tick only (transient)
}
```

`packages/core/src/index.ts` (replace content):
```ts
export * from './constants.js'
export * from './types.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): game constants and state types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Map format, parser, and the three built-in maps

**Files:**
- Create: `packages/core/src/map.ts`, `packages/core/src/maps.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/map.test.ts`

**Interfaces:**
- Consumes: `Vec2`, `MAX_PLAYERS` from Task 2.
- Produces:
  - `interface GameMap { id: string; name: string; width: number; height: number; walls: boolean[]; spawns: Vec2[]; railSpawn: Vec2 }`
  - `isWall(map: GameMap, cx: number, cy: number): boolean` — integer cell coords; out-of-bounds counts as wall
  - `parseMap(id: string, name: string, text: string): GameMap` — throws if fewer than `MAX_PLAYERS` spawns or no rail cell
  - `MAPS: GameMap[]` — ids `node_modules`, `legacy_monolith`, `microservices`
  - `mapById(id: string): GameMap` — throws on unknown id

- [ ] **Step 1: Write the failing tests**

`packages/core/test/map.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from '../src/constants.js'
import { isWall, parseMap } from '../src/map.js'
import { MAPS, mapById } from '../src/maps.js'

const TINY = `
#####
#S.R#
#.#.#
#S.S#
#####
`

describe('parseMap', () => {
  it('parses walls, spawns, rail at cell centers', () => {
    // relax MAX_PLAYERS check via a map with enough spawns? No — TINY is for geometry:
    // parseMap enforces spawns >= MAX_PLAYERS, so expect the throw here.
    expect(() => parseMap('tiny', 'Tiny', TINY)).toThrow(/spawns/)
  })
  it('geometry: isWall and centers via a big-enough map', () => {
    const rows = ['##########', '#SSSSSSSS#', '#...R....#', '##########'].join('\n')
    const m = parseMap('t', 'T', rows)
    expect(m.width).toBe(10)
    expect(m.height).toBe(4)
    expect(isWall(m, 0, 0)).toBe(true)
    expect(isWall(m, 1, 1)).toBe(false)
    expect(isWall(m, -1, 2)).toBe(true) // out of bounds = wall
    expect(m.spawns[0]).toEqual({ x: 1.5, y: 1.5 })
    expect(m.railSpawn).toEqual({ x: 4.5, y: 2.5 })
  })
})

describe('built-in maps', () => {
  it('has the three spec maps', () => {
    expect(MAPS.map((m) => m.id).sort()).toEqual(['legacy_monolith', 'microservices', 'node_modules'])
    expect(() => mapById('nope')).toThrow()
  })
  for (const id of ['node_modules', 'legacy_monolith', 'microservices']) {
    it(`${id}: enclosed, ${MAX_PLAYERS}+ spawns, rail reachable from every spawn`, () => {
      const m = mapById(id)
      expect(m.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS)
      // border fully walled
      for (let x = 0; x < m.width; x++) {
        expect(isWall(m, x, 0)).toBe(true)
        expect(isWall(m, x, m.height - 1)).toBe(true)
      }
      for (let y = 0; y < m.height; y++) {
        expect(isWall(m, 0, y)).toBe(true)
        expect(isWall(m, m.width - 1, y)).toBe(true)
      }
      // flood fill from first spawn reaches all spawns + rail
      const seen = new Set<string>()
      const queue = [[Math.floor(m.spawns[0]!.x), Math.floor(m.spawns[0]!.y)]]
      while (queue.length) {
        const [cx, cy] = queue.pop()!
        const key = `${cx},${cy}`
        if (seen.has(key) || isWall(m, cx!, cy!)) continue
        seen.add(key)
        queue.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1])
      }
      for (const s of m.spawns) expect(seen.has(`${Math.floor(s.x)},${Math.floor(s.y)}`)).toBe(true)
      expect(seen.has(`${Math.floor(m.railSpawn.x)},${Math.floor(m.railSpawn.y)}`)).toBe(true)
    })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/map.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the parser**

`packages/core/src/map.ts`:
```ts
import { MAX_PLAYERS } from './constants.js'
import type { Vec2 } from './types.js'

export interface GameMap {
  id: string
  name: string
  width: number
  height: number
  walls: boolean[]
  spawns: Vec2[]
  railSpawn: Vec2
}

export function isWall(map: GameMap, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return true
  return map.walls[cy * map.width + cx] ?? true
}

export function parseMap(id: string, name: string, text: string): GameMap {
  const rows = text.split('\n').map((r) => r.trimEnd()).filter((r) => r.length > 0)
  const height = rows.length
  const width = Math.max(...rows.map((r) => r.length))
  const walls = new Array<boolean>(width * height).fill(false)
  const spawns: Vec2[] = []
  let railSpawn: Vec2 | null = null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y]![x] ?? '#' // short rows are wall-padded
      if (ch === '#') walls[y * width + x] = true
      else if (ch === 'S') spawns.push({ x: x + 0.5, y: y + 0.5 })
      else if (ch === 'R') railSpawn = { x: x + 0.5, y: y + 0.5 }
    }
  }
  if (spawns.length < MAX_PLAYERS) throw new Error(`${id}: needs >= ${MAX_PLAYERS} spawns, got ${spawns.length}`)
  if (!railSpawn) throw new Error(`${id}: missing R rail-pickup cell`)
  return { id, name, width, height, walls, spawns, railSpawn }
}
```

- [ ] **Step 4: Author the three maps**

`packages/core/src/maps.ts` — 24×24 grids; `#` wall, `.` floor, `S` spawn (8 each), `R` rail pickup. If the reachability test fails, connect the offending region with `.` cells — keep exactly 8 `S` and 1 `R` per map.

```ts
import { type GameMap, parseMap } from './map.js'

const NODE_MODULES = `
########################
#S...........#........S#
#.#####.####.#.#####.#.#
#.#...#.#..#...#...#.#.#
#.#.#.#.#.##.###.#.#.#.#
#...#...#....#...#...#.#
###.#####.####.#####.#.#
#S..#.....#....#.....#.#
#.#.#.###.#.####.###...#
#.#.#...#.#....#...#.#.#
#.#.###.#.####.###.#.#.#
#.#.....#..R...#...#.#S#
#.#.###.#.####.###.#.#.#
#.#...#.#....#...#.#.#.#
#.###.#.####.#.###.#.#.#
#S....#......#.....#..S#
#.####.######.#####.#.##
#.#..#.#....#.#...#.#..#
#.#.##.#.##.#.#.#.#.##.#
#...#....##...#.#....#.#
#.#.#.####.####.####.#.#
#S#.......#........#..S#
#...#####...######...#S#
########################
`

const LEGACY_MONOLITH = `
########################
#S....................S#
#......................#
#..####..........####..#
#..####..........####..#
#......................#
#......................#
#..##......##......##..#
#..##......##......##..#
#S.....................#
#......................#
#..........R...........#
#......................#
#.....................S#
#..##......##......##..#
#..##......##......##..#
#......................#
#......................#
#..####..........####..#
#..####..........####..#
#S....................S#
#......................#
#S....................S#
########################
`

const MICROSERVICES = `
########################
#S....#....#....#.....S#
#.....#....#....#......#
#..#..#.#..#..#.#..#...#
#.....#....#....#......#
##.#####.####.###.###.##
#.....#....#....#......#
#..#..#..#.#.#..#..#...#
#S....#....#....#.....S#
##.###.####.####.####.##
#.....#....#....#......#
#..#.......R........#..#
#.....#....#....#......#
##.####.####.####.###.##
#S....#....#....#.....S#
#..#..#..#.#.#..#..#...#
#.....#....#....#......#
##.###.#####.####.###.##
#.....#....#....#......#
#..#..#.#..#..#.#..#...#
#.....#....#....#......#
#S....#....#....#.....S#
#......................#
########################
`

export const MAPS: GameMap[] = [
  parseMap('node_modules', 'node_modules (a hedge maze)', NODE_MODULES),
  parseMap('legacy_monolith', 'legacy_monolith (one big arena)', LEGACY_MONOLITH),
  parseMap('microservices', 'microservices (too many corridors)', MICROSERVICES),
]

export function mapById(id: string): GameMap {
  const m = MAPS.find((x) => x.id === id)
  if (!m) throw new Error(`unknown map: ${id}`)
  return m
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './map.js'
export * from './maps.js'
```

- [ ] **Step 5: Run tests; repair grids if reachability fails**

Run: `npx vitest run packages/core/test/map.test.ts`
Expected: PASS. If a flood-fill assertion fails, the failing map has a sealed pocket — open a wall with `.` until connected (do not remove border walls).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(core): map format, parser, three built-in maps

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Movement and collision (`stepPlayer`)

**Files:**
- Create: `packages/core/src/movement.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/movement.test.ts`

**Interfaces:**
- Consumes: `GameMap`, `isWall`, constants, `PlayerInput`, `PlayerState`.
- Produces:
  - `stepPlayer(p: PlayerState, input: PlayerInput, map: GameMap): void` — mutates `p` in place (callers clone when they need immutability); applies turn, normalized move with axis-separated collision, sets `p.lastInputSeq = input.seq`. This exact function is the client prediction AND the server authority.
  - `wrapAngle(a: number): number` — normalize to (-π, π]
  - `makeInput(seq: number, partial?: Partial<Omit<PlayerInput,'seq'>>): PlayerInput` — convenience constructor (also used by tests/bots)

- [ ] **Step 1: Write the failing tests**

`packages/core/test/movement.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MOVE_SPEED, PLAYER_RADIUS } from '../src/constants.js'
import { parseMap } from '../src/map.js'
import { makeInput, stepPlayer, wrapAngle } from '../src/movement.js'
import type { PlayerState } from '../src/types.js'

const ROOM = parseMap('room', 'Room', [
  '##########',
  '#SSSSSSSS#',
  '#........#',
  '#...R....#',
  '#........#',
  '##########',
].join('\n'))

function player(x: number, y: number, dir = 0): PlayerState {
  return { id: 'p1', handle: 'h', bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

describe('stepPlayer', () => {
  it('moves forward along dir', () => {
    const p = player(5, 3, 0) // dir 0 = +x
    stepPlayer(p, makeInput(1, { forward: 1 }), ROOM)
    expect(p.pos.x).toBeCloseTo(5 + MOVE_SPEED)
    expect(p.pos.y).toBeCloseTo(3)
    expect(p.lastInputSeq).toBe(1)
  })
  it('never clips into walls (property)', () => {
    const p = player(1.5, 2.5, 0)
    let seq = 0
    // hammer the west wall for 200 ticks from every angle
    for (let i = 0; i < 200; i++) {
      p.dir = (i / 200) * Math.PI * 2
      stepPlayer(p, makeInput(++seq, { forward: 1, strafe: i % 3 === 0 ? 1 : 0 }), ROOM)
      expect(p.pos.x).toBeGreaterThanOrEqual(1 + PLAYER_RADIUS - 1e-9)
      expect(p.pos.y).toBeGreaterThanOrEqual(1 + PLAYER_RADIUS - 1e-9)
      expect(p.pos.x).toBeLessThanOrEqual(9 - PLAYER_RADIUS + 1e-9)
      expect(p.pos.y).toBeLessThanOrEqual(5 - PLAYER_RADIUS + 1e-9)
    }
  })
  it('slides along walls (axis-separated)', () => {
    const p = player(1.31, 3, Math.PI) // facing -x, against west wall
    stepPlayer(p, makeInput(1, { forward: 1, strafe: 1 }), ROOM) // strafe right = -y when facing -x
    expect(p.pos.x).toBeCloseTo(1.31, 1) // blocked in x
    expect(p.pos.y).not.toBeCloseTo(3) // free in y
  })
  it('diagonal speed is normalized', () => {
    const p = player(5, 3, 0)
    stepPlayer(p, makeInput(1, { forward: 1, strafe: 1 }), ROOM)
    const d = Math.hypot(p.pos.x - 5, p.pos.y - 3)
    expect(d).toBeCloseTo(MOVE_SPEED)
  })
})

describe('wrapAngle', () => {
  it('wraps into (-pi, pi]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(wrapAngle(0.5)).toBeCloseTo(0.5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/movement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/movement.ts`:
```ts
import { MOVE_SPEED, PLAYER_RADIUS, TURN_SPEED } from './constants.js'
import { type GameMap, isWall } from './map.js'
import type { PlayerInput, PlayerState } from './types.js'

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI)
  if (r > Math.PI) r -= 2 * Math.PI
  if (r <= -Math.PI) r += 2 * Math.PI
  return r
}

export function makeInput(seq: number, partial: Partial<Omit<PlayerInput, 'seq'>> = {}): PlayerInput {
  return { seq, forward: 0, strafe: 0, turn: 0, fire: false, ...partial }
}

function collides(map: GameMap, x: number, y: number): boolean {
  const r = PLAYER_RADIUS
  const minX = Math.floor(x - r)
  const maxX = Math.floor(x + r)
  const minY = Math.floor(y - r)
  const maxY = Math.floor(y + r)
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!isWall(map, cx, cy)) continue
      // circle vs cell AABB
      const nx = Math.max(cx, Math.min(x, cx + 1))
      const ny = Math.max(cy, Math.min(y, cy + 1))
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true
    }
  }
  return false
}

export function stepPlayer(p: PlayerState, input: PlayerInput, map: GameMap): void {
  p.dir = wrapAngle(p.dir + input.turn * TURN_SPEED)
  let dx = Math.cos(p.dir) * input.forward + Math.cos(p.dir + Math.PI / 2) * input.strafe
  let dy = Math.sin(p.dir) * input.forward + Math.sin(p.dir + Math.PI / 2) * input.strafe
  const len = Math.hypot(dx, dy)
  if (len > 0) {
    dx = (dx / len) * MOVE_SPEED
    dy = (dy / len) * MOVE_SPEED
    if (!collides(map, p.pos.x + dx, p.pos.y)) p.pos.x += dx
    if (!collides(map, p.pos.x, p.pos.y + dy)) p.pos.y += dy
  }
  p.lastInputSeq = input.seq
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './movement.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/movement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): stepPlayer movement with circle-vs-grid sliding collision

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Seeded PRNG and anonymous handle generator

**Files:**
- Create: `packages/core/src/prng.ts`, `packages/core/src/names.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/names.test.ts`

**Interfaces:**
- Produces:
  - `mulberry32(seed: number): () => number` — deterministic PRNG in [0,1)
  - `fnv1a(s: string): number` — 32-bit string hash
  - `handleFromSeed(seed: string): string` — stable `adjective-noun` handle (e.g. for machine-id)
  - `randomHandle(rng: () => number): string` — for bots

- [ ] **Step 1: Write the failing tests**

`packages/core/test/names.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { handleFromSeed, randomHandle } from '../src/names.js'
import { fnv1a, mulberry32 } from '../src/prng.js'

describe('prng', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
  it('fnv1a is stable', () => {
    expect(fnv1a('fragwait')).toBe(fnv1a('fragwait'))
    expect(fnv1a('a')).not.toBe(fnv1a('b'))
  })
})

describe('handles', () => {
  it('stable per seed, kebab-case', () => {
    expect(handleFromSeed('machine-1')).toBe(handleFromSeed('machine-1'))
    expect(handleFromSeed('machine-1')).toMatch(/^[a-z]+-[a-z]+$/)
    expect(handleFromSeed('machine-1')).not.toBe(handleFromSeed('machine-2'))
  })
  it('bot handles look identical in style to human handles', () => {
    expect(randomHandle(mulberry32(7))).toMatch(/^[a-z]+-[a-z]+$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/names.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/prng.ts`:
```ts
// mulberry32 + fnv1a: tiny public-domain-style utilities embedded per supply-chain
// policy (copied pattern, not a dependency). Source pattern: bryc/code PRNG notes.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
```

`packages/core/src/names.ts`:
```ts
import { fnv1a, mulberry32 } from './prng.js'

const ADJECTIVES = [
  'rebased', 'segfaulting', 'async', 'deprecated', 'polymorphic', 'memoized',
  'unhandled', 'refactored', 'greedy', 'lazy', 'volatile', 'immutable',
  'orphaned', 'shadowed', 'hoisted', 'leaky', 'recursive', 'blocking',
  'stale', 'flaky', 'minified', 'vendored', 'monkeypatched', 'idempotent',
] as const

const NOUNS = [
  'rustacean', 'sensei', 'linter', 'daemon', 'pointer', 'closure',
  'mutex', 'goroutine', 'lambda', 'kernel', 'compiler', 'debugger',
  'iterator', 'allocator', 'promise', 'thread', 'socket', 'buffer',
  'stacktrace', 'gopher', 'crab', 'wizard', 'intern', 'architect',
] as const

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length]!
}

export function handleFromSeed(seed: string): string {
  const rng = mulberry32(fnv1a(seed))
  return `${pick(ADJECTIVES, rng())}-${pick(NOUNS, rng())}`
}

export function randomHandle(rng: () => number): string {
  return `${pick(ADJECTIVES, rng())}-${pick(NOUNS, rng())}`
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './prng.js'
export * from './names.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): seeded prng and anonymous dev-handle generator

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: Combat — wall raycast and hitscan fire

**Files:**
- Create: `packages/core/src/combat.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/combat.test.ts`

**Interfaces:**
- Consumes: `GameMap`, `isWall`, `MatchState`, `PlayerState`, constants.
- Produces:
  - `castWall(map: GameMap, ox: number, oy: number, dir: number): { dist: number; side: 0 | 1 }` — DDA raycast; `dist` is Euclidean distance to the first wall (capped at `MAX_WALL_DIST`); `side` 0 = x-face, 1 = y-face (renderer uses it for shading)
  - `fireHitscan(shooterId: string, state: MatchState, map: GameMap): string | null` — returns victim id or null. Pure geometry + occlusion; does NOT apply damage (the room does). Victims must be alive (`hp > 0`), not the shooter; nearest along the ray wins; the ray stops at walls.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/combat.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { castWall, fireHitscan } from '../src/combat.js'
import { parseMap } from '../src/map.js'
import type { MatchState, PlayerState } from '../src/types.js'

const HALL = parseMap('hall', 'Hall', [
  '############',
  '#SSSSSSSS..#',
  '#..........#',
  '#....#.....#',
  '#.......R..#',
  '############',
].join('\n'))

function player(id: string, x: number, y: number, dir = 0): PlayerState {
  return { id, handle: id, bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

function state(...players: PlayerState[]): MatchState {
  const rec: Record<string, PlayerState> = {}
  for (const p of players) rec[p.id] = p
  return { tick: 0, timeLeftTicks: 3600, mapId: 'hall', players: rec, rail: { pos: HALL.railSpawn, present: true, respawnTimer: 0 }, kills: [] }
}

describe('castWall', () => {
  it('measures distance to a wall', () => {
    const r = castWall(HALL, 1.5, 2.5, 0) // +x, wall at x=11
    expect(r.dist).toBeCloseTo(11 - 1.5, 1)
    expect(r.side).toBe(0)
  })
  it('hits the pillar', () => {
    const r = castWall(HALL, 1.5, 3.5, 0) // pillar cell at x=5,y=3
    expect(r.dist).toBeCloseTo(5 - 1.5, 1)
  })
})

describe('fireHitscan', () => {
  it('hits a player straight ahead', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 2.5))
    expect(fireHitscan('a', s, HALL)).toBe('b')
  })
  it('nearest target wins', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 2.5), player('c', 5.5, 2.5))
    expect(fireHitscan('a', s, HALL)).toBe('c')
  })
  it('walls block shots', () => {
    const s = state(player('a', 2.5, 3.5, 0), player('b', 8.5, 3.5)) // pillar between
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
  it('misses when aim is off by more than HIT_RADIUS', () => {
    const s = state(player('a', 2.5, 2.5, 0), player('b', 8.5, 1.3))
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
  it('never hits self or the dead', () => {
    const dead = player('b', 8.5, 2.5)
    dead.hp = 0
    const s = state(player('a', 2.5, 2.5, 0), dead)
    expect(fireHitscan('a', s, HALL)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/combat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/combat.ts`:
```ts
import { HIT_RADIUS, MAX_WALL_DIST } from './constants.js'
import { type GameMap, isWall } from './map.js'
import type { MatchState } from './types.js'

// Standard DDA grid traversal (lodev.org raycasting tutorial technique; own code).
export function castWall(map: GameMap, ox: number, oy: number, dir: number): { dist: number; side: 0 | 1 } {
  const dx = Math.cos(dir)
  const dy = Math.sin(dir)
  let cx = Math.floor(ox)
  let cy = Math.floor(oy)
  const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx)
  const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy)
  const stepX = dx < 0 ? -1 : 1
  const stepY = dy < 0 ? -1 : 1
  let sideX = dx < 0 ? (ox - cx) * deltaX : (cx + 1 - ox) * deltaX
  let sideY = dy < 0 ? (oy - cy) * deltaY : (cy + 1 - oy) * deltaY
  let side: 0 | 1 = 0
  for (let i = 0; i < 4 * MAX_WALL_DIST; i++) {
    if (sideX < sideY) {
      sideX += deltaX
      cx += stepX
      side = 0
    } else {
      sideY += deltaY
      cy += stepY
      side = 1
    }
    if (isWall(map, cx, cy)) {
      const dist = side === 0 ? sideX - deltaX : sideY - deltaY
      return { dist: Math.min(dist, MAX_WALL_DIST), side }
    }
  }
  return { dist: MAX_WALL_DIST, side }
}

export function fireHitscan(shooterId: string, state: MatchState, map: GameMap): string | null {
  const shooter = state.players[shooterId]
  if (!shooter) return null
  const ux = Math.cos(shooter.dir)
  const uy = Math.sin(shooter.dir)
  const wallDist = castWall(map, shooter.pos.x, shooter.pos.y, shooter.dir).dist
  let best: { id: string; t: number } | null = null
  for (const p of Object.values(state.players)) {
    if (p.id === shooterId || p.hp <= 0) continue
    const vx = p.pos.x - shooter.pos.x
    const vy = p.pos.y - shooter.pos.y
    const t = vx * ux + vy * uy // distance along the ray
    if (t <= 0 || t >= wallDist) continue
    const perp = Math.abs(vx * -uy + vy * ux) // perpendicular distance to the ray
    if (perp > HIT_RADIUS) continue
    if (!best || t < best.t) best = { id: p.id, t }
  }
  return best?.id ?? null
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './combat.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/combat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): DDA wall raycast and hitscan fire resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: `MatchRoom` — the authoritative match state machine

**Files:**
- Create: `packages/core/src/room.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/room.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces (the exact surface both the DO and the offline client use):
  ```ts
  class MatchRoom {
    readonly map: GameMap
    state: MatchState
    constructor(map: GameMap, seed: number)
    get finished(): boolean            // timeLeftTicks <= 0
    humanCount(): number
    playerCount(): number
    addPlayer(id: string, handle: string, bot: boolean): PlayerState  // throws if full (MAX_PLAYERS)
    removePlayer(id: string): void
    queueInput(id: string, inputs: PlayerInput[]): void
    tick(): KillEvent[]                // advances one tick; returns this tick's kills (also in state.kills)
  }
  ```
- Semantics locked here (later tasks depend on them):
  - One input consumed per player per tick from its queue; if the queue is empty the last movement input is reused **with `fire: false`**; queues longer than 4 drop oldest first.
  - `fireCooldown`/`spawnProtection`/`rail.respawnTimer` decrement at tick start.
  - Firing requires `fireCooldown === 0` and alive; firing sets `spawnProtection = 0` (shooting cancels your protection), consumes rail if held (`RAIL_DMG`) else blaster (`BLASTER_DMG`), sets `fireCooldown = BLASTER_COOLDOWN_TICKS`.
  - Protected victims (`spawnProtection > 0`) take no damage.
  - Death → killer `frags+1` (self-kills impossible: hitscan skips shooter), victim `deaths+1`, **instant respawn** at the spawn cell that maximizes distance-to-nearest-living-enemy (deterministic: ties break on lowest spawn index), `hp = MAX_HP`, `spawnProtection = SPAWN_PROTECTION_TICKS`, `hasRail = false`, facing map center.
  - Rail pickup: alive player within `RAIL_PICKUP_RADIUS` of a present rail takes it (`hasRail = true`), `rail.present = false`, `respawnTimer = RAIL_RESPAWN_TICKS`; timer hitting 0 restores it.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/room.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { BLASTER_COOLDOWN_TICKS, MATCH_TICKS, MAX_HP, MAX_PLAYERS, SPAWN_PROTECTION_TICKS } from '../src/constants.js'
import { mapById } from '../src/maps.js'
import { makeInput } from '../src/movement.js'
import { MatchRoom } from '../src/room.js'

const MAP = mapById('legacy_monolith')

describe('MatchRoom', () => {
  it('adds players at spawns, rejects overflow', () => {
    const room = new MatchRoom(MAP, 1)
    for (let i = 0; i < MAX_PLAYERS; i++) room.addPlayer(`p${i}`, `h${i}`, false)
    expect(room.playerCount()).toBe(MAX_PLAYERS)
    expect(() => room.addPlayer('extra', 'x', false)).toThrow(/full/)
    const p0 = room.state.players['p0']!
    expect(p0.hp).toBe(MAX_HP)
    expect(p0.spawnProtection).toBe(SPAWN_PROTECTION_TICKS)
  })

  it('a scripted duel produces a kill, scoring, and respawn', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    // teleport into a known duel position (test-only state surgery)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0; a.spawnProtection = 0
    b.pos = { x: 12.5, y: 2.5 }; b.dir = Math.PI; b.spawnProtection = 0
    let seq = 0
    let kills = 0
    // 4 blaster hits at 25 dmg kill; cooldown is 10 ticks → ~40 ticks
    for (let t = 0; t < 60 && kills === 0; t++) {
      room.queueInput('a', [makeInput(++seq, { fire: true })])
      room.queueInput('b', [makeInput(++seq)])
      kills += room.tick().length
      // keep b still even after respawn for determinism of this test
      const bs = room.state.players['b']!
      if (bs.hp === MAX_HP && bs.spawnProtection === SPAWN_PROTECTION_TICKS) break
    }
    expect(room.state.players['a']!.frags).toBe(1)
    expect(room.state.players['b']!.deaths).toBe(1)
    expect(room.state.players['b']!.hp).toBe(MAX_HP) // instant respawn
  })

  it('spawn protection blocks damage; firing cancels own protection', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0; a.spawnProtection = 0
    b.pos = { x: 8.5, y: 2.5 }; b.spawnProtection = 100
    room.queueInput('a', [makeInput(1, { fire: true })])
    room.tick()
    expect(room.state.players['b']!.hp).toBe(MAX_HP) // protected
    expect(room.state.players['a']!.fireCooldown).toBe(BLASTER_COOLDOWN_TICKS) // set by firing this tick
  })

  it('empty queue reuses movement but never fire', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    a.spawnProtection = 0
    room.queueInput('a', [makeInput(1, { forward: 1, fire: true })])
    room.tick() // fires: cooldown set to BLASTER_COOLDOWN_TICKS
    room.tick() // no queued input → reuse forward:1, fire:false; cooldown decrements
    expect(room.state.players['a']!.fireCooldown).toBe(BLASTER_COOLDOWN_TICKS - 1)
  })

  it('rail pickup, one-shot kill, and pickup respawn timer', () => {
    const room = new MatchRoom(MAP, 1)
    const a = room.addPlayer('a', 'alpha', false)
    const b = room.addPlayer('b', 'beta', false)
    a.pos = { ...MAP.railSpawn }; a.spawnProtection = 0
    room.queueInput('a', [makeInput(1)])
    room.tick()
    expect(room.state.players['a']!.hasRail).toBe(true)
    expect(room.state.rail.present).toBe(false)
    a.pos = { x: 6.5, y: 2.5 }; a.dir = 0
    b.pos = { x: 12.5, y: 2.5 }; b.spawnProtection = 0
    room.queueInput('a', [makeInput(2, { fire: true })])
    const kills = room.tick()
    expect(kills).toHaveLength(1)
    expect(kills[0]!.weapon).toBe('rail')
    expect(room.state.players['a']!.hasRail).toBe(false)
  })

  it('match ends after MATCH_TICKS', () => {
    const room = new MatchRoom(MAP, 1)
    room.addPlayer('a', 'alpha', false)
    for (let i = 0; i < MATCH_TICKS; i++) room.tick()
    expect(room.finished).toBe(true)
  })

  it('deterministic: same seed + same inputs → identical state', () => {
    const run = () => {
      const room = new MatchRoom(MAP, 99)
      room.addPlayer('a', 'alpha', false)
      room.addPlayer('b', 'beta', false)
      let seq = 0
      for (let t = 0; t < 500; t++) {
        room.queueInput('a', [makeInput(++seq, { forward: 1, turn: t % 7 === 0 ? 1 : 0, fire: t % 13 === 0 })])
        room.queueInput('b', [makeInput(++seq, { forward: t % 2 ? 1 : 0, turn: -1, fire: t % 11 === 0 })])
        room.tick()
      }
      return JSON.stringify(room.state)
    }
    expect(run()).toBe(run())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/room.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/room.ts`:
```ts
import {
  BLASTER_COOLDOWN_TICKS, BLASTER_DMG, MATCH_TICKS, MAX_HP, MAX_PLAYERS,
  RAIL_DMG, RAIL_PICKUP_RADIUS, RAIL_RESPAWN_TICKS, SPAWN_PROTECTION_TICKS,
} from './constants.js'
import { fireHitscan } from './combat.js'
import type { GameMap } from './map.js'
import { makeInput, stepPlayer, wrapAngle } from './movement.js'
import { mulberry32 } from './prng.js'
import type { KillEvent, MatchState, PlayerInput, PlayerState, Vec2 } from './types.js'

export class MatchRoom {
  readonly map: GameMap
  state: MatchState
  private queues = new Map<string, PlayerInput[]>()
  private lastInputs = new Map<string, PlayerInput>()
  private rng: () => number

  constructor(map: GameMap, seed: number) {
    this.map = map
    this.rng = mulberry32(seed)
    this.state = {
      tick: 0,
      timeLeftTicks: MATCH_TICKS,
      mapId: map.id,
      players: {},
      rail: { pos: { ...map.railSpawn }, present: true, respawnTimer: 0 },
      kills: [],
    }
  }

  get finished(): boolean {
    return this.state.timeLeftTicks <= 0
  }

  humanCount(): number {
    return Object.values(this.state.players).filter((p) => !p.bot).length
  }

  playerCount(): number {
    return Object.keys(this.state.players).length
  }

  addPlayer(id: string, handle: string, bot: boolean): PlayerState {
    if (this.playerCount() >= MAX_PLAYERS) throw new Error('room full')
    const pos = this.pickSpawn()
    const center = { x: this.map.width / 2, y: this.map.height / 2 }
    const p: PlayerState = {
      id, handle, bot,
      pos,
      dir: wrapAngle(Math.atan2(center.y - pos.y, center.x - pos.x)),
      hp: MAX_HP, frags: 0, deaths: 0,
      fireCooldown: 0, spawnProtection: SPAWN_PROTECTION_TICKS,
      hasRail: false, lastInputSeq: 0,
    }
    this.state.players[id] = p
    this.queues.set(id, [])
    return p
  }

  removePlayer(id: string): void {
    delete this.state.players[id]
    this.queues.delete(id)
    this.lastInputs.delete(id)
  }

  queueInput(id: string, inputs: PlayerInput[]): void {
    const q = this.queues.get(id)
    if (!q) return
    q.push(...inputs)
    while (q.length > 4) q.shift() // drop oldest on backlog
  }

  tick(): KillEvent[] {
    const s = this.state
    s.tick++
    s.timeLeftTicks--
    const kills: KillEvent[] = []

    for (const p of Object.values(s.players)) {
      if (p.fireCooldown > 0) p.fireCooldown--
      if (p.spawnProtection > 0) p.spawnProtection--
    }
    if (!s.rail.present && --s.rail.respawnTimer <= 0) {
      s.rail.present = true
      s.rail.respawnTimer = 0
    }

    // stable iteration order = insertion order; same on both sides given same joins
    for (const id of Object.keys(s.players)) {
      const p = s.players[id]!
      const q = this.queues.get(id) ?? []
      let input = q.shift()
      if (!input) {
        const last = this.lastInputs.get(id)
        input = last ? { ...last, seq: p.lastInputSeq, fire: false } : makeInput(p.lastInputSeq)
      }
      this.lastInputs.set(id, input)
      stepPlayer(p, input, this.map)

      if (input.fire && p.fireCooldown === 0 && p.hp > 0) {
        p.fireCooldown = BLASTER_COOLDOWN_TICKS
        p.spawnProtection = 0
        const weapon = p.hasRail ? 'rail' : 'blaster'
        const dmg = p.hasRail ? RAIL_DMG : BLASTER_DMG
        if (p.hasRail) p.hasRail = false
        const victimId = fireHitscan(id, s, this.map)
        if (victimId) {
          const v = s.players[victimId]!
          if (v.spawnProtection === 0) {
            v.hp -= dmg
            if (v.hp <= 0) {
              p.frags++
              v.deaths++
              kills.push({ tick: s.tick, killerId: id, victimId, weapon })
              this.respawn(v)
            }
          }
        }
      }
    }

    if (s.rail.present) {
      for (const p of Object.values(s.players)) {
        if (p.hp <= 0) continue
        const d = Math.hypot(p.pos.x - s.rail.pos.x, p.pos.y - s.rail.pos.y)
        if (d <= RAIL_PICKUP_RADIUS) {
          p.hasRail = true
          s.rail.present = false
          s.rail.respawnTimer = RAIL_RESPAWN_TICKS
          break
        }
      }
    }

    s.kills = kills
    return kills
  }

  private respawn(p: PlayerState): void {
    p.pos = this.pickSpawn(p.id)
    const center = { x: this.map.width / 2, y: this.map.height / 2 }
    p.dir = wrapAngle(Math.atan2(center.y - p.pos.y, center.x - p.pos.x))
    p.hp = MAX_HP
    p.spawnProtection = SPAWN_PROTECTION_TICKS
    p.hasRail = false
    p.fireCooldown = 0
  }

  // farthest-from-nearest-enemy spawn; deterministic tie-break on index
  private pickSpawn(excludeId?: string): Vec2 {
    const enemies = Object.values(this.state.players).filter((p) => p.id !== excludeId && p.hp > 0)
    let bestIdx = 0
    let bestScore = -1
    this.map.spawns.forEach((sp, i) => {
      const nearest = enemies.length
        ? Math.min(...enemies.map((e) => Math.hypot(e.pos.x - sp.x, e.pos.y - sp.y)))
        : this.rng() * 100 // empty room: seeded-random spawn variety
      if (nearest > bestScore) {
        bestScore = nearest
        bestIdx = i
      }
    })
    return { ...this.map.spawns[bestIdx]! }
  }
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './room.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/room.test.ts`
Expected: PASS. (If the "scripted duel" test is flaky because spawn choice moved a player, tighten the test by re-pinning positions each iteration — the room semantics above are the source of truth, not the test scaffolding.)

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(core): MatchRoom authoritative match state machine

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Bots

**Files:**
- Create: `packages/core/src/bots.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/bots.test.ts`

**Interfaces:**
- Consumes: `MatchRoom`, `castWall`, `wrapAngle`, `mulberry32`, types.
- Produces:
  ```ts
  class BotBrain {
    constructor(id: string, seed: number, skill?: number) // skill 0..1, default 0.45 ("loses slightly")
    think(state: MatchState, map: GameMap): PlayerInput   // same interface as a human client
  }
  ```
  Behavior: if a living enemy is visible (line-of-sight via `castWall` and within 20 cells), turn toward it with aim noise scaled by `(1 - skill)`, move to medium range, fire when roughly on target with probabilistic trigger; otherwise roam to random reachable waypoints. Bots must work through `room.queueInput()` exactly like humans.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/bots.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MATCH_TICKS } from '../src/constants.js'
import { BotBrain } from '../src/bots.js'
import { mapById } from '../src/maps.js'
import { MatchRoom } from '../src/room.js'

describe('BotBrain', () => {
  it('produces valid inputs', () => {
    const room = new MatchRoom(mapById('legacy_monolith'), 5)
    room.addPlayer('bot1', 'lazy-linter', true)
    const brain = new BotBrain('bot1', 5)
    const input = brain.think(room.state, room.map)
    expect([-1, 0, 1]).toContain(input.forward)
    expect([-1, 0, 1]).toContain(input.turn)
    expect(typeof input.fire).toBe('boolean')
  })

  it('bot-vs-bot match produces frags and finishes (smoke)', () => {
    const map = mapById('legacy_monolith')
    const room = new MatchRoom(map, 7)
    const brains = [0, 1, 2, 3].map((i) => {
      room.addPlayer(`bot${i}`, `bot-${i}`, true)
      return new BotBrain(`bot${i}`, 100 + i, 0.6)
    })
    for (let t = 0; t < MATCH_TICKS; t++) {
      for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
      room.tick()
    }
    expect(room.finished).toBe(true)
    const totalFrags = Object.values(room.state.players).reduce((n, p) => n + p.frags, 0)
    expect(totalFrags).toBeGreaterThan(3) // 3 minutes of 4 aggressive bots must produce kills
  })

  it('bots are deterministic per seed', () => {
    const run = () => {
      const room = new MatchRoom(mapById('microservices'), 11)
      room.addPlayer('b0', 'x', true)
      room.addPlayer('b1', 'y', true)
      const brains = [new BotBrain('b0', 1), new BotBrain('b1', 2)]
      for (let t = 0; t < 400; t++) {
        for (const b of brains) room.queueInput(b.id, [b.think(room.state, room.map)])
        room.tick()
      }
      return JSON.stringify(room.state)
    }
    expect(run()).toBe(run())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/bots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/bots.ts`:
```ts
import { castWall } from './combat.js'
import type { GameMap } from './map.js'
import { isWall } from './map.js'
import { makeInput, wrapAngle } from './movement.js'
import { mulberry32 } from './prng.js'
import type { MatchState, PlayerInput, PlayerState, Vec2 } from './types.js'

const SIGHT_RANGE = 20
const AIM_FIRE_CONE = 0.15 // radians
const WAYPOINT_REACHED = 0.7

export class BotBrain {
  private rng: () => number
  private waypoint: Vec2 | null = null
  private seq = 0

  constructor(readonly id: string, seed: number, private skill = 0.45) {
    this.rng = mulberry32(seed)
  }

  think(state: MatchState, map: GameMap): PlayerInput {
    const me = state.players[this.id]
    if (!me || me.hp <= 0) return makeInput(++this.seq)

    const enemy = this.visibleEnemy(me, state, map)
    if (enemy) {
      const trueAngle = Math.atan2(enemy.pos.y - me.pos.y, enemy.pos.x - me.pos.x)
      const noise = (this.rng() - 0.5) * (1 - this.skill) * 0.5
      const desired = wrapAngle(trueAngle + noise)
      const diff = wrapAngle(desired - me.dir)
      const dist = Math.hypot(enemy.pos.x - me.pos.x, enemy.pos.y - me.pos.y)
      return makeInput(++this.seq, {
        turn: diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0,
        forward: dist > 5 ? 1 : dist < 2.5 ? -1 : 0,
        strafe: this.rng() < 0.3 ? (this.rng() < 0.5 ? 1 : -1) : 0,
        fire: Math.abs(diff) < AIM_FIRE_CONE && this.rng() < 0.4 + this.skill * 0.4,
      })
    }

    // roam
    if (!this.waypoint || Math.hypot(this.waypoint.x - me.pos.x, this.waypoint.y - me.pos.y) < WAYPOINT_REACHED) {
      this.waypoint = this.randomFloor(map)
    }
    const desired = Math.atan2(this.waypoint.y - me.pos.y, this.waypoint.x - me.pos.x)
    const diff = wrapAngle(desired - me.dir)
    return makeInput(++this.seq, {
      turn: diff > 0.1 ? 1 : diff < -0.1 ? -1 : 0,
      forward: Math.abs(diff) < 1.2 ? 1 : 0,
    })
  }

  private visibleEnemy(me: PlayerState, state: MatchState, map: GameMap): PlayerState | null {
    let best: PlayerState | null = null
    let bestDist = SIGHT_RANGE
    for (const p of Object.values(state.players)) {
      if (p.id === this.id || p.hp <= 0) continue
      const dist = Math.hypot(p.pos.x - me.pos.x, p.pos.y - me.pos.y)
      if (dist >= bestDist) continue
      const angle = Math.atan2(p.pos.y - me.pos.y, p.pos.x - me.pos.x)
      if (castWall(map, me.pos.x, me.pos.y, angle).dist > dist) {
        best = p
        bestDist = dist
      }
    }
    return best
  }

  private randomFloor(map: GameMap): Vec2 {
    for (let i = 0; i < 100; i++) {
      const x = 1 + Math.floor(this.rng() * (map.width - 2))
      const y = 1 + Math.floor(this.rng() * (map.height - 2))
      if (!isWall(map, x, y)) return { x: x + 0.5, y: y + 0.5 }
    }
    return { ...map.railSpawn }
  }
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './bots.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/bots.test.ts`
Expected: PASS. If the smoke test's frag threshold fails, raise bot aggression (`fire` probability) rather than lowering the assertion — boring bots fail the product, not the test.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): seeded bot brains sharing the human input interface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Milestone B — terminal client, offline-playable (ends at the FEEL GATE)

### Task 9: Client package scaffold + capability detection + `doctor`

**Files:**
- Create: `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/bin/fragwait.js`, `packages/client/src/caps.ts`, `packages/client/src/doctor.ts`, `packages/client/src/cli.ts`
- Test: `packages/client/test/caps.test.ts`

**Interfaces:**
- Produces:
  - `type ColorMode = 'truecolor' | '256' | 'mono'`
  - `detectColorMode(env: Record<string, string | undefined>): ColorMode`
  - `viewSize(cols: number, rows: number): { viewCols: number; viewRows: number }` — reserves 1 top + 2 bottom rows for HUD, clamps to minimums (40×12)
  - CLI entry `fragwait` with subcommands: default (play), `doctor`, flags `--offline`, `--name <handle>`, `--server <url>` (server flag wired in Milestone C)

- [ ] **Step 1: Package scaffold**

`packages/client/package.json`:
```json
{
  "name": "fragwait",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "bin": { "fragwait": "./bin/fragwait.js" },
  "files": ["dist", "bin"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "@fragwait/core": "0.1.0" }
}
```

`packages/client/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/client/bin/fragwait.js` (then `chmod +x` it):
```js
#!/usr/bin/env node
import('../dist/cli.js')
```

- [ ] **Step 2: Write the failing test**

`packages/client/test/caps.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { detectColorMode, viewSize } from '../src/caps.js'

describe('detectColorMode', () => {
  it('COLORTERM=truecolor wins', () => {
    expect(detectColorMode({ COLORTERM: 'truecolor', TERM: 'xterm-256color' })).toBe('truecolor')
  })
  it('Apple_Terminal is 256 even with COLORTERM unset', () => {
    expect(detectColorMode({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).toBe('256')
  })
  it('TERM=dumb is mono', () => {
    expect(detectColorMode({ TERM: 'dumb' })).toBe('mono')
  })
  it('plain xterm falls back to 256', () => {
    expect(detectColorMode({ TERM: 'xterm' })).toBe('256')
  })
})

describe('viewSize', () => {
  it('reserves 3 HUD rows and clamps minimums', () => {
    expect(viewSize(120, 40)).toEqual({ viewCols: 120, viewRows: 37 })
    expect(viewSize(10, 5)).toEqual({ viewCols: 40, viewRows: 12 })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && npx vitest run packages/client/test/caps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/client/src/caps.ts`:
```ts
export type ColorMode = 'truecolor' | '256' | 'mono'

export function detectColorMode(env: Record<string, string | undefined>): ColorMode {
  if (/truecolor|24bit/i.test(env['COLORTERM'] ?? '')) return 'truecolor'
  if (env['TERM_PROGRAM'] === 'Apple_Terminal') return '256' // Terminal.app has no truecolor
  const term = env['TERM'] ?? ''
  if (term === 'dumb' || term === '') return 'mono'
  return '256'
}

export function viewSize(cols: number, rows: number): { viewCols: number; viewRows: number } {
  return { viewCols: Math.max(40, cols), viewRows: Math.max(12, rows - 3) }
}
```

`packages/client/src/doctor.ts`:
```ts
import { detectColorMode } from './caps.js'

export function doctorReport(env: Record<string, string | undefined>, stdoutIsTTY: boolean, cols: number, rows: number): string {
  const mode = detectColorMode(env)
  return [
    'fragwait doctor',
    `  tty:        ${stdoutIsTTY ? 'yes' : 'NO - fragwait needs an interactive terminal'}`,
    `  term:       ${env['TERM'] ?? '(unset)'} / ${env['TERM_PROGRAM'] ?? '(unknown program)'}`,
    `  color mode: ${mode}${mode === 'mono' ? ' - expect ASCII-art rendering' : ''}`,
    `  size:       ${cols}x${rows}${cols < 80 || rows < 20 ? ' - small; 100x28+ recommended' : ''}`,
    '  input:      kitty-protocol probe runs at game start; fallback is decay-timer keys',
    '              VS Code users: enable terminal.integrated.enableKittyKeyboardProtocol',
  ].join('\n')
}
```

`packages/client/src/cli.ts`:
```ts
import { doctorReport } from './doctor.js'

export interface CliOpts { mode: 'play' | 'doctor'; offline: boolean; name?: string; server?: string }

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { mode: 'play', offline: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'doctor') opts.mode = 'doctor'
    else if (a === '--offline') opts.offline = true
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--server') opts.server = argv[++i]
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.mode === 'doctor') {
  console.log(doctorReport(process.env, process.stdout.isTTY ?? false, process.stdout.columns ?? 0, process.stdout.rows ?? 0))
} else {
  // play mode is wired in Task 15 (offline) and Task 22 (online)
  console.log('fragwait: game mode lands in a later task - try `fragwait doctor`')
}
```
(Task 15 replaces the `else` branch with the real game entry.)

- [ ] **Step 5: Run tests, build, smoke-run**

Run: `npx vitest run packages/client/test/caps.test.ts && npm run build && node packages/client/bin/fragwait.js doctor`
Expected: tests PASS; doctor prints a report for this terminal.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): package scaffold, capability detection, doctor command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: Framebuffer and diffing ANSI renderer

**Files:**
- Create: `packages/client/src/framebuffer.ts`
- Test: `packages/client/test/framebuffer.test.ts`

**Interfaces:**
- Produces:
  - `class FrameBuffer { constructor(w, h); readonly w; readonly h; px: Uint8Array /* w*h*3 RGB */; set(x,y,r,g,b): void; fill(r,g,b): void }` — `h` is in PIXELS = 2 × text rows (half-block trick: char `▀` with fg = top pixel, bg = bottom pixel)
  - `rgbTo256(r,g,b): number` — 6×6×6 cube + grayscale ramp
  - `class TermRenderer { constructor(mode: ColorMode); frame(fb): string; reset(): void }` — returns ANSI bytes for the frame, emitting only cells changed since the previous frame (first frame = everything). Cursor addressed with `\x1b[{row};{col}H`; truecolor SGR `38;2;r;g;b`/`48;2;r;g;b`; 256-mode `38;5;n`/`48;5;n`; mono maps top-pixel luminance onto ` .:-=+*#%@`. `reset()` forces a full repaint (used on terminal resize).

- [ ] **Step 1: Write the failing tests**

`packages/client/test/framebuffer.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { FrameBuffer, TermRenderer, rgbTo256 } from '../src/framebuffer.js'

describe('FrameBuffer', () => {
  it('stores pixels', () => {
    const fb = new FrameBuffer(4, 4)
    fb.set(1, 2, 255, 128, 0)
    expect([...fb.px.slice((2 * 4 + 1) * 3, (2 * 4 + 1) * 3 + 3)]).toEqual([255, 128, 0])
  })
})

describe('rgbTo256', () => {
  it('maps primaries into the 6x6x6 cube', () => {
    expect(rgbTo256(255, 0, 0)).toBe(196)
    expect(rgbTo256(0, 0, 255)).toBe(21)
  })
  it('maps grays to the gray ramp', () => {
    const n = rgbTo256(128, 128, 128)
    expect(n).toBeGreaterThanOrEqual(232)
    expect(n).toBeLessThanOrEqual(255)
  })
})

describe('TermRenderer diffing', () => {
  it('first frame paints, identical second frame emits nothing', () => {
    const fb = new FrameBuffer(4, 4) // 4x4 px = 4 cols x 2 text rows
    fb.fill(10, 20, 30)
    const r = new TermRenderer('truecolor')
    const first = r.frame(fb)
    expect(first).toContain('▀') // ▀
    expect(first).toContain('38;2;10;20;30')
    expect(r.frame(fb)).toBe('') // no change, no bytes
  })
  it('single pixel change emits a single cell update', () => {
    const fb = new FrameBuffer(4, 4)
    fb.fill(0, 0, 0)
    const r = new TermRenderer('truecolor')
    r.frame(fb)
    fb.set(2, 0, 255, 255, 255)
    const out = r.frame(fb)
    expect(out).toContain('\x1b[1;3H') // row 1, col 3
    expect(out.split('▀').length - 1).toBe(1)
  })
  it('mono mode renders luminance characters', () => {
    const fb = new FrameBuffer(2, 2)
    fb.fill(255, 255, 255)
    const out = new TermRenderer('mono').frame(fb)
    expect(out).toContain('@')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/framebuffer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/client/src/framebuffer.ts`:
```ts
import type { ColorMode } from './caps.js'

export class FrameBuffer {
  px: Uint8Array
  constructor(readonly w: number, readonly h: number) {
    this.px = new Uint8Array(w * h * 3)
  }
  set(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    this.px[i] = r
    this.px[i + 1] = g
    this.px[i + 2] = b
  }
  fill(r: number, g: number, b: number): void {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = r
      this.px[i + 1] = g
      this.px[i + 2] = b
    }
  }
}

export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return 232 + Math.round(((r - 8) / 247) * 23)
  }
  const q = (v: number) => Math.round((v / 255) * 5)
  return 16 + 36 * q(r) + 6 * q(g) + q(b)
}

const MONO_RAMP = ' .:-=+*#%@'
const ESC = '\x1b'

export class TermRenderer {
  private prev: Uint8Array | null = null
  constructor(private mode: ColorMode) {}

  reset(): void {
    this.prev = null
  }

  frame(fb: FrameBuffer): string {
    const rows = fb.h >> 1
    const out: string[] = []
    let lastRow = -1
    let lastCol = -1
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < fb.w; col++) {
        const ti = (row * 2 * fb.w + col) * 3
        const bi = ((row * 2 + 1) * fb.w + col) * 3
        if (this.prev) {
          let same = true
          for (let k = 0; k < 3; k++) {
            if (this.prev[ti + k] !== fb.px[ti + k] || this.prev[bi + k] !== fb.px[bi + k]) {
              same = false
              break
            }
          }
          if (same) continue
        }
        if (row !== lastRow || col !== lastCol + 1) out.push(`${ESC}[${row + 1};${col + 1}H`)
        out.push(this.cell(fb.px[ti]!, fb.px[ti + 1]!, fb.px[ti + 2]!, fb.px[bi]!, fb.px[bi + 1]!, fb.px[bi + 2]!))
        lastRow = row
        lastCol = col
      }
    }
    this.prev = Uint8Array.from(fb.px)
    return out.join('')
  }

  private cell(tr: number, tg: number, tb: number, br: number, bg: number, bb: number): string {
    if (this.mode === 'truecolor') return `${ESC}[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`
    if (this.mode === '256') return `${ESC}[38;5;${rgbTo256(tr, tg, tb)};48;5;${rgbTo256(br, bg, bb)}m▀`
    const lum = (0.2126 * tr + 0.7152 * tg + 0.0722 * tb) / 255
    return MONO_RAMP[Math.min(MONO_RAMP.length - 1, Math.floor(lum * MONO_RAMP.length))]!
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/framebuffer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): half-block framebuffer with diffing ANSI renderer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: Raycaster — walls, sprites, crosshair

**Files:**
- Create: `packages/client/src/raycast.ts`
- Test: `packages/client/test/raycast.test.ts`

**Interfaces:**
- Consumes: `FrameBuffer` (Task 10); `GameMap`, `MatchState`, `isWall`, `wrapAngle`, `fnv1a` from `@fragwait/core`.
- Produces:
  - `renderView(fb: FrameBuffer, map: GameMap, state: MatchState, selfId: string): void` — fills ceiling `(18,18,24)` / floor `(38,36,34)`, raycasts one DDA column per pixel column (FOV 60°, fisheye-corrected perpendicular distance, y-side walls 25% darker, distance fade), draws sprite billboards (living players except self, color from `fnv1a(id)`, blinking on `state.tick % 4 < 2` while spawn-protected; rail pickup as a slim bright cyan pillar when present) with per-column z-buffer occlusion, then a 5-pixel crosshair at screen center.
  - `export const FOV = Math.PI / 3`

- [ ] **Step 1: Write the failing tests**

`packages/client/test/raycast.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseMap } from '@fragwait/core'
import type { MatchState, PlayerState } from '@fragwait/core'
import { FrameBuffer } from '../src/framebuffer.js'
import { renderView } from '../src/raycast.js'

const BOX = parseMap('box', 'Box', [
  '####################',
  '#SSSSSSSS..........#',
  '#..................#',
  '#........R.........#',
  '#..................#',
  '####################',
].join('\n'))

function player(id: string, x: number, y: number, dir = 0): PlayerState {
  return { id, handle: id, bot: false, pos: { x, y }, dir, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0 }
}

function mkState(...players: PlayerState[]): MatchState {
  const rec: Record<string, PlayerState> = {}
  for (const p of players) rec[p.id] = p
  return { tick: 0, timeLeftTicks: 3600, mapId: 'box', players: rec, rail: { pos: BOX.railSpawn, present: false, respawnTimer: 1 }, kills: [] }
}

function wallColumnHeight(fb: FrameBuffer, col: number): number {
  let count = 0
  for (let y = 0; y < fb.h; y++) {
    const i = (y * fb.w + col) * 3
    const [r, g, b] = [fb.px[i]!, fb.px[i + 1]!, fb.px[i + 2]!]
    if (!(r === 18 && g === 18 && b === 24) && !(r === 38 && g === 36 && b === 34)) count++
  }
  return count
}

describe('renderView', () => {
  it('closer walls render taller columns', () => {
    const fbNear = new FrameBuffer(80, 48)
    renderView(fbNear, BOX, mkState(player('me', 17.5, 3, 0)), 'me')
    const fbFar = new FrameBuffer(80, 48)
    renderView(fbFar, BOX, mkState(player('me', 2.5, 3, 0)), 'me')
    // column 10 avoids the center crosshair pixels
    expect(wallColumnHeight(fbNear, 10)).toBeGreaterThan(wallColumnHeight(fbFar, 10))
  })
  it('a visible enemy changes the rendered pixels', () => {
    const fbA = new FrameBuffer(80, 48)
    const fbB = new FrameBuffer(80, 48)
    renderView(fbA, BOX, mkState(player('me', 3.5, 3, 0), player('foe', 8.5, 3)), 'me')
    renderView(fbB, BOX, mkState(player('me', 3.5, 3, 0)), 'me')
    expect(Buffer.compare(Buffer.from(fbA.px), Buffer.from(fbB.px))).not.toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/raycast.test.ts`
Expected: FAIL — module not found. If `@fragwait/core` fails to resolve from tests, add an alias to `vitest.config.ts`:
```ts
resolve: { alias: { '@fragwait/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname } },
```

- [ ] **Step 3: Implement**

`packages/client/src/raycast.ts`:
```ts
import { type GameMap, type MatchState, fnv1a, isWall, wrapAngle } from '@fragwait/core'
import type { FrameBuffer } from './framebuffer.js'

export const FOV = Math.PI / 3

const CEIL = [18, 18, 24] as const
const FLOOR = [38, 36, 34] as const
const WALL = [140, 120, 100] as const

export function renderView(fb: FrameBuffer, map: GameMap, state: MatchState, selfId: string): void {
  const me = state.players[selfId]
  if (!me) return
  const half = fb.h >> 1
  for (let y = 0; y < fb.h; y++) {
    const c = y < half ? CEIL : FLOOR
    for (let x = 0; x < fb.w; x++) fb.set(x, y, c[0], c[1], c[2])
  }

  const zbuf = new Float64Array(fb.w)
  const tanHalf = Math.tan(FOV / 2)
  for (let col = 0; col < fb.w; col++) {
    const camX = (2 * col) / fb.w - 1
    const rayDir = me.dir + Math.atan(camX * tanHalf)
    const dx = Math.cos(rayDir)
    const dy = Math.sin(rayDir)
    let cx = Math.floor(me.pos.x)
    let cy = Math.floor(me.pos.y)
    const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx)
    const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy)
    const stepX = dx < 0 ? -1 : 1
    const stepY = dy < 0 ? -1 : 1
    let sideX = dx < 0 ? (me.pos.x - cx) * deltaX : (cx + 1 - me.pos.x) * deltaX
    let sideY = dy < 0 ? (me.pos.y - cy) * deltaY : (cy + 1 - me.pos.y) * deltaY
    let side: 0 | 1 = 0
    let dist = 64
    for (let i = 0; i < 256; i++) {
      if (sideX < sideY) { sideX += deltaX; cx += stepX; side = 0 } else { sideY += deltaY; cy += stepY; side = 1 }
      if (isWall(map, cx, cy)) { dist = side === 0 ? sideX - deltaX : sideY - deltaY; break }
    }
    const perp = Math.max(0.01, dist * Math.cos(wrapAngle(rayDir - me.dir)))
    zbuf[col] = perp
    const wallH = Math.min(fb.h, Math.floor(fb.h / perp))
    const y0 = (fb.h - wallH) >> 1
    const fade = Math.max(0.15, 1 - perp / 16) * (side === 1 ? 0.75 : 1)
    const r = Math.floor(WALL[0] * fade)
    const g = Math.floor(WALL[1] * fade)
    const b = Math.floor(WALL[2] * fade)
    for (let y = y0; y < y0 + wallH; y++) fb.set(col, y, r, g, b)
  }

  // sprites far -> near
  interface Sprite { x: number; y: number; color: [number, number, number]; blink: boolean; slim: boolean }
  const sprites: Sprite[] = []
  for (const p of Object.values(state.players)) {
    if (p.id === selfId || p.hp <= 0) continue
    const h = fnv1a(p.id)
    sprites.push({
      x: p.pos.x, y: p.pos.y, slim: false,
      color: [120 + (h & 0x7f), 80 + ((h >> 8) & 0x7f), 80 + ((h >> 16) & 0x7f)],
      blink: p.spawnProtection > 0,
    })
  }
  if (state.rail.present) sprites.push({ x: state.rail.pos.x, y: state.rail.pos.y, color: [80, 220, 255], blink: false, slim: true })
  sprites.sort((a, b) => Math.hypot(b.x - me.pos.x, b.y - me.pos.y) - Math.hypot(a.x - me.pos.x, a.y - me.pos.y))

  for (const s of sprites) {
    if (s.blink && state.tick % 4 < 2) continue
    const rx = s.x - me.pos.x
    const ry = s.y - me.pos.y
    const depth = rx * Math.cos(me.dir) + ry * Math.sin(me.dir)
    if (depth <= 0.2) continue
    const lateral = -rx * Math.sin(me.dir) + ry * Math.cos(me.dir)
    const screenX = Math.floor((fb.w / 2) * (1 + lateral / (depth * tanHalf)))
    const size = Math.min(fb.h, Math.floor(fb.h / depth))
    const w = Math.max(1, Math.floor(size * (s.slim ? 0.15 : 0.4)))
    const y0 = (fb.h - size) >> 1
    for (let col = screenX - (w >> 1); col <= screenX + (w >> 1); col++) {
      if (col < 0 || col >= fb.w || depth >= zbuf[col]!) continue
      for (let y = y0 + (s.slim ? 0 : size >> 3); y < y0 + size; y++) fb.set(col, y, s.color[0], s.color[1], s.color[2])
    }
  }

  const ccx = fb.w >> 1
  const ccy = fb.h >> 1
  for (const [px, py] of [[ccx, ccy], [ccx - 2, ccy], [ccx + 2, ccy], [ccx, ccy - 2], [ccx, ccy + 2]] as const) {
    fb.set(px, py, 255, 255, 255)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/raycast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): column raycaster with sprite billboards and z-buffer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 12: HUD rows and kill feed

**Files:**
- Create: `packages/client/src/hud.ts`
- Test: `packages/client/test/hud.test.ts`

**Interfaces:**
- Consumes: `MatchState`, `KillEvent`, `MAX_HP`, `TICK_RATE` from core.
- Produces:
  - `class KillFeed { push(k: KillEvent, state: MatchState): void; lines(): string[] }` — keeps last 3 lines like `rebased-rustacean ⌫ segfaulting-sensei` (`⌦` = rail); handles resolved at push time
  - `fmtTime(ticks: number): string` — `m:ss`
  - `fmtBusy(seconds: number): string` — `2m14s`
  - `hudRows(state, selfId, cols, busySeconds: number | null, feed): { top: string; bottom: string[] }` — `top` = map id + `⏱ m:ss` + `⚙ Claude working 2m14s` (when busy); `bottom` = [HP bar/frags/rail row, newest kill-feed row]; every string exactly `cols` chars

- [ ] **Step 1: Write the failing tests**

`packages/client/test/hud.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MatchRoom, mapById } from '@fragwait/core'
import { KillFeed, hudRows } from '../src/hud.js'

function room(): MatchRoom {
  const r = new MatchRoom(mapById('legacy_monolith'), 3)
  r.addPlayer('a', 'rebased-rustacean', false)
  r.addPlayer('b', 'segfaulting-sensei', false)
  return r
}

describe('KillFeed', () => {
  it('renders handles and weapons, keeps last 3', () => {
    const r = room()
    const feed = new KillFeed()
    feed.push({ tick: 1, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    expect(feed.lines()[0]).toBe('rebased-rustacean ⌫ segfaulting-sensei')
    feed.push({ tick: 2, killerId: 'b', victimId: 'a', weapon: 'rail' }, r.state)
    feed.push({ tick: 3, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    feed.push({ tick: 4, killerId: 'a', victimId: 'b', weapon: 'blaster' }, r.state)
    expect(feed.lines()).toHaveLength(3)
    expect(feed.lines()[0]).toContain('⌦') // rail glyph survived, oldest dropped
  })
})

describe('hudRows', () => {
  it('fixed width, shows hp/frags/time and Claude line', () => {
    const r = room()
    const { top, bottom } = hudRows(r.state, 'a', 80, 134, new KillFeed())
    expect(top).toHaveLength(80)
    expect(top).toContain('3:00')
    expect(top).toContain('Claude working 2m14s')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]).toHaveLength(80)
    expect(bottom[0]).toContain('HP')
    expect(bottom[0]).toContain('FRAGS 0')
  })
  it('omits Claude line when not busy', () => {
    const r = room()
    const { top } = hudRows(r.state, 'a', 80, null, new KillFeed())
    expect(top).not.toContain('Claude')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/hud.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/client/src/hud.ts`:
```ts
import { MAX_HP, TICK_RATE, type KillEvent, type MatchState } from '@fragwait/core'

function pad(s: string, w: number): string {
  return s.length > w ? s.slice(0, w) : s + ' '.repeat(w - s.length)
}

export class KillFeed {
  private items: string[] = []
  push(k: KillEvent, state: MatchState): void {
    const killer = state.players[k.killerId]?.handle ?? '???'
    const victim = state.players[k.victimId]?.handle ?? '???'
    this.items.push(`${killer} ${k.weapon === 'rail' ? '⌦' : '⌫'} ${victim}`)
    if (this.items.length > 3) this.items.shift()
  }
  lines(): string[] {
    return [...this.items]
  }
}

export function fmtTime(ticks: number): string {
  const s = Math.max(0, Math.ceil(ticks / TICK_RATE))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtBusy(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

export function hudRows(
  state: MatchState,
  selfId: string,
  cols: number,
  busySeconds: number | null,
  feed: KillFeed,
): { top: string; bottom: string[] } {
  const me = state.players[selfId]
  const busy = busySeconds != null ? `  ⚙ Claude working ${fmtBusy(busySeconds)}` : ''
  const top = pad(` ${state.mapId}  ⏱ ${fmtTime(state.timeLeftTicks)}${busy}`, cols)

  const hp = me ? Math.max(0, me.hp) : 0
  const blocks = Math.round((hp / MAX_HP) * 10)
  const hpBar = `HP ${'█'.repeat(blocks)}${'░'.repeat(10 - blocks)} ${String(hp).padStart(3)}`
  const rail = me?.hasRail ? '  RAIL ✦' : ''
  const feedLines = feed.lines()
  const row1 = pad(` ${hpBar}  FRAGS ${me?.frags ?? 0}${rail}`, cols)
  const row2 = pad(` ${feedLines[feedLines.length - 1] ?? ''}`, cols)
  return { top, bottom: [row1, row2] }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/hud.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): HUD rows and kill feed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 13: Input — escape-sequence parser (legacy + kitty CSI-u)

**Files:**
- Create: `packages/client/src/input/parser.ts`
- Test: `packages/client/test/parser.test.ts`

**Interfaces:**
- Produces:
  - `interface KeyEvent { key: string; kind: 'press' | 'repeat' | 'release' }` — `key` values used by the game: `'w' 'a' 's' 'd' ' ' 'q' 'tab' 'enter' 'esc' 'left' 'right' 'up' 'down' 'ctrl-c'`
  - `class KeyParser { feed(chunk: Buffer | string): KeyEvent[] }` — stateful streaming parser:
    - printable ASCII byte → press (lowercased)
    - `0x03` → `ctrl-c` press; `0x0d` → `enter`; `0x09` → `tab`; lone `0x1b` (no following `[` within the same feed or 30 ms) → `esc`
    - legacy arrows `\x1b[A`..`\x1b[D` → `up/down/right/left`? NO — mapping is `A=up B=down C=right D=left`
    - kitty CSI-u: `\x1b[{code}(:{alt})*(;{mods}(:{event})?)?u` where event 1=press 2=repeat 3=release; `code` is the unicode codepoint (97='a', 32=space, 27=esc, 13=enter, 9=tab)
    - kitty-flavored arrows: `\x1b[1;{mods}:{event}{A-D}`
    - kitty support acknowledgement `\x1b[?{flags}u` → synthetic event `{ key: 'kitty-ack', kind: 'press' }`
    - unknown sequences are consumed silently (never leak bytes into gameplay)

- [ ] **Step 1: Write the failing tests**

`packages/client/test/parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { KeyParser } from '../src/input/parser.js'

describe('KeyParser', () => {
  it('plain chars are presses', () => {
    const p = new KeyParser()
    expect(p.feed('wasd ')).toEqual([
      { key: 'w', kind: 'press' },
      { key: 'a', kind: 'press' },
      { key: 's', kind: 'press' },
      { key: 'd', kind: 'press' },
      { key: ' ', kind: 'press' },
    ])
  })
  it('control keys', () => {
    const p = new KeyParser()
    expect(p.feed('\x03')).toEqual([{ key: 'ctrl-c', kind: 'press' }])
    expect(p.feed('\x0d')).toEqual([{ key: 'enter', kind: 'press' }])
    expect(p.feed('\x09')).toEqual([{ key: 'tab', kind: 'press' }])
  })
  it('legacy arrows', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[A\x1b[D')).toEqual([
      { key: 'up', kind: 'press' },
      { key: 'left', kind: 'press' },
    ])
  })
  it('kitty press/repeat/release for letters and space', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[97;1:1u')).toEqual([{ key: 'a', kind: 'press' }])
    expect(p.feed('\x1b[97;1:2u')).toEqual([{ key: 'a', kind: 'repeat' }])
    expect(p.feed('\x1b[97;1:3u')).toEqual([{ key: 'a', kind: 'release' }])
    expect(p.feed('\x1b[32;1:3u')).toEqual([{ key: ' ', kind: 'release' }])
  })
  it('kitty arrows with event types', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[1;1:3C')).toEqual([{ key: 'right', kind: 'release' }])
  })
  it('kitty support ack', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[?1u')).toEqual([{ key: 'kitty-ack', kind: 'press' }])
  })
  it('split sequences across feeds reassemble', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[9')).toEqual([])
    expect(p.feed('7;1:3u')).toEqual([{ key: 'a', kind: 'release' }])
  })
  it('unknown CSI is swallowed', () => {
    const p = new KeyParser()
    expect(p.feed('\x1b[38;2;1;2;3m')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/client/src/input/parser.ts`:
```ts
export interface KeyEvent { key: string; kind: 'press' | 'repeat' | 'release' }

const ARROWS: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' }
const CODES: Record<number, string> = { 32: ' ', 27: 'esc', 13: 'enter', 9: 'tab', 127: 'backspace' }
const EVENTS: Record<string, KeyEvent['kind']> = { '1': 'press', '2': 'repeat', '3': 'release' }

export class KeyParser {
  private buf = ''

  feed(chunk: Buffer | string): KeyEvent[] {
    this.buf += chunk.toString('utf8')
    const out: KeyEvent[] = []
    while (this.buf.length > 0) {
      const ch = this.buf[0]!
      if (ch === '\x1b') {
        if (this.buf.length === 1) break // wait for more bytes
        if (this.buf[1] !== '[') {
          out.push({ key: 'esc', kind: 'press' })
          this.buf = this.buf.slice(1)
          continue
        }
        // CSI: find final byte (0x40-0x7e) after params
        let end = -1
        for (let i = 2; i < this.buf.length; i++) {
          const c = this.buf.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) { end = i; break }
        }
        if (end === -1) break // incomplete, wait
        const params = this.buf.slice(2, end)
        const final = this.buf[end]!
        this.buf = this.buf.slice(end + 1)
        const ev = this.decodeCsi(params, final)
        if (ev) out.push(ev)
        continue
      }
      this.buf = this.buf.slice(1)
      if (ch === '\x03') out.push({ key: 'ctrl-c', kind: 'press' })
      else if (ch === '\x0d') out.push({ key: 'enter', kind: 'press' })
      else if (ch === '\x09') out.push({ key: 'tab', kind: 'press' })
      else if (ch >= ' ' && ch <= '~') out.push({ key: ch.toLowerCase(), kind: 'press' })
      // other control bytes: ignore
    }
    return out
  }

  private decodeCsi(params: string, final: string): KeyEvent | null {
    if (final === 'u') {
      if (params.startsWith('?')) return { key: 'kitty-ack', kind: 'press' }
      const [codePart, modPart] = params.split(';')
      const code = Number(codePart!.split(':')[0])
      const kind = EVENTS[modPart?.split(':')[1] ?? '1'] ?? 'press'
      const named = CODES[code]
      const key = named ?? (code >= 32 && code < 127 ? String.fromCodePoint(code).toLowerCase() : null)
      return key ? { key, kind } : null
    }
    if (final in ARROWS) {
      const kind = EVENTS[params.split(';')[1]?.split(':')[1] ?? '1'] ?? 'press'
      return { key: ARROWS[final]!, kind }
    }
    return null // unknown CSI swallowed
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/parser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): streaming key parser for legacy and kitty CSI-u input

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 14: Input — intent tracker (tier 1 kitty / tier 2 decay-timer)

**Files:**
- Create: `packages/client/src/input/intent.ts`
- Test: `packages/client/test/intent.test.ts`

**Interfaces:**
- Consumes: `KeyEvent` (Task 13), `PlayerInput`, `makeInput` from core.
- Produces:
  ```ts
  class IntentTracker {
    constructor(now: () => number, decayMs?: number)  // decayMs default 200 (doom-ascii -kpsmooth pattern)
    enableTier1(): void       // called when kitty-ack observed: releases become authoritative
    onKey(e: KeyEvent): void
    sample(seq: number): PlayerInput
  }
  ```
  Key → intent mapping: `w/up` forward +1, `s/down` forward −1, `a` strafe −1, `d` strafe +1, `left` turn −1, `right` turn +1, `' '` fire. Tier 2 (default): a key is held while `now − lastSeen < decayMs` (press/repeat refresh it, OS key-repeat keeps it alive). Tier 1: press/repeat add, release removes; no decay.

- [ ] **Step 1: Write the failing tests**

`packages/client/test/intent.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { IntentTracker } from '../src/input/intent.js'

function mkClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe('IntentTracker tier 2 (decay)', () => {
  it('key held while repeats arrive, decays after decayMs', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'w', kind: 'press' })
    expect(it2.sample(1).forward).toBe(1)
    clock.advance(150)
    it2.onKey({ key: 'w', kind: 'repeat' }) // OS key-repeat refresh
    clock.advance(150)
    expect(it2.sample(2).forward).toBe(1) // 150 < 200 since refresh
    clock.advance(250)
    expect(it2.sample(3).forward).toBe(0) // decayed
  })
  it('release is ignored in tier 2 (legacy terminals never send it)', () => {
    const clock = mkClock()
    const it2 = new IntentTracker(clock.now, 200)
    it2.onKey({ key: 'd', kind: 'press' })
    it2.onKey({ key: 'd', kind: 'release' }) // some terminal quirk: ignore
    expect(it2.sample(1).strafe).toBe(1)
  })
})

describe('IntentTracker tier 1 (kitty)', () => {
  it('release ends the hold immediately, no decay', () => {
    const clock = mkClock()
    const it1 = new IntentTracker(clock.now, 200)
    it1.enableTier1()
    it1.onKey({ key: 'w', kind: 'press' })
    clock.advance(1000)
    expect(it1.sample(1).forward).toBe(1) // still held: no release yet
    it1.onKey({ key: 'w', kind: 'release' })
    expect(it1.sample(2).forward).toBe(0)
  })
})

describe('mapping', () => {
  it('combines axes and fire', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 'a', kind: 'press' })
    t.onKey({ key: 'right', kind: 'press' })
    t.onKey({ key: ' ', kind: 'press' })
    const i = t.sample(9)
    expect(i).toEqual({ seq: 9, forward: 1, strafe: -1, turn: 1, fire: true })
  })
  it('opposing keys cancel', () => {
    const clock = mkClock()
    const t = new IntentTracker(clock.now, 200)
    t.onKey({ key: 'w', kind: 'press' })
    t.onKey({ key: 's', kind: 'press' })
    expect(t.sample(1).forward).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/client/src/input/intent.ts`:
```ts
import { makeInput, type PlayerInput } from '@fragwait/core'
import type { KeyEvent } from './parser.js'

const TRACKED = new Set(['w', 'a', 's', 'd', ' ', 'up', 'down', 'left', 'right'])

export class IntentTracker {
  private held = new Map<string, number>() // key -> last seen at (ms)
  private tier1 = false

  constructor(private now: () => number, private decayMs = 200) {}

  enableTier1(): void {
    this.tier1 = true
  }

  onKey(e: KeyEvent): void {
    if (!TRACKED.has(e.key)) return
    if (e.kind === 'release') {
      if (this.tier1) this.held.delete(e.key)
      return // tier 2: releases don't exist reliably; decay handles it
    }
    this.held.set(e.key, this.now())
  }

  private isHeld(key: string): boolean {
    const t = this.held.get(key)
    if (t === undefined) return false
    if (!this.tier1 && this.now() - t >= this.decayMs) {
      this.held.delete(key)
      return false
    }
    return true
  }

  sample(seq: number): PlayerInput {
    const axis = (pos: string[], neg: string[]): -1 | 0 | 1 => {
      const p = pos.some((k) => this.isHeld(k))
      const n = neg.some((k) => this.isHeld(k))
      return p === n ? 0 : p ? 1 : -1
    }
    return makeInput(seq, {
      forward: axis(['w', 'up'], ['s', 'down']),
      strafe: axis(['d'], ['a']),
      turn: axis(['right'], ['left']),
      fire: this.isHeld(' '),
    })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/intent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): intent tracker with kitty tier and decay-timer fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 15: Terminal session, offline game loop — THE FEEL GATE

**Files:**
- Create: `packages/client/src/terminal.ts`, `packages/client/src/offline.ts`, `packages/client/src/main.ts`
- Modify: `packages/client/src/cli.ts` (wire play mode to `main.ts`)
- Test: `packages/client/test/terminal.test.ts` (restore-invariant unit test)

**Interfaces:**
- Produces:
  ```ts
  // terminal.ts
  class TerminalSession {
    constructor(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream)
    enter(): void                      // raw mode, alt screen \x1b[?1049h, hide cursor \x1b[?25l, kitty push \x1b[>2u + probe \x1b[?u
    restore(): void                    // IDEMPOTENT: kitty pop \x1b[<u, show cursor, leave alt screen, raw off
    installExitGuards(onExit: () => void): void // exit, SIGINT, SIGTERM, uncaughtException all call restore() exactly once
    write(s: string): void
  }
  // offline.ts
  runOffline(opts: { name?: string }): Promise<void>
  // main.ts
  main(opts: CliOpts): Promise<void>   // Milestone B: always offline; Task 22 adds online-first
  ```
- Offline loop semantics: `MatchRoom` + 3 `BotBrain`s (seeds from `Date.now()` — allowed outside core) at 20 Hz via `setInterval(TICK_MS)`; each tick: sample intent → `queueInput(self)`, bots think → queue, `room.tick()`, push kills to `KillFeed`, `renderView` + `TermRenderer.frame` + HUD rows written via cursor addressing; `tab` shows a scoreboard overlay while held (decay semantics like movement keys); `q`/`esc`/`ctrl-c` quit cleanly; terminal resize recreates FrameBuffer and calls `renderer.reset()`; match end shows final scoreboard, any key exits.

- [ ] **Step 1: Write the failing restore-invariant test**

`packages/client/test/terminal.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../src/terminal.js'

function fakeStreams() {
  const written: string[] = []
  const stdin = { isTTY: true, setRawMode: (on: boolean) => { calls.push(`raw:${on}`) }, resume() {}, pause() {} } as unknown as NodeJS.ReadStream
  const calls: string[] = []
  const stdout = { write: (s: string) => { written.push(s); return true }, columns: 80, rows: 24 } as unknown as NodeJS.WriteStream
  return { stdin, stdout, written, calls }
}

describe('TerminalSession', () => {
  it('enter emits alt-screen + kitty push; restore pops in reverse and is idempotent', () => {
    const { stdin, stdout, written } = fakeStreams()
    const t = new TerminalSession(stdin, stdout)
    t.enter()
    const all = written.join('')
    expect(all).toContain('\x1b[?1049h')
    expect(all).toContain('\x1b[?25l')
    expect(all).toContain('\x1b[>2u')
    written.length = 0
    t.restore()
    t.restore() // second call must be a no-op
    const rest = written.join('')
    expect(rest).toContain('\x1b[<u')
    expect(rest).toContain('\x1b[?25h')
    expect(rest).toContain('\x1b[?1049l')
    expect(rest.indexOf('\x1b[<u')).toBeLessThan(rest.indexOf('\x1b[?1049l')) // pop kitty before leaving alt screen
    expect(rest.match(/\x1b\[\?1049l/g)).toHaveLength(1) // idempotent
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client/test/terminal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `terminal.ts`**

```ts
const ESC = '\x1b'

export class TerminalSession {
  private entered = false
  private restoredOnce = false

  constructor(private stdin: NodeJS.ReadStream, private stdout: NodeJS.WriteStream) {}

  write(s: string): void {
    this.stdout.write(s)
  }

  enter(): void {
    this.entered = true
    this.restoredOnce = false
    if (this.stdin.isTTY) this.stdin.setRawMode(true)
    this.stdin.resume()
    // alt screen, hide cursor, clear; then kitty: push flags(2=event types) + query support
    this.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`)
    this.write(`${ESC}[>2u${ESC}[?u`)
  }

  restore(): void {
    if (!this.entered || this.restoredOnce) return
    this.restoredOnce = true
    // reverse order: kitty pop FIRST (avoid flag leak — spec risk list), then cursor, then alt screen
    this.write(`${ESC}[<u`)
    this.write(`${ESC}[0m${ESC}[?25h${ESC}[?1049l`)
    if (this.stdin.isTTY) this.stdin.setRawMode(false)
    this.stdin.pause()
  }

  installExitGuards(onExit: () => void): void {
    const bail = (code: number) => {
      this.restore()
      onExit()
      process.exit(code)
    }
    process.on('SIGINT', () => bail(0))
    process.on('SIGTERM', () => bail(0))
    process.on('uncaughtException', (err) => {
      this.restore()
      console.error(err)
      onExit()
      process.exit(1)
    })
    process.on('exit', () => this.restore())
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/client/test/terminal.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the offline loop**

`packages/client/src/offline.ts`:
```ts
import {
  BotBrain, MatchRoom, MIN_COMBATANTS, TICK_MS, handleFromSeed, MAPS, randomHandle, mulberry32,
} from '@fragwait/core'
import { hostname } from 'node:os'
import { detectColorMode, viewSize } from './caps.js'
import { FrameBuffer, TermRenderer } from './framebuffer.js'
import { KillFeed, hudRows } from './hud.js'
import { IntentTracker } from './input/intent.js'
import { KeyParser } from './input/parser.js'
import { renderView } from './raycast.js'
import { TerminalSession } from './terminal.js'

const ESC = '\x1b'

export async function runOffline(opts: { name?: string }): Promise<void> {
  const seedRng = mulberry32(Date.now() >>> 0)
  const map = MAPS[Math.floor(seedRng() * MAPS.length)]!
  const room = new MatchRoom(map, Math.floor(seedRng() * 2 ** 31))
  const selfId = 'human'
  const handle = opts.name ?? handleFromSeed(hostname())
  room.addPlayer(selfId, handle, false)
  const bots = Array.from({ length: MIN_COMBATANTS - 1 }, (_, i) => {
    const id = `bot${i}`
    room.addPlayer(id, `${randomHandle(seedRng)}·synth`, true)
    return new BotBrain(id, Math.floor(seedRng() * 2 ** 31))
  })

  const term = new TerminalSession(process.stdin, process.stdout)
  const parser = new KeyParser()
  const intent = new IntentTracker(() => performance.now())
  const feed = new KillFeed()
  let banner: string | null = null
  let scoreboardHeld = 0
  let quit = false

  let { viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
  let fb = new FrameBuffer(viewCols, viewRows * 2)
  const renderer = new TermRenderer(detectColorMode(process.env))
  process.stdout.on('resize', () => {
    ;({ viewCols, viewRows } = viewSize(process.stdout.columns ?? 80, process.stdout.rows ?? 24))
    fb = new FrameBuffer(viewCols, viewRows * 2)
    renderer.reset()
    term.write(`${ESC}[2J`)
  })

  process.stdin.on('data', (chunk: Buffer) => {
    for (const e of parser.feed(chunk)) {
      if (e.key === 'kitty-ack') intent.enableTier1()
      else if ((e.key === 'q' || e.key === 'esc' || e.key === 'ctrl-c') && e.kind === 'press') quit = true
      else if (e.key === 'enter' && banner) quit = true
      else if (e.key === 'tab') scoreboardHeld = 8 // ~400ms of scoreboard per Tab press
      else intent.onKey(e)
    }
  })

  term.enter()
  term.installExitGuards(() => {})

  let seq = 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (quit || room.finished) {
        clearInterval(timer)
        resolve()
        return
      }
      room.queueInput(selfId, [intent.sample(++seq)])
      for (const b of bots) room.queueInput(b.id, [b.think(room.state, room.map)])
      for (const k of room.tick()) feed.push(k, room.state)

      renderView(fb, room.map, room.state, selfId)
      let out = renderer.frame(fb)
      const { top, bottom } = hudRows(room.state, selfId, viewCols, null, feed)
      out += `${ESC}[${viewRows + 1};1H${ESC}[0;7m${top}${ESC}[0m`
      out += `${ESC}[${viewRows + 2};1H${bottom[0]}${ESC}[${viewRows + 3};1H${bottom[1]}`
      if (banner) out += `${ESC}[2;3H${ESC}[1;7m ${banner} ${ESC}[0m`
      if (scoreboardHeld-- > 0 || room.finished) out += scoreboardOverlay(room)
      term.write(out)
    }, TICK_MS)
  })

  if (room.finished) {
    term.write(`${ESC}[2J${ESC}[H` + finalScoreboard(room))
    await new Promise<void>((r) => process.stdin.once('data', () => r()))
  }
  term.restore()
  process.exit(0)
}

function scoreboardOverlay(room: MatchRoom): string {
  const rows = Object.values(room.state.players).sort((a, b) => b.frags - a.frags)
  let s = `${ESC}[4;5H${ESC}[7m  SCOREBOARD                    ${ESC}[0m`
  rows.forEach((p, i) => {
    s += `${ESC}[${5 + i};5H${ESC}[7m  ${String(p.frags).padStart(3)}  ${p.handle.padEnd(24)}  ${ESC}[0m`
  })
  return s
}

function finalScoreboard(room: MatchRoom): string {
  const rows = Object.values(room.state.players).sort((a, b) => b.frags - a.frags)
  const lines = ['', '  MATCH OVER — press any key', '']
  rows.forEach((p, i) => lines.push(`   ${i + 1}. ${String(p.frags).padStart(3)}  ${p.handle}`))
  return lines.join('\r\n')
}
```

`packages/client/src/main.ts`:
```ts
import type { CliOpts } from './cli.js'
import { runOffline } from './offline.js'

export async function main(opts: CliOpts): Promise<void> {
  // Milestone C (Task 22) adds: try online first unless --offline
  await runOffline({ name: opts.name })
}
```

Modify `packages/client/src/cli.ts` — replace the play-mode `else` branch:
```ts
} else {
  const { main } = await import('./main.js')
  await main(opts)
}
```

- [ ] **Step 6: Manual smoke test**

Run: `npm run build && node packages/client/bin/fragwait.js`
Expected: fullscreen raycaster view, 3 bots roaming/attacking, WASD+arrows move/turn, Space fires, HP/frags update, kill feed shows lines like `lazy-linter·synth ⌫ rebased-rustacean`, Tab flashes scoreboard, `q` exits **with the terminal fully restored** (prompt normal, cursor visible, no stray characters when typing).
Also verify: `Ctrl+C` mid-game restores the terminal identically.

- [ ] **Step 7: FEEL GATE (STOP — user sign-off required)**

This is the spec's milestone-1 gate. Present the game to the user and have them play at least one full offline match in their real terminal (worst case: VS Code default terminal / Apple Terminal 256-color + decay-timer input). Questions for sign-off:
1. Does held-W movement feel continuous (no stutter) with OS key-repeat?
2. Is turning speed acceptable for aiming at bots?
3. Is it FUN for 3 minutes?

If input feels bad: first tune `decayMs` (150–300), OS key-repeat hints, and `TURN_SPEED` — do NOT proceed to Milestone C until the user says the offline game is fun. Record the verdict in the PR/commit message.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(client): offline match loop vs bots with full terminal session handling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 16: Claude event listener + busy files + in-game banner

**Files:**
- Create: `packages/client/src/claude.ts`
- Modify: `packages/client/src/offline.ts` (wire banner + busy polling into the existing loop)
- Test: `packages/client/test/claude.test.ts`

**Interfaces:**
- Consumes: nothing from core (Node `http`, `fs`, `os` only).
- Produces:
  ```ts
  interface ClaudeListener { port: number; onEvent(cb: (event: string) => void): void; close(): Promise<void> }
  startClaudeListener(dir?: string): Promise<ClaudeListener>
  // dir defaults to ~/.fragwait; writes {dir}/client.json {"port":N,"pid":process.pid}; POST /event {"event":"done"|"attention"} → cb
  busyElapsedSeconds(dir?: string, now?: number): number | null
  // newest mtime among {dir}/busy-* files → seconds since; null if none
  ```
- Banner contract (wired into the game loop): event `done` → banner `✔ Claude is done — Enter: quit & return · Esc: dismiss`; event `attention` → banner `⚠ Claude needs your input — Enter: quit & return`; `esc` with an active banner dismisses the banner instead of quitting; `enter` with an active banner quits. HUD top row gets `busyElapsedSeconds()` (checked once per second, not per tick).

- [ ] **Step 1: Write the failing tests**

`packages/client/test/claude.test.ts`:
```ts
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { busyElapsedSeconds, startClaudeListener } from '../src/claude.js'

describe('startClaudeListener', () => {
  it('writes client.json and delivers POSTed events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const listener = await startClaudeListener(dir)
    const meta = JSON.parse(readFileSync(join(dir, 'client.json'), 'utf8'))
    expect(meta.port).toBe(listener.port)
    expect(meta.pid).toBe(process.pid)

    const got = new Promise<string>((resolve) => listener.onEvent(resolve))
    const res = await fetch(`http://127.0.0.1:${listener.port}/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'done' }),
    })
    expect(res.status).toBe(200)
    expect(await got).toBe('done')
    await listener.close()
  })
  it('rejects garbage without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    const listener = await startClaudeListener(dir)
    const res = await fetch(`http://127.0.0.1:${listener.port}/event`, { method: 'POST', body: 'not json' })
    expect(res.status).toBe(400)
    await listener.close()
  })
})

describe('busyElapsedSeconds', () => {
  it('returns seconds since newest busy file, null when none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fragwait-'))
    expect(busyElapsedSeconds(dir)).toBeNull()
    const f = join(dir, 'busy-abc123')
    writeFileSync(f, '')
    const past = (Date.now() - 90_000) / 1000
    utimesSync(f, past, past)
    const s = busyElapsedSeconds(dir)
    expect(s).toBeGreaterThanOrEqual(89)
    expect(s).toBeLessThanOrEqual(95)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/client/src/claude.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.fragwait')

export interface ClaudeListener {
  port: number
  onEvent(cb: (event: string) => void): void
  close(): Promise<void>
}

export async function startClaudeListener(dir = DEFAULT_DIR): Promise<ClaudeListener> {
  mkdirSync(dir, { recursive: true })
  const callbacks: Array<(event: string) => void> = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const { event } = JSON.parse(body) as { event?: string }
        if (event !== 'done' && event !== 'attention') throw new Error('bad event')
        res.writeHead(200).end('ok')
        for (const cb of callbacks) cb(event)
      } catch {
        res.writeHead(400).end('bad request')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const metaPath = join(dir, 'client.json')
  writeFileSync(metaPath, JSON.stringify({ port, pid: process.pid }))
  return {
    port,
    onEvent: (cb) => callbacks.push(cb),
    close: async () => {
      try { if (existsSync(metaPath)) unlinkSync(metaPath) } catch { /* best effort */ }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export function busyElapsedSeconds(dir = DEFAULT_DIR, now = Date.now()): number | null {
  let newest = 0
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('busy-')) continue
      const m = statSync(join(dir, f)).mtimeMs
      if (m > newest) newest = m
    }
  } catch {
    return null
  }
  return newest === 0 ? null : Math.max(0, (now - newest) / 1000)
}
```

- [ ] **Step 4: Wire the banner into the offline loop**

In `packages/client/src/offline.ts`, at the top of `runOffline` add:
```ts
import { busyElapsedSeconds, startClaudeListener } from './claude.js'
```
```ts
const listener = await startClaudeListener()
listener.onEvent((event) => {
  banner = event === 'done'
    ? '✔ Claude is done — Enter: quit & return · Esc: dismiss'
    : '⚠ Claude needs your input — Enter: quit & return'
})
```
Change the key handling: `esc` dismisses the banner when one is active (sets `banner = null`) instead of quitting; `enter` quits only when a banner is active. Replace the HUD call's `null` busy argument with a value refreshed once per second:
```ts
let busySeconds: number | null = null
let lastBusyPoll = 0
// inside the tick, before hudRows:
if (performance.now() - lastBusyPoll > 1000) {
  busySeconds = busyElapsedSeconds()
  lastBusyPoll = performance.now()
}
const { top, bottom } = hudRows(room.state, selfId, viewCols, busySeconds, feed)
```
And before `process.exit(0)`: `await listener.close()`.

- [ ] **Step 5: Run all tests + manual banner test**

Run: `npx vitest run && npm run build`, then in one terminal `node packages/client/bin/fragwait.js`, in another:
```bash
curl -s -X POST "http://127.0.0.1:$(node -e 'console.log(require(process.env.HOME+"/.fragwait/client.json").port)')/event" -H 'content-type: application/json' -d '{"event":"done"}'
```
Expected: banner appears in-game; Esc dismisses; Enter exits cleanly; `~/.fragwait/client.json` removed after exit.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(client): Claude event listener, busy files, in-game banner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Milestone C — multiplayer: protocol, Cloudflare server, netcode
*(Gated on the Task 15 feel-gate sign-off.)*

### Task 17: Wire protocol with validating parsers

**Files:**
- Create: `packages/core/src/protocol.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/protocol.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ClientMsg = { t: 'join'; handle: string } | { t: 'input'; inputs: PlayerInput[] } | { t: 'leave' }
  type ServerMsg = { t: 'welcome'; id: string; state: MatchState } | { t: 'snap'; state: MatchState } | { t: 'end'; state: MatchState }
  sanitizeHandle(raw: string): string      // lowercase, [a-z0-9-] only, 1-24 chars, never contains '·' (bot glyph is reserved), fallback 'anon'
  parseClientMsg(raw: string): ClientMsg | null   // null on anything malformed; raw capped at 4096 chars; inputs array capped at 10; every input field type/range-checked
  parseServerMsg(raw: string): ServerMsg | null   // shape check on t + presence of state/id
  ```
  JSON on the wire (spec §4.3: debuggability first, msgpack later).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/protocol.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseClientMsg, parseServerMsg, sanitizeHandle } from '../src/protocol.js'

describe('sanitizeHandle', () => {
  it('lowercases, strips invalid, caps at 24', () => {
    expect(sanitizeHandle('Rebased_Rustacean!')).toBe('rebasedrustacean')
    expect(sanitizeHandle('a'.repeat(40))).toHaveLength(24)
    expect(sanitizeHandle('fake·synth')).toBe('fakesynth') // bot glyph reserved
    expect(sanitizeHandle('###')).toBe('anon')
  })
})

describe('parseClientMsg', () => {
  it('valid join/input/leave pass', () => {
    expect(parseClientMsg('{"t":"join","handle":"abc"}')).toEqual({ t: 'join', handle: 'abc' })
    expect(parseClientMsg('{"t":"leave"}')).toEqual({ t: 'leave' })
    const input = parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":1,"strafe":0,"turn":-1,"fire":true}]}')
    expect(input).toEqual({ t: 'input', inputs: [{ seq: 1, forward: 1, strafe: 0, turn: -1, fire: true }] })
  })
  it('rejects malformed payloads', () => {
    expect(parseClientMsg('nonsense')).toBeNull()
    expect(parseClientMsg('{"t":"input","inputs":[{"seq":"x"}]}')).toBeNull()
    expect(parseClientMsg('{"t":"input","inputs":[{"seq":1,"forward":9,"strafe":0,"turn":0,"fire":false}]}')).toBeNull()
    expect(parseClientMsg(`{"t":"join","handle":"${'a'.repeat(9000)}"}`)).toBeNull() // oversized
    const many = JSON.stringify({ t: 'input', inputs: Array(50).fill({ seq: 1, forward: 0, strafe: 0, turn: 0, fire: false }) })
    expect(parseClientMsg(many)).toBeNull()
  })
})

describe('parseServerMsg', () => {
  it('round-trips a snap', () => {
    const snap = { t: 'snap', state: { tick: 1, timeLeftTicks: 10, mapId: 'x', players: {}, rail: { pos: { x: 1, y: 1 }, present: true, respawnTimer: 0 }, kills: [] } }
    expect(parseServerMsg(JSON.stringify(snap))).toEqual(snap)
    expect(parseServerMsg('{"t":"wat"}')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/test/protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/core/src/protocol.ts`:
```ts
import type { MatchState, PlayerInput } from './types.js'

export type ClientMsg =
  | { t: 'join'; handle: string }
  | { t: 'input'; inputs: PlayerInput[] }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'welcome'; id: string; state: MatchState }
  | { t: 'snap'; state: MatchState }
  | { t: 'end'; state: MatchState }

const MAX_RAW = 4096
const MAX_INPUTS = 10

export function sanitizeHandle(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  return clean.length > 0 ? clean : 'anon'
}

function isTri(v: unknown): v is -1 | 0 | 1 {
  return v === -1 || v === 0 || v === 1
}

function isInput(v: unknown): v is PlayerInput {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['seq'] === 'number' && Number.isFinite(o['seq'])
    && isTri(o['forward']) && isTri(o['strafe']) && isTri(o['turn'])
    && typeof o['fire'] === 'boolean'
}

export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > MAX_RAW) return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['t'] === 'join' && typeof o['handle'] === 'string') return { t: 'join', handle: sanitizeHandle(o['handle']) }
  if (o['t'] === 'leave') return { t: 'leave' }
  if (o['t'] === 'input' && Array.isArray(o['inputs']) && o['inputs'].length <= MAX_INPUTS && o['inputs'].every(isInput)) {
    return { t: 'input', inputs: o['inputs'] as PlayerInput[] }
  }
  return null
}

export function parseServerMsg(raw: string): ServerMsg | null {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['t'] === 'welcome' && typeof o['id'] === 'string' && typeof o['state'] === 'object' && o['state'] !== null) return o as unknown as ServerMsg
  if ((o['t'] === 'snap' || o['t'] === 'end') && typeof o['state'] === 'object' && o['state'] !== null) return o as unknown as ServerMsg
  return null
}
```

Add to `packages/core/src/index.ts`:
```ts
export * from './protocol.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/test/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): validating wire protocol for client/server messages

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 18: Server package scaffold + Worker router

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/wrangler.jsonc`, `packages/server/src/router.ts`, `packages/server/src/index.ts`
- Test: `packages/server/test/router.test.ts`

**Interfaces:**
- Produces:
  - `route(pathname: string, method: string): { kind: 'join' } | { kind: 'ws'; matchId: string } | { kind: 'health' } | null` — pure, unit-tested; `index.ts` maps it onto DO stubs
  - Worker entry with `Env { MATCH: DurableObjectNamespace; LOBBY: DurableObjectNamespace }` (MatchDO/LobbyDO classes land in Tasks 19–20; scaffold exports empty shells so `wrangler deploy` type-checks)

- [ ] **Step 1: Scaffold files**

`packages/server/package.json` (resolve exact current versions of `wrangler` and `@cloudflare/workers-types` with `npm view` and pin):
```json
{
  "name": "@fragwait/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "build": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "@fragwait/core": "0.1.0" },
  "devDependencies": {
    "wrangler": "4.21.0",
    "@cloudflare/workers-types": "4.20260601.0"
  }
}
```

`packages/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["@cloudflare/workers-types"],
    "lib": ["ES2022"]
  },
  "include": ["src"]
}
```

`packages/server/wrangler.jsonc`:
```jsonc
{
  "name": "fragwait-server",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "durable_objects": {
    "bindings": [
      { "name": "MATCH", "class_name": "MatchDO" },
      { "name": "LOBBY", "class_name": "LobbyDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MatchDO", "LobbyDO"] }
  ]
}
```

- [ ] **Step 2: Write the failing router test**

`packages/server/test/router.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { route } from '../src/router.js'

describe('route', () => {
  it('maps the three endpoints', () => {
    expect(route('/api/join', 'POST')).toEqual({ kind: 'join' })
    expect(route('/match/abc123def/ws', 'GET')).toEqual({ kind: 'ws', matchId: 'abc123def' })
    expect(route('/', 'GET')).toEqual({ kind: 'health' })
  })
  it('rejects everything else', () => {
    expect(route('/api/join', 'GET')).toBeNull()
    expect(route('/match//ws', 'GET')).toBeNull()
    expect(route('/match/UPPER/ws', 'GET')).toBeNull() // DO ids are lowercase hex
    expect(route('/secret', 'GET')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/server/test/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/server/src/router.ts`:
```ts
export type Route = { kind: 'join' } | { kind: 'ws'; matchId: string } | { kind: 'health' } | null

export function route(pathname: string, method: string): Route {
  if (pathname === '/' && method === 'GET') return { kind: 'health' }
  if (pathname === '/api/join' && method === 'POST') return { kind: 'join' }
  const m = pathname.match(/^\/match\/([0-9a-f]+)\/ws$/)
  if (m && method === 'GET') return { kind: 'ws', matchId: m[1]! }
  return null
}
```

`packages/server/src/index.ts`:
```ts
import { route } from './router.js'

export interface Env {
  MATCH: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const r = route(url.pathname, req.method)
    if (!r) return new Response('not found', { status: 404 })
    if (r.kind === 'health') return new Response('fragwait-server ok')
    if (r.kind === 'join') {
      const continent = (req.cf?.continent as string | undefined) ?? 'XX'
      return env.LOBBY.get(env.LOBBY.idFromName(continent)).fetch(req)
    }
    return env.MATCH.get(env.MATCH.idFromString(r.matchId)).fetch(req)
  },
}

export { MatchDO } from './match-do.js'
export { LobbyDO } from './lobby-do.js'
```

Temporary shells so the scaffold type-checks (replaced in Tasks 19–20):

`packages/server/src/match-do.ts`:
```ts
export class MatchDO implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('match: not implemented yet', { status: 501 })
  }
}
```

`packages/server/src/lobby-do.ts`:
```ts
export class LobbyDO implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('lobby: not implemented yet', { status: 501 })
  }
}
```

- [ ] **Step 5: Verify tests + typecheck**

Run: `npm install && npx vitest run packages/server/test/router.test.ts && npm run build -w @fragwait/server`
Expected: router tests PASS; `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): worker scaffold, router, DO bindings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 19: `MatchHost` + `MatchDO` — authoritative rooms on Durable Objects

**Files:**
- Create: `packages/server/src/match-host.ts`
- Modify: `packages/server/src/match-do.ts` (replace shell)
- Test: `packages/server/test/match-host.test.ts`

**Interfaces:**
- Consumes: `MatchRoom`, `BotBrain`, protocol parsers, constants from core.
- Produces:
  ```ts
  interface ClientConn { send(data: string): void; close(): void }
  class MatchHost {
    constructor(seed: number)               // picks map via seeded rng
    join(conn: ClientConn, handle: string): string | null // player id, or null (send 'full' handled by DO); evicts one bot if needed; sends welcome
    handleMessage(id: string, raw: string): void          // parseClientMsg → queueInput / leave
    leave(id: string): void
    tick(): 'running' | 'ended' | 'empty'  // bots think+queue, room.tick, broadcast snap; 'ended' broadcasts end first; 'empty' = zero humans (caller must stop ticking — DO CPU-budget rule)
    humanCount(): number
  }
  ```
  Bot policy (spec §4.3 + backfill pattern): after any join/leave, bots are adjusted so `total = max(MIN_COMBATANTS, humans)` capped at `MAX_PLAYERS`; a joining human when the room is at `MAX_PLAYERS` with ≥1 bot evicts one bot; a human joining a bot-free full room gets `null`. Bot handles: `randomHandle(rng) + '·synth'`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/match-host.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS, MIN_COMBATANTS, parseServerMsg } from '@fragwait/core'
import { MatchHost, type ClientConn } from '../src/match-host.js'

function conn(): ClientConn & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (d: string) => sent.push(d), close: () => {} }
}

describe('MatchHost', () => {
  it('first human gets a welcome and bots backfill to MIN_COMBATANTS', () => {
    const host = new MatchHost(1)
    const c = conn()
    const id = host.join(c, 'tester')
    expect(id).not.toBeNull()
    const welcome = parseServerMsg(c.sent[0]!)
    expect(welcome?.t).toBe('welcome')
    if (welcome?.t !== 'welcome') return
    expect(Object.keys(welcome.state.players)).toHaveLength(MIN_COMBATANTS)
    const bots = Object.values(welcome.state.players).filter((p) => p.bot)
    expect(bots).toHaveLength(MIN_COMBATANTS - 1)
    expect(bots.every((b) => b.handle.endsWith('·synth'))).toBe(true)
  })

  it('inputs move the player; snaps broadcast each tick', () => {
    const host = new MatchHost(2)
    const c = conn()
    const id = host.join(c, 'mover')!
    const welcome = parseServerMsg(c.sent[0]!)!
    const x0 = welcome.t === 'welcome' ? welcome.state.players[id]!.pos.x : 0
    host.handleMessage(id, JSON.stringify({ t: 'input', inputs: [{ seq: 1, forward: 1, strafe: 0, turn: 0, fire: false }] }))
    expect(host.tick()).toBe('running')
    const snap = parseServerMsg(c.sent[c.sent.length - 1]!)!
    expect(snap.t).toBe('snap')
    const me = snap.state.players[id]!
    expect(Math.hypot(me.pos.x - x0, 0)).toBeGreaterThan(0) // moved (direction depends on spawn facing)
  })

  it('human joining a bot-padded full room evicts one bot; bot-free full room rejects', () => {
    const host = new MatchHost(3)
    const conns = Array.from({ length: MAX_PLAYERS }, conn)
    const ids = conns.map((c, i) => host.join(c, `h${i}`))
    expect(ids.every(Boolean)).toBe(true) // bots evicted one by one as humans join
    expect(host.humanCount()).toBe(MAX_PLAYERS)
    expect(host.join(conn(), 'late')).toBeNull() // full of humans
  })

  it('zero humans → empty (caller stops the loop)', () => {
    const host = new MatchHost(4)
    const c = conn()
    const id = host.join(c, 'quitter')!
    expect(host.tick()).toBe('running')
    host.leave(id)
    expect(host.tick()).toBe('empty')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/test/match-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/match-host.ts`:
```ts
import {
  BotBrain, MatchRoom, MAPS, MAX_PLAYERS, MIN_COMBATANTS, mulberry32,
  parseClientMsg, randomHandle, type ServerMsg,
} from '@fragwait/core'

export interface ClientConn { send(data: string): void; close(): void }

export class MatchHost {
  private room: MatchRoom
  private conns = new Map<string, ClientConn>()
  private brains = new Map<string, BotBrain>()
  private rng: () => number
  private nextId = 0

  constructor(seed: number) {
    this.rng = mulberry32(seed)
    this.room = new MatchRoom(MAPS[Math.floor(this.rng() * MAPS.length)]!, Math.floor(this.rng() * 2 ** 31))
    this.syncBots()
  }

  humanCount(): number {
    return this.room.humanCount()
  }

  join(conn: ClientConn, handle: string): string | null {
    if (this.humanCount() >= MAX_PLAYERS) return null
    if (this.room.playerCount() >= MAX_PLAYERS) this.evictOneBot()
    const id = `p${this.nextId++}`
    this.room.addPlayer(id, handle, false)
    this.conns.set(id, conn)
    this.syncBots()
    this.send(conn, { t: 'welcome', id, state: this.room.state })
    return id
  }

  handleMessage(id: string, raw: string): void {
    const msg = parseClientMsg(raw)
    if (!msg) return
    if (msg.t === 'input') this.room.queueInput(id, msg.inputs)
    else if (msg.t === 'leave') this.leave(id)
  }

  leave(id: string): void {
    this.conns.get(id)?.close()
    this.conns.delete(id)
    if (this.room.state.players[id]) this.room.removePlayer(id)
    if (this.humanCount() > 0) this.syncBots()
  }

  tick(): 'running' | 'ended' | 'empty' {
    if (this.humanCount() === 0) return 'empty'
    for (const [id, brain] of this.brains) this.room.queueInput(id, [brain.think(this.room.state, this.room.map)])
    this.room.tick()
    const msg: ServerMsg = this.room.finished ? { t: 'end', state: this.room.state } : { t: 'snap', state: this.room.state }
    for (const conn of this.conns.values()) this.send(conn, msg)
    if (this.room.finished) {
      for (const conn of this.conns.values()) conn.close()
      return 'ended'
    }
    return 'running'
  }

  private send(conn: ClientConn, msg: ServerMsg): void {
    try { conn.send(JSON.stringify(msg)) } catch { /* dead socket: cleaned up on close event */ }
  }

  private evictOneBot(): void {
    const botId = [...this.brains.keys()].pop()
    if (!botId) return
    this.brains.delete(botId)
    this.room.removePlayer(botId)
  }

  private syncBots(): void {
    const target = Math.min(MAX_PLAYERS, Math.max(MIN_COMBATANTS, this.humanCount()))
    while (this.room.playerCount() > target && this.brains.size > 0) this.evictOneBot()
    while (this.room.playerCount() < target) {
      const id = `b${this.nextId++}`
      this.room.addPlayer(id, `${randomHandle(this.rng)}·synth`, true)
      this.brains.set(id, new BotBrain(id, Math.floor(this.rng() * 2 ** 31)))
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/server/test/match-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the MatchDO shell**

`packages/server/src/match-do.ts`:
```ts
import { TICK_MS } from '@fragwait/core'
import { MatchHost } from './match-host.js'

export class MatchDO implements DurableObject {
  private host: MatchHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ids = new WeakMap<WebSocket, string>()

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    this.host ??= new MatchHost(Math.floor(Math.random() * 2 ** 31))

    server.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      const id = this.ids.get(server)
      if (id) {
        this.host?.handleMessage(id, raw)
        return
      }
      // first message must be join
      const joinId = raw.includes('"join"')
        ? this.host!.join({ send: (d) => server.send(d), close: () => server.close(1000, 'bye') },
            (JSON.parse(raw) as { handle?: string }).handle ?? 'anon')
        : null
      if (joinId === null) {
        server.close(1013, 'full')
        return
      }
      this.ids.set(server, joinId)
      this.startLoop()
    })
    server.addEventListener('close', () => {
      const id = this.ids.get(server)
      if (id) this.host?.leave(id)
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  private startLoop(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const status = this.host?.tick() ?? 'empty'
      if (status !== 'running') this.stopLoop() // 'empty' rooms must stop: DO CPU budget (spec §4.3)
    }, TICK_MS)
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null // next join builds a fresh match
  }
}
```
Note: raw `JSON.parse` above is safe — `handleMessage`/`parseClientMsg` do the strict validation; the join fast-path re-sanitizes via `MatchHost.join` → `sanitizeHandle` happens inside `parseClientMsg` only, so pass the handle through `sanitizeHandle` explicitly. Import it and change the join call to `sanitizeHandle((JSON.parse(raw) as { handle?: string }).handle ?? 'anon')`.

- [ ] **Step 6: Typecheck + local smoke**

Run: `npm run build -w @fragwait/server && (cd packages/server && npx wrangler dev --local --port 8787 &) && sleep 5 && curl -s http://127.0.0.1:8787/`
Expected: `fragwait-server ok`. Kill wrangler afterwards.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): MatchHost with bot backfill and MatchDO tick loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 20: Lobby — registry logic + `LobbyDO`

**Files:**
- Create: `packages/server/src/lobby-logic.ts`
- Modify: `packages/server/src/lobby-do.ts` (replace shell)
- Test: `packages/server/test/lobby-logic.test.ts`

**Interfaces:**
- Consumes: `MAX_PLAYERS`, `MATCH_TICKS`, `TICK_RATE` from core.
- Produces:
  ```ts
  class LobbyRegistry {
    pick(nowMs: number, exclude?: string): string | null // open match id: most-assigned first (fill hottest), skipping full/expired/excluded
    register(id: string, nowMs: number): void            // new match with assigned=1
    assign(id: string): void                             // assigned++
  }
  ```
  Entries expire `MATCH_TICKS / TICK_RATE * 1000 + 30_000` ms after registration (a match can't outlive its clock + grace) — no occupancy reporting in v1; over-assignment is corrected client-side (a `full` close → rejoin with `exclude`).
- LobbyDO API: `POST /api/join` body `{"exclude"?: string}` → `{"matchId": "<64-hex>"}`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/lobby-logic.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from '@fragwait/core'
import { LobbyRegistry } from '../src/lobby-logic.js'

describe('LobbyRegistry', () => {
  it('returns null when empty, fills hottest open match first', () => {
    const reg = new LobbyRegistry()
    expect(reg.pick(0)).toBeNull()
    reg.register('m1', 0)
    reg.register('m2', 0)
    reg.assign('m2') // m2 now hotter (2 vs 1)
    expect(reg.pick(1000)).toBe('m2')
  })
  it('skips full matches', () => {
    const reg = new LobbyRegistry()
    reg.register('m1', 0)
    for (let i = 1; i < MAX_PLAYERS; i++) reg.assign('m1')
    expect(reg.pick(1000)).toBeNull()
  })
  it('skips expired matches and excluded ids', () => {
    const reg = new LobbyRegistry()
    reg.register('m1', 0)
    expect(reg.pick(0, 'm1')).toBeNull() // excluded
    expect(reg.pick(4 * 60_000)).toBeNull() // expired (3min match + 30s grace)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/server/test/lobby-logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/server/src/lobby-logic.ts`:
```ts
import { MATCH_TICKS, MAX_PLAYERS, TICK_RATE } from '@fragwait/core'

const TTL_MS = (MATCH_TICKS / TICK_RATE) * 1000 + 30_000

interface Entry { assigned: number; createdAt: number }

export class LobbyRegistry {
  private open = new Map<string, Entry>()

  register(id: string, nowMs: number): void {
    this.open.set(id, { assigned: 1, createdAt: nowMs })
  }

  assign(id: string): void {
    const e = this.open.get(id)
    if (e) e.assigned++
  }

  pick(nowMs: number, exclude?: string): string | null {
    let best: { id: string; assigned: number } | null = null
    for (const [id, e] of this.open) {
      if (nowMs - e.createdAt > TTL_MS) {
        this.open.delete(id)
        continue
      }
      if (id === exclude || e.assigned >= MAX_PLAYERS) continue
      if (!best || e.assigned > best.assigned) best = { id, assigned: e.assigned }
    }
    return best?.id ?? null
  }
}
```

`packages/server/src/lobby-do.ts`:
```ts
import { LobbyRegistry } from './lobby-logic.js'

export interface LobbyEnv { MATCH: DurableObjectNamespace }

export class LobbyDO implements DurableObject {
  private registry = new LobbyRegistry()

  constructor(private state: DurableObjectState, private env: LobbyEnv) {}

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    let exclude: string | undefined
    try {
      const body = (await req.json()) as { exclude?: string }
      if (typeof body.exclude === 'string') exclude = body.exclude
    } catch { /* empty body is fine */ }
    const now = Date.now()
    let matchId = this.registry.pick(now, exclude)
    if (matchId) {
      this.registry.assign(matchId)
    } else {
      matchId = this.env.MATCH.newUniqueId().toString()
      this.registry.register(matchId, now)
    }
    return Response.json({ matchId })
  }
}
```
Also update `packages/server/src/index.ts` `Env` usage if needed (LobbyDO receives env via constructor — wrangler provides it; the `Env` interface there already has `MATCH`).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run packages/server/test/lobby-logic.test.ts && npm run build -w @fragwait/server`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): lobby registry with TTL expiry and hottest-first fill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 21: Client netcode — prediction, reconciliation, interpolation

**Files:**
- Create: `packages/client/src/net/predictor.ts`, `packages/client/src/net/interp.ts`
- Test: `packages/client/test/netcode.test.ts`

**Interfaces:**
- Consumes: `stepPlayer`, `wrapAngle`, `PlayerState`, `MatchState`, `GameMap`, `INTERP_DELAY_MS` from core.
- Produces:
  ```ts
  class Predictor {
    self: PlayerState
    constructor(initial: PlayerState, map: GameMap)
    applyLocal(input: PlayerInput): void                 // push pending + stepPlayer immediately
    onServerState(server: PlayerState): void             // drop pending ≤ server.lastInputSeq, rebase, replay pending
  }
  class Interpolator {
    push(state: MatchState, atMs: number): void          // keep last 20 snaps
    sample(renderAtMs: number): MatchState | null        // lerp pos + angle-lerp dir between surrounding snaps; players present in only one snap use the newer state; null before ≥1 snap
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/client/test/netcode.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { makeInput, parseMap, stepPlayer } from '@fragwait/core'
import type { MatchState, PlayerState } from '@fragwait/core'
import { Interpolator } from '../src/net/interp.js'
import { Predictor } from '../src/net/predictor.js'

const MAP = parseMap('open', 'Open', [
  '####################',
  '#SSSSSSSS..........#',
  '#..................#',
  '#.........R........#',
  '#..................#',
  '####################',
].join('\n'))

function player(over: Partial<PlayerState> = {}): PlayerState {
  return { id: 'me', handle: 'me', bot: false, pos: { x: 5, y: 3 }, dir: 0, hp: 100, frags: 0, deaths: 0, fireCooldown: 0, spawnProtection: 0, hasRail: false, lastInputSeq: 0, ...over }
}

describe('Predictor', () => {
  it('replaying pending inputs on a server rebase converges exactly (determinism)', () => {
    const pred = new Predictor(player(), MAP)
    const serverSide = player()
    const inputs = Array.from({ length: 10 }, (_, i) => makeInput(i + 1, { forward: 1, turn: i % 2 ? 1 : 0 }))
    for (const i of inputs) pred.applyLocal(i)
    // server has only processed the first 5
    for (const i of inputs.slice(0, 5)) stepPlayer(serverSide, i, MAP)
    pred.onServerState(structuredClone(serverSide))
    // full 10-input sim is the expected client view
    const expected = player()
    for (const i of inputs) stepPlayer(expected, i, MAP)
    expect(pred.self.pos.x).toBeCloseTo(expected.pos.x, 10)
    expect(pred.self.pos.y).toBeCloseTo(expected.pos.y, 10)
    expect(pred.self.dir).toBeCloseTo(expected.dir, 10)
  })
  it('server correction overrides local drift', () => {
    const pred = new Predictor(player(), MAP)
    pred.applyLocal(makeInput(1, { forward: 1 }))
    const corrected = player({ pos: { x: 9, y: 3 }, lastInputSeq: 1 }) // server says: actually here
    pred.onServerState(corrected)
    expect(pred.self.pos.x).toBeCloseTo(9)
  })
})

describe('Interpolator', () => {
  function snap(tick: number, x: number): MatchState {
    return { tick, timeLeftTicks: 100, mapId: 'open', players: { other: player({ id: 'other', pos: { x, y: 3 } }) }, rail: { pos: MAP.railSpawn, present: true, respawnTimer: 0 }, kills: [] }
  }
  it('lerps between snapshots', () => {
    const interp = new Interpolator()
    interp.push(snap(1, 2), 0)
    interp.push(snap(2, 4), 100)
    const mid = interp.sample(50)!
    expect(mid.players['other']!.pos.x).toBeCloseTo(3)
  })
  it('clamps outside the buffer and handles joins', () => {
    const interp = new Interpolator()
    expect(interp.sample(0)).toBeNull()
    interp.push(snap(1, 2), 0)
    expect(interp.sample(-50)!.players['other']!.pos.x).toBeCloseTo(2)
    expect(interp.sample(500)!.players['other']!.pos.x).toBeCloseTo(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/client/test/netcode.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/client/src/net/predictor.ts`:
```ts
import { stepPlayer, type GameMap, type PlayerInput, type PlayerState } from '@fragwait/core'

export class Predictor {
  self: PlayerState
  private pending: PlayerInput[] = []

  constructor(initial: PlayerState, private map: GameMap) {
    this.self = structuredClone(initial)
  }

  applyLocal(input: PlayerInput): void {
    this.pending.push(input)
    if (this.pending.length > 64) this.pending.shift()
    stepPlayer(this.self, input, this.map)
  }

  onServerState(server: PlayerState): void {
    this.pending = this.pending.filter((i) => i.seq > server.lastInputSeq)
    const rebased = structuredClone(server)
    for (const i of this.pending) stepPlayer(rebased, i, this.map)
    this.self = rebased
  }
}
```

`packages/client/src/net/interp.ts`:
```ts
import { wrapAngle, type MatchState } from '@fragwait/core'

export class Interpolator {
  private snaps: Array<{ at: number; state: MatchState }> = []

  push(state: MatchState, atMs: number): void {
    this.snaps.push({ at: atMs, state })
    if (this.snaps.length > 20) this.snaps.shift()
  }

  sample(renderAtMs: number): MatchState | null {
    if (this.snaps.length === 0) return null
    if (this.snaps.length === 1 || renderAtMs <= this.snaps[0]!.at) return this.snaps[0]!.state
    const last = this.snaps[this.snaps.length - 1]!
    if (renderAtMs >= last.at) return last.state
    let i = 0
    while (this.snaps[i + 1]!.at < renderAtMs) i++
    const a = this.snaps[i]!
    const b = this.snaps[i + 1]!
    const t = (renderAtMs - a.at) / Math.max(1, b.at - a.at)
    const out: MatchState = structuredClone(b.state)
    for (const [id, pb] of Object.entries(out.players)) {
      const pa = a.state.players[id]
      if (!pa) continue // joined between snaps: use newer state as-is
      pb.pos.x = pa.pos.x + (pb.pos.x - pa.pos.x) * t
      pb.pos.y = pa.pos.y + (pb.pos.y - pa.pos.y) * t
      pb.dir = wrapAngle(pa.dir + wrapAngle(pb.dir - pa.dir) * t)
    }
    return out
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/client/test/netcode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(client): prediction/reconciliation and snapshot interpolation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 22: Online mode — NetClient, game loop, deploy, soak

**Files:**
- Create: `packages/client/src/net/client.ts`, `packages/client/src/online.ts`, `packages/server/scripts/soak.ts`
- Modify: `packages/client/src/main.ts`, `packages/client/package.json` (add `ws` dep, exact pin), `packages/client/src/offline.ts` (extract shared loop pieces if trivially reusable — otherwise keep loops separate; do NOT force a premature abstraction)

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  // net/client.ts
  interface NetHandlers { onWelcome(id: string, state: MatchState): void; onSnap(state: MatchState): void; onEnd(state: MatchState): void; onClose(reason: string): void }
  class NetClient {
    static async connect(serverUrl: string, handle: string, handlers: NetHandlers, timeoutMs?: number): Promise<NetClient>
    // POST {serverUrl}/api/join → {matchId}; open ws(s)://.../match/{matchId}/ws; send join; resolve on welcome; retry once with exclude on close(1013 'full')
    sendInputs(batch: PlayerInput[]): void
    leave(): void
  }
  // online.ts
  runOnline(opts: { name?: string; server: string }): Promise<'played' | 'unreachable'>
  // main.ts final behavior:
  //   --offline → runOffline
  //   else runOnline(server = opts.server ?? process.env.FRAGWAIT_SERVER ?? DEFAULT_SERVER); on 'unreachable' → notice + runOffline
  ```
- Online loop (differences from offline): every `TICK_MS` sample intent → `predictor.applyLocal` → accumulate into batch; flush batch via `sendInputs` every `INPUT_BATCH_MS` (2 inputs/packet — the free-tier batching from spec §4.2); render state = `interp.sample(now − INTERP_DELAY_MS)` with `players[selfId]` replaced by `predictor.self`; kills pushed to feed from each snap's `state.kills`; `end` message → final scoreboard; banner/busy wiring identical to offline (same listener).

- [ ] **Step 1: Add the `ws` dependency**

Run `npm view ws version` (pin exact; floor 8.18.0) and add to `packages/client/package.json` `"dependencies"`: `"ws": "8.18.0"`, plus `"@types/ws": "8.5.13"` to root devDependencies. `npm install`.

- [ ] **Step 2: Implement NetClient**

`packages/client/src/net/client.ts`:
```ts
import { parseServerMsg, type MatchState, type PlayerInput } from '@fragwait/core'
import WebSocket from 'ws'

export interface NetHandlers {
  onWelcome(id: string, state: MatchState): void
  onSnap(state: MatchState): void
  onEnd(state: MatchState): void
  onClose(reason: string): void
}

export class NetClient {
  private constructor(private ws: WebSocket) {}

  static async connect(serverUrl: string, handle: string, handlers: NetHandlers, timeoutMs = 4000): Promise<NetClient> {
    const base = serverUrl.replace(/\/$/, '')
    let exclude: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exclude ? { exclude } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`join failed: ${res.status}`)
      const { matchId } = (await res.json()) as { matchId: string }
      const wsUrl = `${base.replace(/^http/, 'ws')}/match/${matchId}/ws`
      const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs })
      const outcome = await new Promise<'ok' | 'full' | 'error'>((resolve) => {
        const client = new NetClient(ws)
        ws.on('open', () => ws.send(JSON.stringify({ t: 'join', handle })))
        ws.on('message', (data) => {
          const msg = parseServerMsg(data.toString())
          if (!msg) return
          if (msg.t === 'welcome') {
            handlers.onWelcome(msg.id, msg.state)
            resolve('ok')
          } else if (msg.t === 'snap') handlers.onSnap(msg.state)
          else handlers.onEnd(msg.state)
        })
        ws.on('close', (code, reason) => {
          if (reason.toString() === 'full') resolve('full')
          else resolve('error')
          handlers.onClose(reason.toString())
        })
        ws.on('error', () => resolve('error'))
        void client
      })
      if (outcome === 'ok') return new NetClient(ws)
      if (outcome === 'full') {
        exclude = matchId
        continue
      }
      throw new Error('connect failed')
    }
    throw new Error('no open match')
  }

  sendInputs(batch: PlayerInput[]): void {
    if (this.ws.readyState === WebSocket.OPEN && batch.length > 0) {
      this.ws.send(JSON.stringify({ t: 'input', inputs: batch }))
    }
  }

  leave(): void {
    try {
      this.ws.send(JSON.stringify({ t: 'leave' }))
      this.ws.close()
    } catch { /* already closed */ }
  }
}
```
(NOTE for the implementer: the promise wiring above resolves `welcome` before returning the instance — keep handler registration exactly once; if the double-`new NetClient(ws)` bothers the type checker, restructure to build one instance before the Promise. Behavior contract is what the interface block states.)

- [ ] **Step 3: Implement the online loop**

`packages/client/src/online.ts` — same skeleton as `runOffline` with these substitutions (write it as a full standalone function; copy the terminal/input/HUD/banner wiring from `offline.ts`):
```ts
import {
  INPUT_BATCH_MS, INTERP_DELAY_MS, TICK_MS, handleFromSeed, mapById, sanitizeHandle,
  type MatchState, type PlayerInput,
} from '@fragwait/core'
import { hostname } from 'node:os'
// ... same client imports as offline.ts, plus:
import { NetClient } from './net/client.js'
import { Interpolator } from './net/interp.js'
import { Predictor } from './net/predictor.js'

export async function runOnline(opts: { name?: string; server: string }): Promise<'played' | 'unreachable'> {
  const handle = sanitizeHandle(opts.name ?? handleFromSeed(hostname()))
  let selfId = ''
  let map: ReturnType<typeof mapById> | null = null
  let predictor: Predictor | null = null
  const interp = new Interpolator()
  let ended: MatchState | null = null
  let closed = false

  let net: NetClient
  try {
    net = await NetClient.connect(opts.server, handle, {
      onWelcome(id, state) {
        selfId = id
        map = mapById(state.mapId)
        predictor = new Predictor(state.players[id]!, map)
      },
      onSnap(state) {
        interp.push(state, performance.now())
        if (predictor && state.players[selfId]) predictor.onServerState(state.players[selfId]!)
      },
      onEnd(state) { ended = state },
      onClose() { closed = true },
    })
  } catch {
    return 'unreachable'
  }

  // terminal session, parser, intent, feed, banner, busy polling: identical setup to runOffline
  // per-tick (TICK_MS): const input = intent.sample(++seq); predictor?.applyLocal(input); batch.push(input)
  // per-INPUT_BATCH_MS: net.sendInputs(batch.splice(0))
  // render source: const base = interp.sample(performance.now() - INTERP_DELAY_MS)
  //   if (base && predictor) { const view = structuredClone(base); view.players[selfId] = predictor.self; renderView(fb, map!, view, selfId); for (const k of base.kills) feedPushOnce(k) }
  // feedPushOnce: keep a Set of `${k.tick}:${k.victimId}` to avoid double-pushing kills across interpolated samples
  // quit path: net.leave() before terminal restore; ended/closed → final scoreboard (from `ended` or last snap)
  // returns 'played'
}
```
The commented lines are the exact integration contract; expand them to real code following `offline.ts` line-for-line (this is deliberate duplication — two ~150-line loops beat one parameter-soup loop; revisit only after both are stable).

`packages/client/src/main.ts` (replace):
```ts
import type { CliOpts } from './cli.js'
import { runOffline } from './offline.js'
import { runOnline } from './online.js'

export const DEFAULT_SERVER = 'http://127.0.0.1:8787' // replaced with the deployed URL in Step 6

export async function main(opts: CliOpts): Promise<void> {
  if (!opts.offline) {
    const server = opts.server ?? process.env['FRAGWAIT_SERVER'] ?? DEFAULT_SERVER
    const result = await runOnline({ name: opts.name, server })
    if (result === 'played') return
    console.log('fragwait: server unreachable — offline match vs bots\n')
  }
  await runOffline({ name: opts.name })
}
```

- [ ] **Step 4: Local end-to-end test (two clients, one wrangler dev)**

```bash
(cd packages/server && npx wrangler dev --local --port 8787 &)
sleep 5
npm run build
node packages/client/bin/fragwait.js --server http://127.0.0.1:8787   # terminal 1
node packages/client/bin/fragwait.js --server http://127.0.0.1:8787   # terminal 2 (another window)
```
Expected: both clients land in the SAME match (lobby fill-hottest), see each other move in real time, can frag each other, bots fill the remaining slots, quitting one client leaves the other running with a backfilled bot.

- [ ] **Step 5: Soak + cost check script**

`packages/server/scripts/soak.ts`:
```ts
// Synthetic load: N ws clients sending batched random inputs for M seconds.
// Usage: npx tsx scripts/soak.ts http://127.0.0.1:8787 8 60
import WebSocket from 'ws'

const [server = 'http://127.0.0.1:8787', nStr = '8', secsStr = '60'] = process.argv.slice(2)
const n = Number(nStr)
const secs = Number(secsStr)
let snaps = 0
let msgs = 0

async function client(i: number): Promise<void> {
  const res = await fetch(`${server}/api/join`, { method: 'POST', body: '{}' })
  const { matchId } = (await res.json()) as { matchId: string }
  const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/match/${matchId}/ws`)
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ t: 'join', handle: `soak${i}` }))
  ws.on('message', () => snaps++)
  let seq = 0
  const timer = setInterval(() => {
    const mk = () => ({ seq: ++seq, forward: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1, strafe: 0 as const, turn: (Math.floor(Math.random() * 3) - 1) as -1 | 0 | 1, fire: Math.random() < 0.2 })
    ws.send(JSON.stringify({ t: 'input', inputs: [mk(), mk()] }))
    msgs++
  }, 100)
  setTimeout(() => { clearInterval(timer); ws.close() }, secs * 1000)
}

await Promise.all(Array.from({ length: n }, (_, i) => client(i)))
await new Promise((r) => setTimeout(r, secs * 1000 + 2000))
console.log(`clients=${n} duration=${secs}s`)
console.log(`snapshots received: ${snaps} (${(snaps / n / secs).toFixed(1)}/s per client — expect ~20)`)
console.log(`input packets sent: ${msgs} (${(msgs / n / secs).toFixed(1)}/s per client — expect ~10)`)
console.log(`billable-request estimate/match-minute: ${Math.round((msgs / secs) * 60 / 20)} (incoming ws msgs / 20)`)
```
Run against `wrangler dev --local` first, verify ~20 snaps/s per client. Add `"soak": "tsx scripts/soak.ts"` to server package scripts and `tsx` (exact pin) to root devDependencies.

- [ ] **Step 6: Deploy to Cloudflare + point the client at it**

```bash
cd packages/server && npx wrangler login && npx wrangler deploy
```
Record the deployed URL (`https://fragwait-server.<account>.workers.dev`). Update `DEFAULT_SERVER` in `packages/client/src/main.ts` to that URL. Re-run the soak against production for 60s with 8 clients; check `npx wrangler tail` for errors and the Cloudflare dashboard request counts against the free-tier math (spec §4.3).

- [ ] **Step 7: Run all tests, then commit**

```bash
npx vitest run && git add -A && git commit -m "feat: online multiplayer — netclient, online loop, deploy, soak harness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# Milestone D — Claude Code plugin + release

### Task 23: Plugin + marketplace scaffold

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

**Interfaces:**
- Produces: an installable plugin skeleton: `/plugin marketplace add <github-owner>/<repo>` then `/plugin install fragwait@fragwait` works once the repo is on GitHub (hooks/skill land in Tasks 24–25).

- [ ] **Step 1: Create plugin manifest**

`plugin/.claude-plugin/plugin.json`:
```json
{
  "name": "fragwait",
  "version": "0.1.0",
  "description": "Terminal FPS deathmatch for Claude Code wait time — play other waiting devs, get pulled back the moment Claude finishes.",
  "author": { "name": "fragwait contributors" },
  "homepage": "https://github.com/OWNER/fragwait",
  "license": "MIT"
}
```
(`OWNER` = the GitHub owner chosen at repo-publish time — set it in Task 26 Step 1; grep for `OWNER` then.)

- [ ] **Step 2: Create marketplace manifest (repo root)**

`.claude-plugin/marketplace.json`:
```json
{
  "name": "fragwait",
  "owner": { "name": "fragwait contributors" },
  "plugins": [
    {
      "name": "fragwait",
      "source": "./plugin",
      "description": "Terminal FPS deathmatch for Claude Code wait time"
    }
  ]
}
```

- [ ] **Step 3: Validate + commit**

Run: `claude plugin validate .` (if the CLI subcommand is available; otherwise proceed — install-time validation in Task 25 covers it).
```bash
git add -A && git commit -m "feat(plugin): plugin and marketplace manifests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 24: Hooks — busy marker + finish notification

**Files:**
- Create: `plugin/hooks/hooks.json`, `plugin/hooks/busy.sh`, `plugin/hooks/notify.sh`
- Test: `plugin/test/hooks.test.sh`

**Interfaces:**
- Consumes: the client's contract from Task 16: `~/.fragwait/client.json {"port":N}`, `POST /event {"event":"done"|"attention"}`, busy files `~/.fragwait/busy-<session_id>`.
- Produces:
  - `UserPromptSubmit` (async) → `busy.sh`: touches `~/.fragwait/busy-$SESSION_ID`
  - `Stop` (async) → `notify.sh done`; `Notification` matcher `idle_prompt` → `notify.sh done`; matcher `permission_prompt` → `notify.sh attention`
  - `notify.sh`: removes the busy file, POSTs to the game client (1 s timeout, silent failure), emits hook JSON with `terminalSequence` OSC 9 desktop notification
  - All hooks exit 0 always (a game must never break Claude).

- [ ] **Step 1: Write the hook scripts**

`plugin/hooks/busy.sh`:
```bash
#!/usr/bin/env bash
# UserPromptSubmit: mark this session busy so the in-game HUD can show wait time.
set -u
DIR="$HOME/.fragwait"
mkdir -p "$DIR"
SESSION_ID=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).session_id||"unknown").replace(/[^a-zA-Z0-9-]/g,""))}catch{process.stdout.write("unknown")}})' 2>/dev/null || echo unknown)
touch "$DIR/busy-${SESSION_ID:-unknown}"
exit 0
```

`plugin/hooks/notify.sh`:
```bash
#!/usr/bin/env bash
# Stop / Notification: clear busy marker, ping the game client, desktop-notify.
set -u
EVENT="${1:-done}"
DIR="$HOME/.fragwait"
STDIN=$(cat)
SESSION_ID=$(printf '%s' "$STDIN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).session_id||"unknown").replace(/[^a-zA-Z0-9-]/g,""))}catch{process.stdout.write("unknown")}})' 2>/dev/null || echo unknown)
rm -f "$DIR/busy-${SESSION_ID:-unknown}" 2>/dev/null

PORT=$(node -e 'try{const p=require(process.env.HOME+"/.fragwait/client.json").port;if(Number.isInteger(p))process.stdout.write(String(p))}catch{}' 2>/dev/null)
if [ -n "${PORT:-}" ]; then
  curl -s -m 1 -X POST "http://127.0.0.1:${PORT}/event" \
    -H 'content-type: application/json' \
    -d "{\"event\":\"${EVENT}\"}" >/dev/null 2>&1 || true
fi

if [ "$EVENT" = "done" ]; then MSG="Claude Code: task finished - return to terminal"; else MSG="Claude Code needs your input"; fi
printf '{"terminalSequence":"\\u001b]0;fragwait: %s\\u0007\\u001b]9;%s\\u0007"}' "$MSG" "$MSG"
exit 0
```
Run `chmod +x plugin/hooks/busy.sh plugin/hooks/notify.sh`.

`plugin/hooks/hooks.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/busy.sh\"", "async": true } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/notify.sh\" done", "async": true } ] }
    ],
    "Notification": [
      { "matcher": "idle_prompt", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/notify.sh\" done", "async": true } ] },
      { "matcher": "permission_prompt", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/notify.sh\" attention", "async": true } ] }
    ]
  }
}
```
(Verify the exact matcher names and `async` field spelling against the current hooks reference at code.claude.com/docs/en/hooks before committing — they were verified 2026-07 but the surface is young.)

- [ ] **Step 2: Write the hook test script**

`plugin/test/hooks.test.sh`:
```bash
#!/usr/bin/env bash
# Fixture test for busy.sh + notify.sh. Run from repo root: bash plugin/test/hooks.test.sh
set -euo pipefail
export HOME=$(mktemp -d)
DIR="$HOME/.fragwait"
FIXTURE='{"session_id":"testsession1","cwd":"/tmp","hook_event_name":"UserPromptSubmit"}'

echo "$FIXTURE" | bash plugin/hooks/busy.sh
[ -f "$DIR/busy-testsession1" ] || { echo "FAIL: busy file not created"; exit 1; }

# fake game client
node -e '
const http = require("http");
const fs = require("fs");
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c).on("end", () => {
    fs.writeFileSync(process.env.HOME + "/received.json", b);
    res.end("ok");
    srv.close();
  });
});
srv.listen(0, "127.0.0.1", () => {
  fs.mkdirSync(process.env.HOME + "/.fragwait", { recursive: true });
  fs.writeFileSync(process.env.HOME + "/.fragwait/client.json", JSON.stringify({ port: srv.address().port, pid: 1 }));
  console.log("ready");
});
setTimeout(() => process.exit(0), 5000);
' &
NODE_PID=$!
sleep 1

OUT=$(echo "$FIXTURE" | bash plugin/hooks/notify.sh done)
sleep 0.5
[ ! -f "$DIR/busy-testsession1" ] || { echo "FAIL: busy file not removed"; exit 1; }
grep -q '"event":"done"' "$HOME/received.json" || { echo "FAIL: client not notified"; exit 1; }
echo "$OUT" | grep -q 'terminalSequence' || { echo "FAIL: no terminalSequence emitted"; exit 1; }
kill $NODE_PID 2>/dev/null || true
echo "PASS: hooks behave"
```

- [ ] **Step 3: Run the test**

Run: `bash plugin/test/hooks.test.sh`
Expected: `PASS: hooks behave`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(plugin): busy/notify hooks with terminalSequence notification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 25: Launcher + `/fragwait:play` skill

**Files:**
- Create: `plugin/bin/fragwait-launch`, `plugin/skills/play/SKILL.md`

**Interfaces:**
- Consumes: published `fragwait` npm package (until it is published, the launcher's `FRAGWAIT_CMD` env override points at the local build).
- Produces: `/fragwait:play` — launches the game on the best available surface: tmux split → new OS terminal window → printed instructions. Never blocks Claude; never asks for permissions (launcher runs as skill preprocessing).

- [ ] **Step 1: Write the launcher**

`plugin/bin/fragwait-launch`:
```bash
#!/usr/bin/env bash
# Launch the fragwait client on a separate terminal surface (Claude owns this TTY).
set -u
CMD="${FRAGWAIT_CMD:-npx -y fragwait@0.1.0}"   # exact version pin; bump on release

if [ -n "${TMUX:-}" ]; then
  tmux split-window -h "$CMD" && { echo "fragwait: opened in a tmux split (game right, Claude left)"; exit 0; }
fi

case "$(uname -s)" in
  Darwin)
    /usr/bin/osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "$CMD"
end tell
APPLESCRIPT
    if [ $? -eq 0 ]; then echo "fragwait: opened a new Terminal window"; exit 0; fi
    ;;
  Linux)
    if command -v x-terminal-emulator >/dev/null 2>&1; then
      nohup x-terminal-emulator -e $CMD >/dev/null 2>&1 &
      echo "fragwait: opened a new terminal window"; exit 0
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    if command -v wt.exe >/dev/null 2>&1; then
      wt.exe new-tab -- cmd /c "$CMD" && { echo "fragwait: opened a Windows Terminal tab"; exit 0; }
    fi
    ;;
esac

echo "fragwait: could not open a terminal automatically - run this in another terminal:"
echo "  $CMD"
exit 0
```
Run `chmod +x plugin/bin/fragwait-launch`.

- [ ] **Step 2: Write the skill**

`plugin/skills/play/SKILL.md`:
```markdown
---
name: play
description: Launch the fragwait terminal FPS on a separate terminal surface while Claude works. User-invoked only.
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/fragwait-launch"`

The launcher output above says where the game opened (tmux split, new terminal
window, or manual instructions). Relay that location to the user in ONE short
sentence and remind them: the game shows a banner the moment this session
finishes, and quitting mid-round never loses banked frags. Do not run any other
tools; do not launch the game again.
```

- [ ] **Step 3: Manual verification (macOS + tmux)**

```bash
# from a terminal OUTSIDE tmux:
FRAGWAIT_CMD="node $(pwd)/packages/client/bin/fragwait.js --offline" plugin/bin/fragwait-launch
# expect: a new Terminal.app window running the offline game
# from inside tmux:
FRAGWAIT_CMD="node $(pwd)/packages/client/bin/fragwait.js --offline" plugin/bin/fragwait-launch
# expect: horizontal split running the game
```
Then the full plugin loop: `claude` in this repo → `/plugin marketplace add ./` (local path) → `/plugin install fragwait@fragwait` → restart → submit any prompt → while Claude works, `/fragwait:play` from a second Claude session or after the turn — verify the game opens, the HUD shows "Claude working…", and when Claude finishes the banner + desktop notification fire.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(plugin): surface-detecting launcher and /fragwait:play skill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 26: Release prep — README, publish dry-run, tag

**Files:**
- Create: `README.md`
- Modify: `plugin/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` (set real GitHub OWNER), `packages/client/src/main.ts` (confirm DEFAULT_SERVER is the deployed URL)

- [ ] **Step 1: Write README.md**

Sections (write real content, ~80 lines): what it is (1 paragraph + screenshot placeholder-free ASCII mock of the HUD); install for Claude Code users (`/plugin marketplace add OWNER/fragwait` + `/plugin install fragwait@fragwait`); standalone play (`npx fragwait`); controls table; how the Claude integration works (hooks used, files written — full transparency list: `~/.fragwait/client.json`, `~/.fragwait/busy-*`; no telemetry statement; MIT); the trust posture bullet list from the spec §4.4; development (npm install / test / wrangler dev); server self-hosting note (`wrangler deploy`, `FRAGWAIT_SERVER=...`).

- [ ] **Step 2: Version + pin audit**

Run: `grep -rn '"\^\|"~' packages/*/package.json package.json` — expect NO matches (exact pins only).
Run: `grep -rn 'fragwait@' plugin/bin/fragwait-launch README.md` — version must equal `packages/client/package.json` version.

- [ ] **Step 3: Publish dry-runs (actual publish is the user's call — npm account)**

```bash
npm publish --dry-run -w @fragwait/core
npm publish --dry-run -w fragwait
```
Expected: tarballs contain `dist/` + `bin/` only; no test files. Flag to the user: publishing `@fragwait/core` requires the `fragwait` npm org (or rename to unscoped `fragwait-core` — one-line change in two package.jsons + client dependency).

- [ ] **Step 4: Full suite + tag**

```bash
npx vitest run && npm run build
git add -A && git commit -m "docs: README and release prep for v0.1.0

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag v0.1.0
```

---

## Completion criteria (phase 1 definition of done)

1. `npx vitest run` — all green.
2. Offline: `npx fragwait --offline` is fun in a worst-case terminal (feel-gate verdict recorded).
3. Online: two machines (or two terminals) frag each other on the deployed Cloudflare server; bots backfill; empty rooms terminate.
4. Plugin: install → `/fragwait:play` opens the game; Stop hook lands the banner in-game in <1 s; desktop notification fires; terminal always restored.
5. Trust: MIT license, exact pins everywhere, no telemetry, writes only under `~/.fragwait/`.
