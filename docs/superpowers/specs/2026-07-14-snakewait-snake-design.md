# snakewait — terminal multiplayer snake (game 4 of the /games arcade)

Chosen for launch-roster virality: Nokia-snake nostalgia is the most universal
gaming memory there is, slither.io proved multiplayer snake carries its own
viral loop, and an ASCII snake is instantly recognizable in an 80x24
screenshot. Deliberately the cheapest build in the arcade (~1/3 of boomwait):
the sim is "move heads, check collisions, spawn food" — no bombs, flames,
chains, or hidden power-ups. Tetris-versus is the agreed NEXT game after this
one (own spec/plan cycle, post-launch flagship).

## Product

- `npx -y snakewait` — join the online lobby (up to 4 humans gather ~10s,
  bots backfill to 4, never a no-opponent outcome). `--offline` — you + 3
  bots locally. `--name`, `--server`, `--seed` (offline determinism) mirror
  boomwait's CLI exactly.
- 4-snake last-alive-wins on one shared field. Snakes move constantly; you
  steer with WASD/arrows. Eat food ○ to grow +2. Die on wall, own body, or
  any snake body. Dead snakes decay into food where they lay (comeback
  dynamics). Speed escalates on a fixed schedule; sudden-death wall
  advance guarantees an end.
- Result screen + share card (same shape as boomwait's: outcome, match
  length, opponents), Claude status line, Esc quit-confirm — all via
  termwait@0.1.0 (already published; consumed with an exact pin, NOT
  re-extracted).

## The 80x24 frame — designed first

House lesson (checkwait's four feel iterations): design for iTerm2's default
80x24 FIRST, pin the layout with tests from day one.

Arena: **56 wide × 40 tall logical cells.** One logical cell = one half-block
pixel (▀▄█ foreground/background split), so the arena renders in
**56 cols × 20 char rows**. Plus a 1-char border on all sides
(58 cols × 22 rows) and a right-side HUD of 22 cols → 80 cols exactly;
22 rows + 1 status row = 23 rows ≤ 24. This exact fit is asserted by a
renderer test.

- Snakes are 1-pixel-wide trails in 4 distinct team colors; the head pixel is
  brightened, and YOUR head gets a white flash on spawn. Food is a dim dot.
  Sudden-death walls render in the border/wall color as rings close.
- Bigger windows: integer pixel scaling (k=2 when the window fits
  114×43+), centered; same layout rule. 80x24 k=1 is the asserted default.
- Color tiers: truecolor → RGB palette; 256-color → nearest xterm indices;
  basic → the 16-color ANSI palette (4 snakes + food + wall need only 6
  distinct colors, so basic terminals get real colors, not glyphs); mono →
  distinct glyphs per snake (o/x/+/#, head uppercase). Tier detection from
  termwait caps, threaded as a ColorMode param like boomwait's renderFrame.

HUD (side, 22 cols): four player rows (color swatch, name, length, † on
death), match clock, speed indicator, sudden-death warning, Claude status
line, key hints.

## Package: snakewait-core (workspace `packages/snake-core`)

Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions, no
`Date.now`/`Math.random` in src (a test greps for this). Pure fixed-tick
reducer at 20Hz: `step(state, inputs)` with seeded mulberry32 for food
spawns. Golden-master test (seed + scripted inputs → pinned fnv1a hash) is
the behavior lock, exactly like boomwait's.

### State & sim

- `GRID_W=56, GRID_H=40, TICK_RATE=20, START_LENGTH=4, FOOD_COUNT=6,
  GROWTH_PER_FOOD=2, SHRINK_START_TICK=1800 (90s), SHRINK_INTERVAL_TICKS=40`.
- Speed schedule (global, deterministic): step every 4 ticks until tick 600,
  every 3 until 1200, every 2 after (5 → 6.7 → 10 cells/s). All snakes step
  on the same ticks — simultaneous movement, no per-snake speed stat (v1).
- Spawns: rotationally symmetric corner insets, each snake laid out along its
  edge heading clockwise (p0 top-left→right, p1 top-right→down, p2
  bottom-right→left, p3 bottom-left→up). No countdown: movement starts at
  tick 0 with a long straight runway (~10s to the first wall).
- Input model: each snake holds a `pendingDir`; a non-null input dir replaces
  it UNLESS it is the 180° reverse of the current heading (ignored — the
  classic rule, which also makes OS auto-repeat harmless: same-dir is a
  no-op, reverse is rejected). Applied at the next movement step.
- Movement step (only on step ticks), in phases:
  1. Compute each alive snake's next head cell from `pendingDir` (falling
     back to current heading).
  2. Tails vacate first (unless that snake has pending growth — growth is a
     counter decremented instead of moving the tail). Moving into a cell a
     tail just vacated is LEGAL (classic nuance).
  3. Collision check on the post-vacate occupancy: head into wall (bounds or
     closed shrink ring), head into any remaining body cell, two heads into
     the same cell (both die), head-on swap (both die). All deaths in a step
     are simultaneous.
  4. Survivors' heads advance. Food eaten → growth += GROWTH_PER_FOOD, food
     respawn queued (seeded RNG picks a uniformly random EMPTY cell; if the
     field is too full to place, the item is dropped silently).
  5. Dead snakes convert to food on the death tick: every 2nd body cell
     (even indices from the head) becomes a food item; the corpse disappears.
- Sudden death: from SHRINK_START_TICK, every SHRINK_INTERVAL_TICKS the
  outermost open ring closes to wall. Any snake with ANY cell in the closing
  ring dies entirely (the boomwait-crush precedent — simple and
  deterministic); food in the ring is destroyed. min(56,40)/2 = 20 rings →
  guaranteed end by tick 2600 (~130s) even with passive survivors.
- Result stamp: set once — last snake alive → win; 0 alive (simultaneous
  deaths) → draw. Never overwritten.

### Bots (in core — shared by offline client and server backfill)

- `botDecide(state, id, mind, difficulty)`; `createBotMind(seed)` owns the
  rng + decision bookkeeping. Decision cadence: easy 10 / normal 5 / hard 3
  ticks (the boomwait knobs).
- Core heuristic: BFS to the nearest food treating all current body cells and
  closed rings as blocked; the first hop must pass a SURVIVAL CHECK — flood
  fill from the candidate next-head cell; reachable free space must be ≥ own
  body length, else the direction is rejected (the classic no-dead-end rule).
- Fallback when no food path survives the check: the safe direction with the
  largest flood-fill space; if literally nothing is safe, the least-bad
  direction (max space). Never a voluntary reverse (the sim rejects it
  anyway).
- Hard bots additionally avoid cells adjacent to an equal-or-longer
  opponent's head (head-to-head loses for the shorter/equal snake — both die,
  which is a bad trade unless winning). Easy bots skip the survival check
  15% of decisions (the boomwait mistake-rate pattern).
