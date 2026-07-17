# tankwait — terminal artillery duel (game 6 of the /games arcade)

User-chosen game 6: Scorched Earth-style artillery. Two tanks on seeded
destructible heightmap terrain, strict-alternation turns, angle + power +
wind judgment, deterministic shot playback. Turn-based on purpose: the
netcode is latency-immune by construction (no clock-sync bug class — both
blockwait clock bugs were fixed-rate-loop bugs). Named `tankwait`; npm
names `tankwait` + `tankwait-core` verified free (E404, 2026-07-17);
re-verify at release.

Follows the house pipeline end to end: zero-dep core, DOs appended as
migration v7, termwait 0.1.0 client, vtsim gate from day one, user feel
gate before publish. Lobby fills at 2 humans with bot backfill (the
blockwait duel precedent, user-approved).

## Product

- `npx -y tankwait` — join the online lobby (~10s gather, resolves early
  when a 2nd human arrives, bot backfills otherwise — never a no-opponent
  outcome). `--offline` — you vs 1 normal bot locally. `--name`,
  `--server`, `--seed` (offline determinism) mirror the family CLI exactly.
- 1v1 duel, strict alternation. On your turn: adjust angle (0–180°) and
  power (0–100) under a **20-second shot clock**, fire, both players watch
  the shot's deterministic playback, then the opponent's turn begins.
- Wind is re-rolled from the match seed before every turn and shown in the
  HUD before you aim — no shot is ever pure repetition.
- 100 HP per tank. Blast damage falls off linearly from the impact point;
  **self-damage is on** (classic — you can absolutely shoot straight up).
  Craters carve the terrain; a tank whose ground erodes falls to the new
  surface and takes fall damage past a free-fall threshold.
- Shot-clock expiry **auto-fires your last-used angle/power** (first turn:
  a seeded outward default) — a rushed shot, never a forfeit. Aim
  adjustments never cross the wire (the opponent sees only "aiming…" + the
  countdown), so the server always knows exactly what expiry fires.
- Bounded end: from round 12, both tanks lose 10 HP after each completed
  round ("the barrage closes in") — forced end by round ~21. Typical match:
  5–8 rounds, a few minutes.
- Win = opponent at 0 HP (or disconnect = forfeit, chess precedent). Both
  reach 0 on the same shot (splash + self-damage) → draw. Result screen +
  share card (outcome, rounds, damage dealt, opponent), Claude status
  line, Esc quit-confirm — all via termwait@0.1.0 (exact pin).

## Online authority model (Approach A — deterministic replay)

A "move" is two integers. So the chess template applies verbatim:

- The core exposes a pure `resolveShot(state, {angle, power})` →
  `{trajectory, impact, state'}` — fixed-timestep ballistic integration,
  crater carve, damage, tank settle, wind re-roll — fully deterministic
  from the match seed and the shot parameters.
- **The server runs it once and is the authority** (exactly chess's
  `applyMove`). The wire carries only `{angle, power}`; a lying client
  cannot claim a hit because clients never report results.
- **Each client runs the same function locally** to obtain the full
  trajectory for smooth playback — online feel = offline feel by
  construction, and wire cost is a few bytes per turn.
- Every downstream `shot` message carries the server's post-shot
  **stateHash** (fnv1a over canonical state). The client replays locally
  and compares; a mismatch is a fatal desync error (message + clean exit).
  Impossible by construction unless core determinism breaks — this is a
  tripwire, not a recovery path. No mid-match reconnect in v1, so no
  resync machinery.
