# checkwait — terminal blitz chess (game 2 of the /games arcade)

Date: 2026-07-07 · Status: approved (user, this date)
Approach A: mirror fragwait's structure, copy the terminal plumbing, extend the
existing Cloudflare worker. Shared-library extraction deferred until game 3
(three-strikes rule).

## Product

Chess you play while Claude Code works. 3+2 blitz (3 minutes + 2s increment)
— the same 3–6 minute session shape as a fragwait match. v1 ships BOTH
opponents: online PvP via matchmaking on the existing server, with a local
minimax bot as the no-opponent fallback and the offline mode.

- npm packages: `checkwait` (client, bin) and `checkwait-core` (zero-dep
  rules/bot/protocol). Both names verified free on npm 2026-07-07.
- `/games` rotation: new entry in `plugin/games.json`
  (`npx -y checkwait@<pinned>`), so alternating runs launch FPS ↔ chess.
- Claude integration identical to fragwait: status line ("Claude working…"),
  finish banner, notification; quit-confirm pattern; post-game share card
  carrying the install commands.
- Quitting an online game = resign (clean result for the opponent). Quitting
  vs bot just ends. No adjourn/resume in v1.
- CLI: `checkwait [--offline] [--difficulty easy|normal|hard] [--name X]
  [--server url] [--mute]` — mirrors fragwait's flags. Default difficulty
  `easy` (consistent with fragwait's post-feel-gate default).

## Package: checkwait-core (workspace `packages/chess-core`)

Zero runtime deps, ESM/NodeNext, strict TS, `.js` import extensions, no
`Date.now`/`Math.random` in src (clocks advance by elapsed-ms passed in;
bot tie-breaks use the existing seeded mulberry32 pattern, copied with a
source comment).

### State

```ts
interface ChessState {
  board: (Piece | null)[]      // 64 squares, a1 = 0 … h8 = 63
  turn: 'w' | 'b'
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean }
  epSquare: number | null      // en-passant target square
  halfmoveClock: number        // for the 50-move rule
  fullmove: number
  clocksMs: { w: number; b: number }
  history: string[]            // position keys for threefold repetition
  result: Result | null        // null while in progress
}
type Piece = { type: 'p'|'n'|'b'|'r'|'q'|'k'; color: 'w'|'b' }
type Result =
  | { kind: 'checkmate' | 'resign' | 'flag'; winner: 'w' | 'b' }
  | { kind: 'stalemate' | 'fifty-move' | 'threefold' | 'insufficient' | 'draw-agreed' }
```

### Rules engine

- `legalMoves(state): Move[]` — full legality (self-check filtered), castling
  (through-check rules), en passant, promotion (`q|r|b|n`).
- `applyMove(state, move): ChessState` — pure; updates all bookkeeping
  (castling rights, ep square, halfmove clock, repetition history, clocks:
  subtract elapsed, add the +2s increment) and detects the result.
- Endings detected in `applyMove`/`tickClock`: checkmate, stalemate,
  50-move, threefold (position key = FEN board+turn+castling+ep fields),
  insufficient material (K vs K, K+B/N vs K, KB vs KB same-color bishops),
  flag fall via `tickClock(state, elapsedMs)`.
- Notation: `parseMove(state, input)` accepts coordinate (`e2e4`, `e7e8q`)
  and SAN (`Nf3`, `exd5`, `O-O`, `e8=Q`); `toSAN(state, move)` for the move
  list; `toFEN(state)` / `fromFEN(str)` for tests and debugging.

### Bot

Minimax + alpha-beta over legal moves, iterative deepening bounded by a NODE
BUDGET (never wall-clock — deterministic and testable). Evaluation: material
+ piece-square tables + simple king-safety/mobility terms. Seeded RNG breaks
ties among equal-scored root moves so games vary. Difficulty = budget:

- easy ≈ 1-ply-ish budget (captures obvious material, blunders often)
- normal ≈ casual-player budget
- hard ≈ club-ish budget (bounded so a move never takes more than ~1s of
  client CPU; exact budgets tuned during implementation, pinned by tests)

### Protocol (mirrors fragwait's parse/validate discipline)

Client→server: `{t:'join', handle}`, `{t:'move', move:'e2e4', seq}`,
`{t:'resign'}`. Server→client: `{t:'welcome', color, opponent, state}`,
`{t:'move', move, clocksMs, seq}`, `{t:'end', result, state}`. A
`parseChessClientMsg` guards the DO exactly like fragwait's `parseClientMsg`
(first-message-must-be-join, protocol violation → close 1002).

## Server (inside `packages/server` — same worker, one deploy)

- `ChessLobbyDO`: pairs the first two waiting joiners into a match id. If no
  opponent arrives within ~10s the server replies `no-opponent` and the
  CLIENT falls back to a local bot game — no server-side bot simulation.
  In-memory state only (same accepted v1 trade as fragwait's LobbyDO).
- `ChessMatchDO`: authoritative. Validates every move with checkwait-core,
  owns the 3+2 clocks (DO alarm scheduled at the to-move player's flag time),
  relays moves with updated clocks, emits `end` on any result. Disconnect or
  leave = resign. Room size exactly 2; spectators out of scope.
- Routing added to the existing router: `POST /chess/join`,
  `GET /chess/match/:id/ws`. Existing fragwait routes untouched.
- The worker imports checkwait-core; fragwait-core stays untouched (no
  version bump or republish of the FPS packages).

## Package: checkwait client (workspace `packages/chess-client`)

- **Copied plumbing** (with `// copied from packages/client/... (fragwait)`
  source comments): TerminalSession, KeyParser, caps/viewSize, the Claude
  listener, QuitConfirm, shareCard shape. No mouselock (cursor mode only —
  the pointer IS the square picker). No raycaster/framebuffer.
- **Board render**: 8×8 squares at 6 cols × 3 rows each (48×24 + HUD fits the
  recommended 100×28 terminal; smaller terminals get 4×2 squares). Unicode
  pieces (♔♕♖♗♘♙) with truecolor light/dark square backgrounds; low-color
  fallback = ASCII letters on checkered reverse-video. Last move + check
  highlighted.
- **Input**: click a piece → legal destinations highlight → click destination
  (click-click, no drag). Typed moves on a one-line input (coordinate or
  SAN). Arrow-key cursor + Enter as the no-mouse fallback. Promotion: picker
  row (q/r/b/n) on click path; suffix letter on typed path.
- **HUD**: both clocks (active one highlighted), SAN move list (last ~8
  moves), opponent name/handle, Claude status + banner, quit-confirm
  ("press again to resign & quit" online).
- **Flow**: online by default → `/chess/join` → welcome or `no-opponent` →
  bot fallback (announced in the HUD: "no opponent online — playing the
  bot"). `--offline` skips the lobby entirely.
- **Share card**: result line (`won on time · 23 moves · vs async-pointer`),
  the install commands — same scrollback placement as fragwait's.

## Plugin

`plugin/games.json` gains `{ id: 'checkwait', title: 'checkwait — terminal
blitz chess', cmd: 'npx -y checkwait@<version>' }`. Rotation logic already
handles N entries (built for this in Task 25); launcher tests get a
two-entry rotation case.

## Testing (SDD, ledger, exact pins — house rules apply)

- **Perft**: the industry-standard move-generator proof — known node counts
  at depths 1–4 for the start position and the standard tricky FENs
  (Kiwipete, en-passant/castling edge positions). This alone catches nearly
  every rules bug.
- Core: FEN round-trips; mate/stalemate/draw fixtures; 50-move + threefold +
  insufficient-material cases; clock math incl. increment and flag;
  SAN/coordinate parse-print round-trips.
- Bot: finds mate-in-1 at every difficulty; takes a hanging queen at
  normal+; node budget respected; deterministic given a seed.
- Server: DO tests in the existing harness — join/pair, move validation
  rejects illegal moves, flag-fall alarm, disconnect = resign.
- Client: input mapping (click-click, SAN typing, promotion), render smoke,
  protocol handling. Tier-2 keyboard path exercised.

## Out of scope (v1)

Adjourn/resume, spectating, ratings/leaderboards, draw offers (auto-draws
only), Stockfish or any engine dependency, server-side bot, sound design
beyond the existing banner sfx pattern.

## Release

Publish `checkwait-core` then `checkwait` (user's terminal, passkey), deploy
the worker (chess DOs), bump `plugin/games.json` + README, tag. fragwait
packages untouched.