- No-mass-suicide regression gates from day one (the boomwait 0.1.1 lesson):
  across 20 seeds per difficulty, all-bots sims assert ≥2 bots alive at tick
  200 and no all-dead-by-tick-100 outcome.

### Wire protocol (in core, like boomwait's protocol.ts)

- `MAX_RAW=4096` inbound cap; hostile-input hardening (coordinate/stat caps,
  malformed JSON dropped) tested with the boomwait test patterns.
- Compact WireState: tick, shrink ring count, food as [x,y] pairs, snakes as
  `[id, name, bot, alive, pendingDirCode, growth, head x, head y,
  run-length body: (dirCode, count) segments]`. RLE keeps worst-case
  snapshots small — pinned < 2048 bytes by a test using a
  deliberately-twisty worst-case body.
- Client messages: hello, `{t:'input', dir}` (sent only on change — no
  'keep' needed since there is no bomb flag to ride alongside).
- Golden fromWire/toWire round-trip test.

## Server (inside `packages/server` — same worker, one deploy)

- `SnakeLobbyDO` + `SnakeMatchDO` following the bomber DO shapes verbatim:
  ~10s gather window, bots backfill to 4, monotonic connId + start-time slot
  compaction, 50ms alarm tick loop, disconnect → 5s grace → that snake dies
  (and becomes food, per the sim rule), 'empty' stop when no sockets remain.
- Routes: `POST /snake/join {name}` → `{matchId, token}`;
  `GET /snake/match/:id/ws?token=`.
- wrangler.jsonc: bindings `SNAKE_LOBBY`, `SNAKE_MATCH`; **migration v4
  APPENDED** `{ "tag": "v4", "new_sqlite_classes": ["SnakeLobbyDO",
  "SnakeMatchDO"] }` — v1/v2/v3 untouched, enforced by the literal
  file-reading test (the boomwait pattern).
- Server package adds `"snakewait-core"` workspace dep (pinned to the real
  version at release). NO deploy until release — user-gated.

## Package: snakewait client (workspace `packages/snake-client`)

- Deps: `snakewait-core`, `termwait` (exact pins), `ws`.
- `offline.ts` / `online.ts` mirroring bomber's split: shared session glue
  (setupGame/teardownAndExit), each loop owning its own 50ms interval.
  Online is render-only — every snap replaces the rendered state; the local
  createMatch(seed) mirror covers only the pre-first-snap window.
- Online input: send `{t:'input', dir}` when the drained direction differs
  from the last sent. Offline: drained dir feeds `step` directly; a quiet
  tick passes null input (pendingDir carries in the sim — no buffering
  subtlety needed since snakes never stop).
- Quit (Esc + confirm), resize redraw hardening, Claude banner dismiss — all
  termwait, nothing re-derived.

## Plugin

- `plugin/games.json` gains `{ "id": "snakewait", "title": "snakewait —
  terminal snake battle", "cmd": "npx -y snakewait@0.1.0" }` at release,
  plugin version bump. Launcher test stays standalone (~30s rule).

## Testing (SDD, ledger, exact pins — house rules apply)

- TDD per task; suite green at every task boundary; ledger entry + trailer
  commit per task.
- The frame-fit test (80x24 exact layout) is the FIRST renderer test.
- Golden master pinned early (Task order puts sim before bots so the hash is
  bot-free, like boomwait's).
- Determinism test: no Date.now/Math.random in core src (grep test).
- Bot gates: no-mass-suicide seeds + a "bots actually eat" liveness check
  (median bot length at tick 400 > START_LENGTH across seeds).
- Wire: RLE round-trip, snapshot size pin, hostile input.
- Server: lobby fill/backfill, tick loop, disconnect grace, migration
  append-only literal test.

## Out of scope (v1)

Speed/invincibility power-ups, wrap-around walls, >4 players, spectating,
per-snake speed stats, kill-cam/replays, tetris-versus (next game, own
spec).

## Release

- Names verified free at spec time: `snakewait`, `snakewait-core` (npm E404
  2026-07-14). Re-verify at release Task 1.
- snakewait-core@0.1.0 → snakewait@0.1.0 (exact pins) → server dep pin +
  worker deploy (migration v4) → games.json + plugin bump. Publishes from
  the USER's terminal only (OTP); deploys with `env -u CLOUDFLARE_API_TOKEN`
  + Node 22 PATH (house constraints). Feel-gate by the user at iTerm2 80x24
  before any publish.
