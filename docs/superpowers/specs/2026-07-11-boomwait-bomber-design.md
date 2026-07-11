# boomwait — terminal bomberman (game 3 of the /games arcade)

Date: 2026-07-11 · Status: approved (user, this date)
Inspired by Aapeli/Playforia Bombermania. Approach: mirror the fragwait/checkwait
structure, extend the existing Cloudflare worker, and — three-strikes rule now
triggered — extract the shared terminal plumbing into a published `termwait`
package that boomwait consumes (existing games migrate later, not in this plan).

## Product

Bomberman you play while Claude Code works. One last-man-standing round on a
13x11 arena, ~2–3 minutes, up to 4 players: humans matched online, bots
backfill empty slots so a match always starts; offline mode = you vs 3 bots.
After 90 seconds, sudden death: the border spirals inward one tile per second —
standing on a closing tile kills.

- npm packages: `boomwait` (client, bin), `boomwait-core` (zero-dep
  sim/protocol/bots), `termwait` (shared terminal plumbing). All three names
  verified free on npm 2026-07-11.
- `/games` rotation: third entry in `plugin/games.json`
  (`npx -y boomwait@<pinned>`), rotating FPS → chess → bomber.
- Claude integration identical to fragwait/checkwait: status line ("Claude
  working…"), finish banner, notification, quit-confirm pattern, post-game
  share card carrying the install commands.
- Quitting an online game = eliminated (opponents keep playing). Quitting vs
  bots just ends. Disconnect online = eliminated after a 5s grace; a bot does
  NOT take over the slot.
- Mechanics: grid-locked movement (hold a direction to step at a speed-scaled
  rate); bombs with ~2s fuse, chain detonation, flames persist ~0.5s; three
  power-ups drop from destroyed soft blocks — extra bomb (+1 capacity), blast
  range (+1), speed (+1). Kick/throw/curses are out of scope for v1.
- CLI: `boomwait [--offline] [--difficulty easy|normal|hard] [--name X]
  [--server url] [--mute]` — mirrors the family's flags. Default difficulty
  `easy`.

## The 80x24 frame — designed first

Lesson from checkwait (four feel iterations): the frame is designed for
iTerm2's default 80x24 window FIRST, and the layout is pinned by tests from
day one.

Arena: 13 wide × 11 tall — classic odd×odd. Border of hard wall, hard pillars
at even-even interior coordinates, soft blocks seeded around them (seeded RNG;
the four corners + their two adjacent tiles are kept clear as spawn pockets).

Tile = `2r` cols × `r` rows (square-ish at the terminal's ~1:2 cell aspect),
adaptive like chess's cellSize:

- **r=2 — the 80x24 default: board = 52 cols × 22 rows.** Side HUD ~26 cols
  → 79 total cols; 22 board rows + 1 status row = 23 rows. iTerm2's default
  window opens directly in sprite mode with the side HUD. This exact fit is
  asserted by a renderer test.
- **r≥3** on bigger windows: larger sprites, same layout rule — side HUD
  whenever cols allow, board gets every row.
- **r=1 fallback** for tiny windows: 26×11 glyph mode, one 2-col glyph pair
  per tile, letters/symbols only. This is also Terminal.app basic mode
  (no truecolor → glyphs), matching the accepted tiering.

Rendering: half-block (▀▄█) truecolor pixels, so a tile at r rows gives
2r × 2r pixels (4×4 at the default). Sprites (players in 4 team colors, bomb
with shrinking-fuse visual, flame, soft/hard block textures, power-up icons)
are authored as 8x8 masks and nearest-neighbor scaled — the chess-4 pipeline
reused. Resize hardening (per-line ESC[K + full ESC[2J on resize) comes from
termwait, not re-derived.

HUD (side, ~26 cols): four player rows (color swatch, name, alive/dead,
bomb/range/speed counts), round timer, shrink warning, Claude status line,
key hints.

## Package: termwait (workspace `packages/term-kit`)

The three-strikes extraction — first implementation tasks of the plan, BEFORE
any boomwait code. Built by extracting the chess-client copies (newest; carry
the chess-4 resize hardening):

- Contents (6 files, ~358 lines): terminal session (raw mode, alt screen,
  cleanup-on-exit), caps detection (truecolor/basic tiering), key parser,
  quit-confirm, dismiss prompt, Claude status listener. `input/translate.ts`
  stays in chess-client — it is a chess-move typed buffer (SAN entry), not
  shared plumbing.
- The extraction is a MOVE, not a redesign: the API surface is what those
  files already export. Anything chess-specific is generalized at extraction
  time; nothing speculative is added.
- Existing chess-client behavior is locked by tests before extraction, and
  the extracted package passes the same tests.
- Published as `termwait@0.1.0`; boomwait consumes it with an exact pin.
- **fragwait and checkwait are NOT migrated in this plan.** Their shipped,
  feel-gated copies stay untouched; migration is a FIX-LATER ledger entry for
  each game's next natural release.
- Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions.

## Package: boomwait-core (workspace `packages/bomber-core`)

Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions, no
`Date.now`/`Math.random` in src. The sim is a pure fixed-tick reducer —
deterministic given seed + inputs.

### State & sim

```ts
interface BomberState {
  tick: number
  grid: Cell[]                 // 13*11; hard | soft | soft-with-powerup | empty
  players: PlayerState[]       // pos {x,y}, alive, bombCap, range, speed, activeBombs
  bombs: Bomb[]                // owner, pos, fuseTicksLeft, range
  flames: Flame[]              // pos, ticksLeft
  shrink: { nextTile: number | null; ticksToNext: number }  // spiral index
  result: Result | null        // { winner: id } | { draw: true } | null
}
step(state, inputs: Map<PlayerId, Input>): BomberState  // one tick, pure
createMatch(seed): BomberState  // seeded soft-block + power-up layout (mulberry32,
                                // copied with source comment per house pattern)
```

- **Tick rate 20** (same `TICK_RATE = 20` as fragwait). Constants: base step
  every 5 ticks, each speed power-up −1 tick with a floor of 2; fuse 40 ticks
  (2s); flames 10 ticks (0.5s); shrink starts at tick 1800 (90s), one tile per
  20 ticks, spiral order from the border inward; standing on a tile when it
  closes kills. Shrink guarantees the round ends.
- Movement: grid-locked. Input = held direction (or none) + bomb intent. A
  step occurs when the player's step cooldown expires and the target tile is
  passable (not hard/soft/bomb/closed). Bombs are solid once placed (no kick).
- Explosion resolution inside `step`: blast rays in 4 directions up to
  `range`, stopped by hard walls; each ray destroys at most one soft block
  (revealing any power-up); any bomb touched by flame detonates in the SAME
  tick (transitive chain); players on flame tiles die. If the last two (or
  more) living players die in the same tick → draw.
- Power-ups: assigned to soft blocks at `createMatch` time by the seeded RNG
  (fixed distribution tuned in implementation, pinned by tests); revealed when
  the block is destroyed; picked up by walking over; destroyed if flamed while
  exposed.
- Protocol types (client↔server messages) live in core, mirroring
  checkwait-core's parse/validate discipline: every inbound message
  size-capped and safe-parsed, never throws.

### Bots (in core — shared by offline client and server backfill)

Danger-map AI, deterministic with a per-bot seeded RNG, decision logic bounded
by node budget (never wall-clock):

- Each decision tick: compute the danger map (tiles reached by any ticking
  bomb's blast, with time-to-detonation). If standing in danger → BFS to the
  nearest safe tile. Else → approach the nearest reachable soft block or
  enemy; drop a bomb when adjacent ONLY if a safe retreat exists after
  placement; grab reachable power-ups opportunistically.
- Difficulty = decision latency + mistake rate: easy re-checks danger lazily
  and wanders; normal plays the base policy; hard also predicts chain
  reactions and shrink. Exact parameters tuned in implementation, pinned by
  tests.

## Server (inside `packages/server` — same worker, one deploy)

- New `BomberLobbyDO` + `BomberMatchDO`. wrangler.jsonc gets **migration tag
  v3 appended** — v1/v2 are never edited. Routes: `POST /bomber/join`,
  WebSocket `GET /bomber/match/:id/ws` (the chess route pattern). Existing chess/frag code untouched.
- Lobby follows fragwait's `lobby-logic.ts` shape (already N-player): ~10s
  gathering window, up to 4 humans per match, bots backfill to exactly 4 at
  match start. No mid-match join.
- Server-authoritative, inputs-up / state-down (the fragwait
  match-do/match-host model): clients send held-direction + bomb intents; the
  DO runs `step()` at 20Hz and broadcasts full-state snapshots. Grid-locked
  movement keeps snapshots small — full state every tick at this arena size;
  delta encoding only if measurement demands it. 4096-byte inbound cap +
  safe-JSON-parse copied from match-do.
- Disconnect: 5s grace, then eliminated (their placed bombs still resolve).

## Package: boomwait client (workspace `packages/bomber-client`)

- deps: `boomwait-core` (exact pin), `termwait` (exact pin), `ws` 8.21.0.
- Renderer per the 80x24 section: adaptive r, side HUD, half-block sprites,
  glyph fallback, resize hardening via termwait.
- Local prediction: none — at 20Hz with grid steps, render the last snapshot;
  offline mode runs the sim locally so latency is zero there.
- Offline mode: local `step()` loop with 3 bots at the chosen difficulty.
- Online flow: join lobby → countdown → round → result screen (winner/draw,
  power-up stats) → share card. Claude listener + quit-confirm from termwait.

## Plugin

- Third entry in `plugin/games.json`: id `boomwait`,
  cmd `npx -y boomwait@<pinned exact version>`.
- Version-bump ritual unchanged: bomber-client package.json + plugin/games.json
  cmd + plugin/.claude-plugin/plugin.json move together.

## Testing (SDD, ledger, exact pins — house rules apply)

- Core sim: golden-master determinism (same seed + scripted inputs →
  identical final state hash); explosion rays/chains/kills; shrink spiral and
  its round-end guarantee; power-up distribution under seeded RNG;
  simultaneous-death draw; movement cooldowns incl. speed floor.
- Bots: never-suicides property (a bot with a safe option never ends a
  decision on a resolved-danger tile); 4-bot seeded match completes before a
  tick cap at every difficulty.
- Renderer: 80x24 exact-fit assertion (side HUD + r=2 sprites); r=1 glyph
  fallback; resize; SGR literals pinned — constants and tests change together.
- termwait: chess-client behavior locked by tests BEFORE extraction; the
  extracted package passes the same suite.
- Server: lobby assignment (4-human and 1-human+3-bot), disconnect grace,
  message-shape/size-cap tests; migration v3 append verified against
  wrangler.jsonc.
- Launcher test runs standalone with ~30s bound (known chaining hang).

## Out of scope (v1)

- Bomb kick/throw, curses/diseases, teams — deferred.
- Migrating fragwait/checkwait to termwait — FIX-LATER ledger entries.
- Spectating, rematch-with-same-lobby, leaderboards.
- Delta-encoded snapshots (measure first).

## Release

- Publishes from the user's terminal only (OTP redaction breaks `!`-prefixed
  publishes; `npm login` sessions expire between sessions and masquerade as
  E404/E401). Order: termwait → boomwait-core → boomwait → plugin bump.
- Cloudflare deploy only on the user's explicit go, with
  `env -u CLOUDFLARE_API_TOKEN` and Node 22 PATH.
- Repo path contains a space — quote everywhere.
