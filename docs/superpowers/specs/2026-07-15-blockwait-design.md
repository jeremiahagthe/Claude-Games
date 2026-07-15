# blockwait — terminal 1v1 block-stacking duel (game 5 of the /games arcade)

The agreed post-launch flagship (named in the snakewait spec). Falling-block
versus is the most recognizable competitive game in existence, and a 1v1 duel
is the one format where two FULL-size boards fit an 80x24 terminal. Named
`blockwait` — "Tetris" is an actively-enforced trademark; the mechanics
(tetrominoes, SRS, 7-bag) are not protected, the name and trade dress are.
npm names `blockwait` + `blockwait-core` verified free (E404, 2026-07-15);
re-verify at release.

Breaks from the 4-player arcade pattern deliberately (user decision): lobby
fills at 2 humans, one bot backfills. Everything else follows the house
pipeline: zero-dep core, DOs appended as migration v5, termwait 0.1.0 client,
user feel gate before publish.

## Product

- `npx -y blockwait` — join the online lobby (~10s gather, resolves early
  when a 2nd human arrives, bot backfills otherwise — never a no-opponent
  outcome). `--offline` — you vs 1 bot locally. `--name`, `--server`,
  `--seed` (offline determinism) mirror the family CLI exactly.
- 1v1 duel, modern basics: SRS wall kicks, 7-bag randomizer, hold piece,
  next-3 preview, ghost piece, hard + soft drop.
- Classic-simple attacks: double sends 1, triple 2, tetris 4 garbage lines
  (single sends 0); incoming cancels 1:1 against outgoing on the same clear;
  garbage rows carry one hole. No combos, no back-to-back, no T-spin
  detection (v1).
- Gravity escalates on a fixed schedule; from 2 minutes, sudden death feeds
  both players neutral garbage — deterministic end bound ~3m40s worst case.
- Win = opponent tops out (or disconnects past grace); simultaneous top-out
  on the same tick = draw. Result screen + share card (outcome, match
  length, lines/sent, opponent), Claude status line, Esc quit-confirm — all
  via termwait@0.1.0 (exact pin, consumed as-is).

## Online authority model (Approach B — the one new architecture piece)

In a 1v1 duel the two boards are independent except for garbage. So:

- **Your board is simulated locally** by the client running the same core
  reducer — inputs apply the tick they happen; online feel = offline feel by
  construction.
- **The server stays the authority via input replay**: clients send
  tick-stamped, seq-numbered input-event batches; the MatchDO replays them
  through the identical reducer. A lying client cannot fake a clear —
  clears/attacks are derived server-side from inputs, never claimed.
  Because the boards are independent, each board advances on its OWN tick
  clock server-side (`stepPlayer`), driven by that client's batches — no
  rewind needed. Lag/lead clamps (a client may run at most 5 ticks ahead
  of the server wall clock; one lagging more than 25 ticks behind is
  force-advanced with empty inputs) keep both clocks honest, preserve the
  sudden-death end bound online, and prevent stall-to-delay-garbage.
- **Opponent board is render-only** from server snaps (4Hz) — latency there
  is harmless.
- **Garbage is server-arbitrated**: cancellation and arrival ticks are
  decided by the server and sent as explicit events so the local sim
  schedules them exactly.
- **Resync rule**: if a snap's own-board state disagrees with the local sim
  (dropped batch, garbage-timing race), the snap hard-replaces local state.
  Rare by construction; dedicated test.

## The 80x24 frame — designed first

House lesson: design for iTerm2's default 80x24 FIRST, pin with tests from
day one.

Cells render **2 chars wide × 1 char tall** (`██`) — near-square, the
classic terminal look. Each board: 10 cells × 20 visible rows → 20 cols ×
20 rows + 1-char border = **22 × 22**.

Layout: **your board (22) · center HUD (36) · opponent board (22) = 80 cols
exactly**; 22 rows + 1 status row = 23 ≤ 24. Asserted by the FIRST renderer
test: exact-80 visible width on every row (the \x1b-aware strip regex from
snakewait Task 8 — measured, not upper-bounded).

- Center HUD (36 cols): hold box + next-3 queue (pieces as 4x2-cell minis),
  garbage-incoming warning meter, lines cleared / lines sent, match clock,
  gravity level, sudden-death warning, player names (24-char sanitized),
  Claude status line, key hints.