- **Turn deadlines stay wall-time** (chess's alarm pattern) but each new
  deadline is offset by a computed animation allowance:
  `alarmAt = now + ANIM_ALLOWANCE(trajectory.length) + SHOT_CLOCK_MS`.
  The trajectory length is known exactly at resolve time, so playback
  never eats the next player's aiming window.
- Expiry race: a shot that arrives before the expiry alarm actually
  processes is accepted normally (expiry is not a loss, so there is no
  clock-forensics on arrival — unlike chess's tickClock-on-move); once the
  alarm has auto-fired, the stale shot fails the turn check and is ignored.

## The 80x24 frame — designed first

House lesson: design for iTerm2's default 80x24 FIRST, pin with tests from
day one.

- Rows 0–1: HUD — names (24-char sanitized) + HP bars, wind arrow +
  magnitude (`◀◀◀ 7` / `3 ▶▶▶` / `— calm`), your angle/power readout,
  shot-clock countdown, round counter.
- Rows 2–22: the terrain field, 80 cols × 21 rows.
- Row 23: key hints / Claude status line.

**World units are visually isotropic**: x in columns (0..80, 1 col = 1
unit), y in units of half-rows (1 row = 2 units, field height 42 units).
Terminal cells are ~2:1 tall, so a world-space circle of radius 6 spans
6 cols × 3 rows — which *renders* round. All physics (blast radius,
fall distance, trajectory) is computed in world units; rendering
quantizes y by halving. Physics is float; rendering is the only place
that rounds.

- Terrain: solid `█` columns (256/truecolor: earth gradient by depth;
  mono: `█`). Tanks: 2-char glyphs (`▟▙`-style turret marks) sitting on
  their column, colored per player; current-turn tank highlighted.
- Shot playback: `·` trail with a moving `●` shell head, explosion flash
  (`✶` burst frames) at impact, then terrain redraw + HP/damage flash.
  Purely a replay of `resolveShot`'s returned trajectory. Shells may
  exit the top of the field mid-arc — simulation continues, rendering
  clips until re-entry.
- First renderer test: exact-80 measured visible width on every row
  (\x1b-aware strip regex, snakewait Task 8 pattern) + 24-row fit.
- Positional escapes from day one: ESC[H home, clear-to-EOL at line START
  (`\r\n ESC[K` join, including column 80 — the checkwait 0.1.8 lesson),
  trailing ESC[J; raw-string framing pin test in the first renderer task.
- Bigger windows: k=1 only, centered. layout-null → tooSmallScreen frame +
  keep polling (bomber pattern).

## Package: tankwait-core (workspace `packages/tank-core`)

Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions, no
`Date.now`/`Math.random` in src (grep test). Seeded mulberry32
(byte-identical PRNG to the other cores). Golden-master test (seed +
scripted shot tape → pinned fnv1a hash), bot-free, pinned early.

### Constants

`FIELD_W=80, FIELD_H=42` (world units), `HP_MAX=100, ANGLE_MIN=0,
ANGLE_MAX=180, POWER_MIN=0, POWER_MAX=100, DT=1/30` (s per integration
step), `GRAVITY=40` (units/s²), `POWER_SCALE=1.1` (v0 = power ×
POWER_SCALE units/s), `WIND_MAX=10` (wind ∈ [-10..10] integers),
`WIND_ACCEL=1.2` (horizontal accel = wind × WIND_ACCEL units/s²),
`MAX_FLIGHT_STEPS=600, BLAST_RADIUS=6, BLAST_DAMAGE_MAX=60,
FALL_FREE_UNITS=4, FALL_DAMAGE_PER_UNIT=3, TERRAIN_MIN=4,
TERRAIN_MAX=30, SPAWN_FLAT_HALF=2` (5 flattened cols), `SPAWN_L=[8,16],
SPAWN_R=[63,71]`, `SHOT_CLOCK_MS=20000, SUDDEN_DEATH_ROUND=12,
SUDDEN_DEATH_DECAY=10, DEFAULT_POWER=50, DEFAULT_ANGLE=60` (mirrored to
120 for the right tank).

Conventions: angle is measured the same way for both players — 0° = due
right (+x), 90° = straight up, 180° = due left. Positive wind blows
toward +x (right); the HUD arrow points the way the wind pushes.

Balance sanity (asserted by tests, not just prose): power ~46+ at the
right angle crosses the full map (v²·sin2θ/G ≥ 63 units), and max power
overshoots generously — undershoot and overshoot are both always possible.

### State & sim

- `createMatch(seed)`: midpoint-displacement heightmap over 80 columns
  (heights clamped to [TERRAIN_MIN, TERRAIN_MAX], two smoothing passes),
  seeded spawn columns (left tank in SPAWN_L, right in SPAWN_R), spawn
  neighborhoods flattened (±SPAWN_FLAT_HALF cols to the tank's height),
  seeded first player, wind rolled for turn 1.
- State: `heights: number[]` (80 floats, world y per column — plain array
  so the whole state JSON-stringifies for stateHash + golden), per tank
  {col, hp, lastAngle, lastPower, alive}, `turn` (0|1), `round`,
  `wind`, rng cursor, `result` (stamped once, never overwritten),
  stats per tank {damageDealt, shotsFired}.
- `resolveShot(state, {angle, power})` phases:
  1. **Integrate**: shell starts at the shooter's muzzle (tank col,
     terrain height + 1), v0 from angle/power; per DT step apply gravity
     and wind accel; record each position into `trajectory`. Terminate on
     x outside [0, 80) (checked first — lost shell, no impact, no
     damage), terrain contact (y ≤ heights[round(x)]), tank contact,
     floor (y ≤ 0), or MAX_FLIGHT_STEPS (guaranteed termination →
     lost-shell path).
  2. **Carve**: on impact, lower each column within BLAST_RADIUS by the
     circle's chord depth at that column (flat-bottom craters never dig
     below y=0).
  3. **Damage**: each tank takes `BLAST_DAMAGE_MAX × (1 − d/BLAST_RADIUS)`
     rounded, d = world-space distance from impact to tank center;
     shooter included (self-damage).
  4. **Settle**: any tank above its column's new height falls to it; fall
     distance beyond FALL_FREE_UNITS deals FALL_DAMAGE_PER_UNIT each.
     Settle-then-damage is one pass (heights only ever drop).
  5. **Bookkeeping**: record lastAngle/lastPower, advance turn; when both
     have fired, round++; from SUDDEN_DEATH_ROUND, both tanks lose
     SUDDEN_DEATH_DECAY HP after each completed round. Re-roll wind for
     the next turn. Stamp result if any HP ≤ 0: sole survivor wins, both
     dead → draw.
- `killPlayer(state, id)` — pure disconnect-forfeit entry (golden-isolated,
  the snakewait killSnake pattern).
- `stateHash(state)` — fnv1a over a canonical serialization; used for the
  wire tripwire and the golden master alike.

### Bots (in core — shared by offline client and server backfill)

- `createBotMind(seed)` + `botDecide(state, id, mind, difficulty)` →
  `{angle, power}`. Artillery bots are bracketing solvers, not searchers:
  - First shot: closed-form no-wind ballistic solution for the opponent's
    range, plus seeded aim noise.
  - Subsequent shots: correct by the previous miss distance (the mind
    remembers its last shot's impact x), noise shrinking per difficulty.
  - Difficulty knobs: easy = wide noise, weak correction (converges
    slowly or never); normal = converges in ~3–4 shots; hard = ~2 shots
    plus first-order wind compensation baked into the solution.
- Liveness gates from day one (the boomwait 0.1.1 lesson), across 20
  seeds of normal bot-vs-bot: every match produces a result before the
  sudden-death decay alone would force it (bots genuinely hit each
  other), median match length within [4, 14] rounds, and self-kills
  decide < 20% of matches.

### Wire protocol (in core, `protocol.ts`)

- `MAX_RAW=4096` inbound cap; hostile-input hardening with the bomber
  test patterns; validators rebuild fresh literals, per-field type+range
  checks (angle int 0–180, power int 0–100, seq strictly monotonic),
  cumulative-size caps on every decoded path.
- Upstream: `{t:'join', name}`, `{t:'shot', seq, angle, power}` — legal
  only from the current-turn player.
- Downstream: `{t:'start', seed, slot, names, firstTurn}` (clients build
  identical state via `createMatch(seed)` — no board on the wire, ever),
  `{t:'shot', by, seq, angle, power, stateHash}` (client replays through
  `resolveShot`, verifies the hash), `{t:'turn', who, deadlineMs}`
  (duration; client renders the countdown locally — display-only, the
  server alarm is the authority), `{t:'end', result}`.
- Golden encode/decode round-trip test; a full-match wire transcript test
  (server-side tape → client-side replay → identical stateHash chain).

## Server (inside `packages/server` — same worker, one deploy)

- `TankLobbyDO`: bomber queue shape, ~10s gather window, resolves early
  at 2 humans, bot backfill 'normal' otherwise, resolve-exactly-once.
- `TankMatchDO` wrapping a pure `TankMatchHost` — chess-match.ts
  transcribed (Date.now only at the DO edge, never in core):
  - Both joined → `start` broadcast, first `turn` msg, alarm at
    `now + SHOT_CLOCK_MS`.
  - Shot arrives → turn + seq check → `resolveShot` → broadcast `shot` +
    next `turn` → `setAlarm(now + ANIM_ALLOWANCE(trajectory.length) +
    SHOT_CLOCK_MS)` where `ANIM_ALLOWANCE = ceil(steps/60)·1000 + 1500`ms
    (playback runs 3 sim steps per 50ms frame = 60 steps/s, plus
    explosion/settle beat; capped by MAX_FLIGHT_STEPS at 11.5s).
  - Alarm fires mid-turn → auto-fire that player's lastAngle/lastPower
    (defaults on a first turn) through the identical resolve path.
  - Bot turns resolve server-side after a short seeded humanizing delay
    (2–4s alarm) — same resolve path, no special casing downstream.
  - Socket close = immediate forfeit via `killPlayer` (chess precedent —
    no reconnect in v1, so a grace window could not help). 'ended' →
    deleteAlarm, close both, null the host; tombstone null-safe.
- Routes: `POST /tank/join {name}` → `{matchId, token}` — **400s on
  missing/malformed body from day one** (the snakewait CF-1101 lesson);
  `GET /tank/match/:id/ws?token=`.
- wrangler.jsonc: bindings `TANK_LOBBY`, `TANK_MATCH`; **migration v7
  APPENDED** `{ "tag": "v7", "new_sqlite_classes": ["TankLobbyDO",
  "TankMatchDO"] }` — v1–v6 byte-identical, enforced by the literal
  file-reading test, which **moves from block.test.ts to tankwait's
  server test** per house rule (the newest game owns the pin). NO deploy
  until release — user-gated, from the user's terminal only.
- A named-DO 1101 with a CF reference string and no JS stack at any point
  = Cloudflare-side; remedy ladder documented at the bomber route.

## Package: tankwait client (workspace `packages/tank-client`)

- Deps: `tankwait-core`, `termwait` 0.1.0, `ws` 8.21.0 (exact pins).
- Keys: ←/→ angle ±1, ↑/↓ power ±1, A/D angle ±5, W/S power ±5 (OS
  key-repeat supplies the rate), Space or Enter fire, Esc quit-confirm.
  Aim persists between turns and pre-loads your last shot — matching the
  server's expiry rule exactly, so what expiry fires is what your HUD
  shows.
- Input-latch pattern: pure event queue drained per 50ms frame tick.
- `offline.ts`: you vs 1 normal bot, local `resolveShot`, `--seed`
  determinism; bot turns play back with the same animation allowance.
- `online.ts`: state built from the start seed; downstream `shot` msgs
  replayed through the local `resolveShot`; stateHash mismatch → fatal
  desync message + clean exit (dedicated test). Countdown rendered from
  the `turn` msg's deadlineMs, display-only. Off-turn the input queue
  drains to nothing except Esc.
- Session glue (setupGame/teardownAndExit, exit guards restoring the
  terminal on every path, resize full-clear, layout-null tooSmallScreen,
  Claude banner dismiss) transcribed from the blockwait pattern.
- Finale: result precedence `ended ?? state.result ?? closedEarly`
  synthesis; names threaded from StartMsg; stats tracked while alive (the
  b985dc8 lesson); share card (outcome, rounds, damage dealt, opponent);
  finale tests non-vacuous under fake timers + scriptable FakeWs from day
  one.
- **vtsim gate from day one** (promoted house gate, blockwait precedent):
  the checked-in VT simulator replays a headless offline run
  (`(sleep N; printf ' ') | node bin/tankwait.js --offline`) and asserts
  clean homed 80x24 frames — the positional-escape surface only feel
  gates used to catch.

## Plugin

- `plugin/games.json` gains `{ "id": "tankwait", "title": "tankwait —
  terminal artillery duel", "cmd": "npx -y tankwait@0.1.0" }` at release;
  plugin 0.6.0 → 0.7.0. Launcher rotation test extends to the 6-entry
  cycle; `--pick` suites gain tankwait cases (id, prefix, 'artillery'
  title-substring). Test stays STANDALONE-ONLY (chaining it hangs —
  re-confirmed 2026-07-17).

## Folded-in hygiene

None this cycle — the 2026-07-17 hygiene batch cleared the server-side
queue, and every remaining deferred item (fragwait input-queue cap note,
timer-fire counting in the four older clients) lives in frozen packages
and rides those packages' next version bumps, not this one.

## Testing (SDD, ledger, exact pins — house rules apply)

- TDD per task; suite green at every boundary; ledger entry + trailer
  commit per task; review-package BASE = pre-dispatch commit.
- First renderer test = 80x24 exact frame fit + raw ESC[H/K/J framing pin
  (column-80 ESC[K included).
- Golden master pinned before bots (bot-free shot-tape hash).
- Determinism grep test (no Date.now/Math.random in core src).
- Physics pins: hand-traced trajectory fixtures (flat terrain, known
  angle/power/wind → exact impact column), crater-shape fixture, damage
  falloff table, fall-damage fixture, balance sanity (cross-map
  reachability + overshoot headroom), termination proof test
  (MAX_FLIGHT_STEPS hit ⇒ lost-shell path).
- Bot gates: liveness seeds above + "bots actually converge" (normal
  bot's miss distance strictly shrinks over its first 3 shots on flat
  terrain, all seeds).
- Wire: round-trip, hostile input, full-match transcript/stateHash chain.
- Server: lobby fill-at-2/backfill, turn+deadline flow, expiry auto-fire,
  expiry race (late shot ignored), disconnect forfeit, bot-turn delay,
  migration v1–v7 append-only literal test (ownership moves here).
- Client: desync-tripwire test, finale non-vacuity, vtsim gate.
- **Stale-dist rule is process law**: any client/core src change rebuilds
  dist (`npm run build -w <pkg>`) before tests-against-dist, feel gate,
  or publish. The feel-gate command in the plan INCLUDES the build.

## Out of scope (v1)

Weapon variety (MIRV, dirt bombs…), tank movement/fuel, >2 players,
2D-grid terrain (tunnels/overhangs), live aim-preview streaming,
mid-match reconnect/resync, replays, k≥2 scaling, custom key bindings.

## Release

- Names verified free at spec time: `tankwait`, `tankwait-core` (npm E404
  2026-07-17). Re-verify at release Task 1.
- tankwait-core@0.1.0 → tankwait@0.1.0 (exact pins) → server dep pin +
  worker deploy (migration v7) → games.json + plugin 0.7.0. Publishes
  from the USER's terminal only (OTP; login expiry masquerades as E404);
  deploys with `env -u CLOUDFLARE_API_TOKEN` + Node 22 PATH from
  packages/server. Never hand the user a deploy while a background agent
  is mutating the repo.
- Feel gate by the user at iTerm2 80x24 — offline AND a quick online
  round — before any publish. Repo path contains a space: quote in
  shell, never backslash-escape in Write/Edit paths.