- Colors: 7 standard piece colors (I cyan, O yellow, T purple, S green,
  Z red, L orange, J blue) + gray garbage. truecolor → RGB; 256 → nearest
  xterm indices; mono → distinct glyphs per piece kind, garbage `▒▒`.
  ColorMode threaded per renderFrame like snakewait (termwait 0.1.0 has no
  'basic' tier — known deviation, carried).
- Ghost piece: dim `··` at the hard-drop landing cells.
- Bigger windows: **k=1 only, centered** (integer-scaling 2-char cells
  distorts aspect; unlike snakewait there is no k=2). layout-null → 
  tooSmallScreen frame + keep polling (bomber pattern).
- Positional escapes from day one (snakewait feel-gate lessons 813d2a9 +
  8f417db): ESC[H home, clear-to-EOL at line START (`\r\n ESC[K` join),
  trailing ESC[J; raw-string framing pin test in the first renderer task.

## Package: blockwait-core (workspace `packages/block-core`)

Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions, no
`Date.now`/`Math.random` in src (grep test). Pure fixed-tick reducer at
20Hz: `step(state, events)` where `events` lists each player's discrete
input events for that tick: `left, right, rotCW, rotCCW, softDrop,
hardDrop, hold`. Seeded mulberry32 (byte-identical PRNG to the other
cores). Golden-master test (seed + scripted event tape → pinned fnv1a
hash), bot-free, pinned early.

### Constants

`BOARD_W=10, BOARD_H=20, HIDDEN_ROWS=4, TICK_RATE=20, PREVIEW=3,
LOCK_DELAY_TICKS=10, LOCK_RESETS_MAX=15, ATTACK={1:0, 2:1, 3:2, 4:4},
GRAVITY_SCHEDULE=[20,15,10,6,4,3,2] (ticks per cell, advance every 400
ticks, floor 2 from tick 2400), SUDDEN_DEATH_TICK=2400,
SUDDEN_DEATH_INTERVAL=100, MAX_EVENTS_PER_TICK=8`. Soft drop is one fall
attempt per `softDrop` event (OS key auto-repeat supplies the rate — up to
one cell per tick, 20 cells/s); there is no separate soft-drop factor.

### State & sim

- Per player: 10×24 cell grid (rows 20-23 hidden spawn buffer), active piece
  (kind, rotation 0-3, x, y), hold slot + one-per-piece lockout, bag cursor,
  stats (linesCleared, linesSent), pendingGarbage queue
  (entries: {rows, holeCol}), alive flag.
- **7-bag**: both players see the SAME piece sequence (fair, standard for
  versus), implemented as identical per-player bag RNGs seeded from the
  match seed — each player's queue refills independently but produces the
  same order, keeping per-player state bounded regardless of clock skew.
  Garbage hole columns use a separate rng stream so the piece sequence
  never depends on garbage history.
- **SRS**: guideline spawn positions/orientations; standard kick tables
  (JLSTZ shared table, I its own). Rotation tries 5 offsets, first legal
  wins, else rotation fails silently.
- **Tick order** per player, phases: (1) apply this tick's events in order
  (caps enforced upstream), (2) gravity fall if due (soft drop held =
  gravity×4 via softDrop events), (3) lock-delay bookkeeping — grounded
  starts the 10-tick timer, successful move/rotate resets it (max 15
  resets), expiry or hardDrop locks, (4) on lock: clear full rows, compute
  attack, cancel 1:1 vs the locker's own pendingGarbage, send the remainder
  to the opponent's pendingGarbage; then, if the locker still has pending
  garbage, materialize ALL of it now (standard "on your next lock" timing)
  — rows rise from the bottom, one seeded hole column per attack entry,
  (5) spawn next piece; spawn blocked or piece locked fully above row 20 →
  top-out.
- **Sudden death**: from tick 2400, every 100 ticks both players receive 1
  neutral garbage line — immediate materialization, bypasses pending queue,
  uncancellable. 20 rows → forced end by ~tick 4400 (~3m40s) even from
  empty boards.
- **Result stamp** set once: sole survivor → win; both top out on the same
  tick → draw. Never overwritten. Disconnect-forfeit is a server concern
  (killPlayer enters through the sim like snakewait's killSnake — pure,
  golden-isolated).

### Bots (in core — shared by offline client and server backfill)

- `createBotMind(seed)` + `botDecide(state, id, mind, difficulty)`.
  Placement enumeration (Dellacherie family): for the current piece (hard
  difficulty also tries the hold/next swap), enumerate reachable
  (rotation × column) hard-drop placements, score the resulting board:
  the classic 4-term heuristic — aggregate height, complete lines, holes,
  bumpiness — with the published El-Tetris/Lee weights pinned as constants
  (well depth dropped, YAGNI). Best placement becomes a queued input-event
  sequence (rotates → shifts → hardDrop) emitted at a human rate.
- Difficulty knobs: easy = 1 event per 8 ticks + picks uniformly from the
  top-3 placements 25% of decisions; normal = 1 per 4 ticks; hard = 1 per
  2 ticks + hold-swap enumeration.
- Liveness gates from day one (the boomwait 0.1.1 lesson): across 20 seeds,
  normal bot-vs-bot matches last ≥ 1200 ticks, each bot clears ≥ 4 lines by
  tick 1200, and no top-out before tick 400 at any difficulty.

### Wire protocol (in core, `protocol.ts`)

- `MAX_RAW=4096` inbound cap; hostile-input hardening with the bomber test
  patterns; validators rebuild fresh literals, per-field type+range checks,
  **cumulative-size caps included from day one** (the snakewait fromWire
  lesson — no unbounded decoded paths).
- Upstream: `{t:'hello'...}`, `{t:'input', seq, upTo, events:[[tick,
  code]...]}` — "my clock reached tick `upTo`; these are my events since
  the last batch", sent ~every 5 ticks. Server validation: seq and upTo
  strictly monotonic, event ticks within (lastUpTo, upTo], ≤ 8 events per
  tick, upTo at most 5 ticks ahead of the server wall clock; a player
  lagging > 25 ticks behind is force-advanced with empty inputs.
- Downstream: `start` (ids, names, seed, your slot), `snap` (full WireState,
  4Hz + on demand for resync), `garbage` ({rows, holeCol, atTick on the
  victim's own clock} — lets the local sim schedule incoming garbage
  exactly), `end`.
- WireState: per player — own tick, board as 24 hex-nibble row strings
  (0=empty, 1-7 piece kinds, 8=garbage — colors survive the wire), active
  piece tuple, hold, queue + bag rng, fall/lock bookkeeping, pending
  garbage entries, linesCleared/Sent, alive. Full PlayerState round-trips
  (resync needs it); snapshot pinned < 2048 bytes by a worst-case-board
  test.
- Golden toWire/fromWire round-trip test.

## Server (inside `packages/server` — same worker, one deploy)

- `BlockLobbyDO`: bomber queue shape, ~10s gather window, **resolves early
  at 2 humans**, bot backfill 'normal' otherwise, resolve-exactly-once.
- `BlockMatchDO`: monotonic connId + start-time compaction, 50ms alarm
  tick, **input-replay loop** — each player's board advances on its own
  clock via `stepPlayer` driven by that client's batches (lag/lead clamps
  above); the alarm force-advances laggards, routes attacks between
  boards, applies sudden death, and stamps the result; bot events injected
  server-side on the wall clock; 4Hz snap broadcast + garbage events;
  disconnect → 5s grace → forfeit via killPlayer; 'empty' stop; tombstone
  null-safe.
- Routes: `POST /block/join {name}` → `{matchId, token}`;
  `GET /block/match/:id/ws?token=`. **Join 400s on missing/malformed body
  from day one** (the snakewait CF-1101 lesson).
- wrangler.jsonc: bindings `BLOCK_LOBBY`, `BLOCK_MATCH`; **migration v5
  APPENDED** `{ "tag": "v5", "new_sqlite_classes": ["BlockLobbyDO",
  "BlockMatchDO"] }` — v1–v4 byte-identical, enforced by the literal
  file-reading test. NO deploy until release — user-gated.

## Package: blockwait client (workspace `packages/block-client`)

- Deps: `blockwait-core`, `termwait` 0.1.0, `ws` 8.21.0 (exact pins).
- Keys: ←/A →/D shift (OS key-repeat = DAS), ↑/W rotCW, Z rotCCW, ↓/S
  softDrop, Space hardDrop, C hold, Esc quit-confirm. Input-latch pattern:
  pure event queue drained per 50ms frame tick, order preserved.
- `offline.ts`: you vs 1 normal bot, local reducer, `--seed` determinism.
- `online.ts`: local reducer for YOUR board (events applied the tick they
  are sent), opponent board rendered from snaps, garbage events scheduled
  into the local sim, own-board hard-resync on divergent snap (dedicated
  test). Pre-first-snap window covered by createMatch(seed) mirror.
- Session glue (setupGame/teardownAndExit, exit guards restoring the
  terminal on every path, resize full-clear, layout-null tooSmallScreen,
  Claude banner dismiss) transcribed from the snakewait/bomber pattern.
- Finale: result precedence ended ?? state.result ?? closedEarly synthesis;
  names threaded from StartMsg; lastLength-class stats tracked while alive
  (the b985dc8 lesson — never read post-death state for the share card);
  finale tests non-vacuous under fake timers + scriptable FakeWs from day
  one.
- **vtsim gate promoted to a real test** (ledger LESSON, progress.md:268):
  a checked-in ~90-line VT simulator; a test pipes a headless offline run
  (`(sleep N; printf 'x') | node bin/blockwait.js --offline`) through it
  and asserts clean homed 80x24 frames — the positional-escape surface that
  only user feel gates caught in snakewait.

## Plugin

- `plugin/games.json` gains `{ "id": "blockwait", "title": "blockwait —
  terminal block-stacking duel", "cmd": "npx -y blockwait@0.1.0" }` at
  release; plugin version 0.4.0 → 0.5.0. Launcher rotation test extends to
  the 5-entry cycle 1→2→3→4→5→1; stays standalone-only (~30s rule).

## Folded-in hygiene (server-side FIX-LATER items — same worker deploy)

One small task, before the deploy task, no frozen packages touched:

- `/snake/join` 400-on-missing-`name` (currently throws CF 1101; bomber
  tolerates the same body — parity fix, progress.md:271).
- `packages/server/test/snake.test.ts:187` disconnect food assertion made
  non-vacuous vs initial food (progress.md:265).

Explicitly NOT in this cycle (frozen packages / own design cycle):
snake-core extractions (corpseFoodFor, DELTA/OPPOSITE hoist, fromWire cap,
createMatch guard — next snakewait-core version bump), bomber backports
(col-80 ESC[K, closedEarly/layout-null finale tests — next boomwait bump),
lobby humanCount DO-to-DO handoff (touches all games; own future cycle).
Their lessons ARE applied to blockwait's fresh code above.

## Testing (SDD, ledger, exact pins — house rules apply)

- TDD per task; suite green at every boundary; ledger entry + trailer
  commit per task; review-package BASE = pre-dispatch commit.
- First renderer test = 80x24 exact frame fit (exact-80 measured widths,
  \x1b-aware strip). Raw ESC[H/K/J framing pin in the same task.
- Golden master pinned before bots (bot-free hash, like snakewait Task 4).
- Determinism grep test (no Date.now/Math.random in core src).
- SRS pins: kick-table literals asserted; a rotation-fixture test per piece
  kind against hand-traced boards.
- Bot gates: liveness seeds above + "bots actually attack" (median
  linesSent > 0 by tick 1200 across seeds).
- Wire: round-trip, snapshot size pin, hostile input, replay-horizon clamp.
- Server: lobby fill-at-2/backfill, input-replay tick loop, disconnect
  grace forfeit, migration v5 append-only literal test.
- Client: resync test, finale non-vacuity, vtsim positional-escape gate.
- **Stale-dist rule is process law**: any client/core src change rebuilds
  dist (`npm run build -w <pkg>`) before tests-against-dist, feel gate, or
  publish. The feel-gate command in the plan INCLUDES the build.

## Out of scope (v1)

T-spins, back-to-back, combos, all-clear bonus, >2 players, spectating,
k≥2 scaling, per-player handicaps, replays, custom key bindings.

## Release

- Names verified free at spec time: `blockwait`, `blockwait-core` (npm E404
  2026-07-15). Re-verify at release Task 1.
- blockwait-core@0.1.0 → blockwait@0.1.0 (exact pins) → server dep pin +
  worker deploy (migration v5) → games.json + plugin 0.5.0. Publishes from
  the USER's terminal only (OTP; login expiry masquerades as E404); deploys
  with `env -u CLOUDFLARE_API_TOKEN` + Node 22 PATH from packages/server.
  Feel gate by the user at iTerm2 80x24 — offline AND a quick online round
  (the "online never had a human feel pass" risk ends here) — before any
  publish.
