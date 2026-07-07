# checkwait (terminal blitz chess) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship game 2 of the /games arcade — 3+2 blitz chess in the terminal with online PvP (existing Cloudflare worker) and a local minimax bot fallback, as npm packages `checkwait-core` + `checkwait`.

**Architecture:** Mirrors fragwait (Approach A from the spec): zero-dep deterministic core, thin authoritative Durable Objects in the EXISTING fragwait-server worker, client with copied terminal plumbing. Spec: `docs/superpowers/specs/2026-07-07-checkwait-chess-design.md` — read it first; it governs on any conflict.

**Tech Stack:** TypeScript strict / ESM NodeNext / vitest / Cloudflare Workers + DOs (wrangler 4.107.0, Node 22 for wrangler) / no runtime deps in core.

## Global Constraints (house rules — every task inherits these)

- packages/chess-core (`checkwait-core`): ZERO runtime deps; no `Date.now`/`Math.random` in src (clocks take elapsed-ms params; RNG is seeded mulberry32 copied from fragwait-core with a source comment).
- Exact version pins everywhere (`"x.y.z"`, never `^`/`~`). `.js` import extensions. Repo path contains a space — always quote.
- TDD: write the failing test first, run it, implement, run again, commit. Test literals are spec pins — change constants and tests together with the root cause stated in the test or ledger.
- Never run the interactive game in subagents; tests + build only. Feel verdicts come from the USER in iTerm2.
- After every task: append a ledger entry to `.superpowers/sdd/progress.md` (gitignored, still required) and commit with trailer exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- fragwait packages are UNTOUCHED by this project (no version bumps, no edits to packages/core, packages/client except zero-diff reads for copying).
- Run tests: `npx vitest run packages/chess-core` (etc.) from repo root; full suite `npm test` must stay green (currently 299).

## File Structure

```
packages/chess-core/            → npm "checkwait-core"
  package.json tsconfig.json
  src/index.ts                  (re-exports)
  src/board.ts                  (squares, Piece, ChessState, initial position)
  src/fen.ts                    (toFEN / fromFEN)
  src/movegen.ts                (legalMoves, applyMove, isInCheck, positionKey)
  src/result.ts                 (detectResult, insufficientMaterial, tickClock)
  src/notation.ts               (parseMove, toSAN)
  src/bot.ts                    (evaluate, bestMove, DIFFICULTY_BUDGETS)
  src/prng.ts                   (mulberry32 — copied from fragwait-core)
  src/protocol.ts               (msg types, parseChessClientMsg, parseChessServerMsg)
  test/*.test.ts                (fen, perft, movegen, result, notation, bot, protocol)
packages/server/src/
  chess-lobby.ts                (ChessLobbyDO)   [new]
  chess-match.ts                (ChessMatchDO)   [new]
  index.ts                      (add /chess routes + DO exports) [modify]
  ../wrangler.jsonc|toml        (new DO bindings + migration tag) [modify]
packages/chess-client/          → npm "checkwait"
  package.json tsconfig.json bin/checkwait.js
  src/main.ts src/cliArgs.ts
  src/terminal.ts src/input/parser.ts src/caps.ts src/claude.ts
                                (copied from packages/client with source comments;
                                 terminal.ts WITHOUT the kitty push and mouselock-specific
                                 focus plumbing it doesn't need — keep mouse ladder + 1004)
  src/input/quit.ts             (copied QuitConfirm)
  src/board-render.ts           (draw board+HUD to an ANSI string)
  src/select.ts                 (click-click/cursor selection state machine)
  src/game.ts                   (shared game loop: state, input→move, redraw)
  src/offline.ts                (vs bot)
  src/online.ts                 (lobby join, ws match, fallback to bot)
  src/share.ts                  (chess share card)
  test/*.test.ts
plugin/games.json               (add checkwait entry) [modify]
plugin/test/launcher.test.sh    (two-entry rotation case) [modify]
README.md                       (chess section) [modify]
```

---

### Task 1: chess-core scaffold + board/state + FEN

**Files:** Create `packages/chess-core/{package.json,tsconfig.json,src/{index.ts,board.ts,fen.ts,prng.ts},test/fen.test.ts}`. Modify root `package.json` workspaces if needed (workspaces glob `packages/*` likely already covers it — verify).

**Interfaces (Produces):**
```ts
// board.ts
export type Color = 'w' | 'b'
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export interface Piece { type: PieceType; color: Color }
export interface ChessState {
  board: (Piece | null)[]   // 64 entries, index = rank*8+file, a1=0 … h8=63
  turn: Color
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean }
  epSquare: number | null
  halfmoveClock: number
  fullmove: number
  clocksMs: { w: number; b: number }
  history: string[]          // positionKey strings for threefold
  result: Result | null
}
export type Result =
  | { kind: 'checkmate' | 'resign' | 'flag'; winner: Color }
  | { kind: 'stalemate' | 'fifty-move' | 'threefold' | 'insufficient' }
export const INITIAL_CLOCK_MS = 3 * 60_000
export const INCREMENT_MS = 2_000
export function initialState(): ChessState
export function sq(file: number, rank: number): number      // 0-indexed
export function sqName(i: number): string                   // 0 → 'a1'
export function nameSq(n: string): number                   // 'e4' → 28
// fen.ts
export function toFEN(s: ChessState): string                // 6-field FEN
export function fromFEN(fen: string): ChessState            // clocks = INITIAL, history=[], result=null
```

- [ ] **Step 1:** Scaffold package.json (`"name": "checkwait-core"`, `"version": "0.0.0"`, ESM, exports dist, scripts mirroring packages/core — copy packages/core/package.json and edit name/desc) + tsconfig extending the repo pattern. `npm install` to link workspace.
- [ ] **Step 2:** Write failing tests in `test/fen.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { initialState, nameSq, sqName } from '../src/board.js'
import { fromFEN, toFEN } from '../src/fen.js'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'

describe('board + FEN', () => {
  it('square helpers round-trip', () => {
    expect(sqName(0)).toBe('a1'); expect(sqName(63)).toBe('h8')
    expect(nameSq('e4')).toBe(28); expect(sqName(nameSq('c6'))).toBe('c6')
  })
  it('initialState serializes to the start FEN', () => {
    expect(toFEN(initialState())).toBe(START)
  })
  it('FEN round-trips (start, kiwipete, ep square, no castling)', () => {
    for (const f of [START, KIWIPETE,
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1']) {
      expect(toFEN(fromFEN(f))).toBe(f)
    }
  })
  it('fromFEN sets fresh clocks and empty bookkeeping', () => {
    const s = fromFEN(KIWIPETE)
    expect(s.clocksMs).toEqual({ w: 180_000, b: 180_000 })
    expect(s.history).toEqual([]); expect(s.result).toBeNull()
  })
})
```

- [ ] **Step 3:** Run `npx vitest run packages/chess-core` → FAIL (modules missing).
- [ ] **Step 4:** Implement board.ts + fen.ts (straightforward FEN field parse/print; validate 6 fields, throw plain Error on garbage). Copy mulberry32 into src/prng.ts with `// copied from packages/core/src/prng.ts (fragwait-core)`.
- [ ] **Step 5:** Run → PASS. Build clean (`npm run build`). Ledger + commit `feat(chess-core): board state and FEN round-trip`.

### Task 2: move generation + applyMove, proven by perft

**Files:** Create `packages/chess-core/src/movegen.ts`, `test/perft.test.ts`, `test/movegen.test.ts`.

**Interfaces (Produces):**
```ts
export interface Move { from: number; to: number; promotion?: PieceType } // promotion: q|r|b|n only
export function legalMoves(s: ChessState): Move[]        // fully legal (self-check filtered)
export function isInCheck(s: ChessState, color: Color): boolean
export function applyMove(s: ChessState, m: Move): ChessState  // PURE; throws on illegal
export function positionKey(s: ChessState): string        // board+turn+castling+ep (threefold key)
```
applyMove bookkeeping: move/capture incl. en passant removal; castling rook hop; promotion; update castling rights (king move, rook move, rook captured on its home square); set/clear epSquare (only on double pawn push); halfmoveClock (reset on pawn move/capture); fullmove (after black); push positionKey of the RESULTING position to history; flip turn. Clocks/result are handled in Task 3 — applyMove leaves them untouched here.

- [ ] **Step 1:** Write `test/perft.test.ts` with a local perft (counts leaf nodes via legalMoves/applyMove):

```ts
import { describe, expect, it } from 'vitest'
import { fromFEN } from '../src/fen.js'
import { applyMove, legalMoves } from '../src/movegen.js'
import type { ChessState } from '../src/board.js'

function perft(s: ChessState, depth: number): number {
  if (depth === 0) return 1
  let n = 0
  for (const m of legalMoves(s)) n += perft(applyMove(s, m), depth - 1)
  return n
}
// Standard perft suite — these node counts are the industry-accepted ground
// truth for a correct legal-move generator (castling/ep/promotion edges included).
const CASES: Array<[string, number[]]> = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
]
describe('perft', () => {
  for (const [fen, counts] of CASES) {
    counts.forEach((expected, i) => {
      it(`${fen.split(' ')[0]} depth ${i + 1} = ${expected}`, () => {
        expect(perft(fromFEN(fen), i + 1)).toBe(expected)
      })
    })
  }
})
```

- [ ] **Step 2:** Run → FAIL. Implement movegen.ts: piece move tables (knight/king offsets, sliding rays with board-edge guards on the 8x8 index math — recommend file/rank arithmetic, not raw ±deltas), pawn pushes/captures/ep/promotions, castling (rights + empty squares + not through/into/out of check), `isInCheck` via attack scan, legalMoves = pseudo-legal filtered by applying and checking own king. Debug with per-move perft breakdown against a sub-position when a count mismatches (divide technique — implement a temporary `perftDivide` locally if needed).
- [ ] **Step 3:** Add `test/movegen.test.ts` edge pins: ep capture removes the right pawn; castling illegal through check (use FEN `r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1` variants); promotion generates exactly 4 moves per push/capture; applyMove throws on an illegal move.
- [ ] **Step 4:** All green incl. full suite; perft d4 runtime should be < ~10s — if slower, note it, don't optimize further (YAGNI). Ledger + commit `feat(chess-core): legal move generation, perft-proven`.

### Task 3: results + clocks

**Files:** Create `packages/chess-core/src/result.ts`, `test/result.test.ts`. Modify movegen.ts's applyMove to call `detectResult` and stamp `state.result`, and to apply clock increment (see below).

**Interfaces (Produces):**
```ts
export function detectResult(s: ChessState): Result | null
// checkmate/stalemate (no legal moves + in/not-in check), fifty-move
// (halfmoveClock >= 100), threefold (positionKey appears 3x in history),
// insufficient (K vs K, K+N/B vs K, KB vs KB same-colored bishops)
export function tickClock(s: ChessState, elapsedMs: number): ChessState
// PURE: subtract from the to-move player's clock; at <= 0 clamp to 0 and set
// result {kind:'flag', winner: other} — UNLESS the flagged player's opponent
// has insufficient mating material (then treat as draw {kind:'insufficient'}).
```
applyMove clock rule (3+2): the mover's clock has already been ticked down by the caller via tickClock; applyMove ADDS `INCREMENT_MS` to the mover's clock after the move. Document this contract in both function docs.

- [ ] **Step 1:** Failing tests: mate fixture (`rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3` → after checking legalMoves is empty and white in check, detectResult = checkmate winner b — build the position via FEN and assert directly); stalemate (`7k/5Q2/6K1/8/8/8/8/8 b - - 0 1`); fifty-move via halfmoveClock=100 FEN; threefold by applying Nf3 Nf6 Ng1 Ng8 twice from start and asserting result; insufficient (`8/8/8/4k3/8/8/8/4K2N w - - 0 1` after any move → insufficient); flag: tickClock(state, 180_001) → flag with winner = opponent; increment: apply e2e4 after ticking 5s → white clock 175_000 + 2_000 = 177_000.
- [ ] **Step 2:** Implement; run; full suite green. Ledger + commit `feat(chess-core): endings and 3+2 clocks`.

### Task 4: notation (parseMove + toSAN)

**Files:** Create `packages/chess-core/src/notation.ts`, `test/notation.test.ts`.

**Interfaces (Produces):**
```ts
export function parseMove(s: ChessState, input: string): Move | null
// Accepts coordinate ('e2e4', 'e7e8q') and SAN ('Nf3','exd5','O-O','O-O-O',
// 'e8=Q','Qxf7+','Raxd1'); case-tolerant on coordinate input; null when the
// input names no LEGAL move (never throws on user input).
export function toSAN(s: ChessState, m: Move): string
// Standard SAN with minimal disambiguation, x for captures, =Q promotions,
// + for check and # for mate against the resulting position, O-O/O-O-O.
```

- [ ] **Step 1:** Failing tests: round-trip every legal move in the start position and in Kiwipete (`for m of legalMoves: expect(parseMove(s, toSAN(s,m))).toEqual(m)`); coordinate parse pins ('e2e4', 'g1f3', promotion 'e7e8q' from a promotion FEN); ambiguity pin (two knights can reach d2 in `r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPPNPPP/R1BQKB1R` — wait, construct FEN where both Nb1/Nf3 reach d2: `rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 1` → 'Nbd2'/'Nfd2' — implementer verifies with legalMoves and pins the exact strings); 'O-O' pin from the castling FEN; garbage → null ('zzzz', '', 'e9e9', SAN of an illegal move).
- [ ] **Step 2:** Implement; the SAN round-trip over full perft-verified move sets is the real proof. Green + full suite. Ledger + commit `feat(chess-core): coordinate + SAN notation`.

### Task 5: bot

**Files:** Create `packages/chess-core/src/bot.ts`, `test/bot.test.ts`. Modify src/index.ts re-exports (all tasks re-export as they go).

**Interfaces (Produces):**
```ts
export type ChessDifficulty = 'easy' | 'normal' | 'hard'
export const DIFFICULTY_BUDGETS: Record<ChessDifficulty, number> // node budgets, tuned in-task
export function bestMove(s: ChessState, budget: number, seed: number): Move
// Iterative-deepening negamax + alpha-beta, HARD node budget (count every
// evaluated node; when exhausted return the best move from the last COMPLETED
// depth). Eval: material (P100 N320 B330 R500 Q900) + piece-square tables
// (any standard set, committed as data) + small mobility term. Seeded
// mulberry32 shuffles root move order so equal-best moves vary by seed.
```

- [ ] **Step 1:** Failing tests: finds mate-in-1 (`6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1` → Ra8#; assert toSAN = 'Ra8#') at EVERY difficulty budget; takes a hanging queen at normal+ (`rnb1kbnr/pppp1ppp/8/4p3/4q3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1` → Nxe4-like: assert the chosen move captures on the queen's square); determinism (same state+budget+seed → same move, different seed may differ); node budget respected (instrument: export a node counter or return {move, nodes} — implementer's choice, pin it).
- [ ] **Step 2:** Implement; tune DIFFICULTY_BUDGETS so hard completes < ~1s on the dev machine (pin the budget literals in a test with a comment stating the ~1s rationale). Green + full suite. Ledger + commit `feat(chess-core): budgeted alpha-beta bot`.

### Task 6: protocol

**Files:** Create `packages/chess-core/src/protocol.ts`, `test/protocol.test.ts`.

**Interfaces (Produces):**
```ts
export type ChessClientMsg =
  | { t: 'join'; handle: string }
  | { t: 'move'; move: string; seq: number }   // coordinate notation on the wire
  | { t: 'resign' }
export type ChessServerMsg =
  | { t: 'welcome'; color: Color; opponent: string; state: string /* FEN */; clocksMs: { w: number; b: number } }
  | { t: 'move'; move: string; clocksMs: { w: number; b: number }; seq: number }
  | { t: 'end'; result: Result; state: string /* FEN */ }
export function parseChessClientMsg(raw: string): ChessClientMsg | null
export function parseChessServerMsg(raw: string): ChessServerMsg | null
```
Same defensive discipline as fragwait's protocol.ts (study `packages/core/src/protocol.ts`): JSON parse guarded, field-by-field type checks, handle sanitized to ≤24 chars of `[a-z0-9·-]` (copy fragwait's sanitizeHandle rules — read them, don't guess), unknown `t` → null.

- [ ] **Step 1:** Failing tests mirroring fragwait's protocol tests: valid msgs parse; wrong types/missing fields/oversized handle/non-JSON → null; seq must be integer ≥ 0.
- [ ] **Step 2:** Implement; green; ledger + commit `feat(chess-core): wire protocol`.

### Task 7: server DOs (existing worker) + wrangler migration

**Files:** Create `packages/server/src/chess-lobby.ts`, `packages/server/src/chess-match.ts`, `packages/server/test/chess.test.ts`. Modify `packages/server/src/index.ts` (routes + exports), the wrangler config (new DO bindings `CHESS_LOBBY`, `CHESS_MATCH` + a NEW migration tag adding both classes — read the existing migration block and append, never edit past tags), and `packages/server/package.json` (add `"checkwait-core": "0.0.0"` workspace dep — pin to the real version at release).

**Interfaces (Consumes):** checkwait-core Tasks 1–6. **Produces:** routes `POST /chess/join` → `{ matchId }` or `{ noOpponent: true }` after ~10s; `GET /chess/match/:id/ws` (WebSocket).

Behavior (mirror the patterns in the existing lobby.ts/match.ts — READ THEM FIRST):
- ChessLobbyDO: in-memory queue of one waiting joiner. Second joiner within 10s → both get the same matchId (id = DO-generated hex, same scheme as fragwait). Waiter past 10s → `{ noOpponent: true }` (long-poll or immediate check — follow whichever pattern lobby.ts uses for its timing).
- ChessMatchDO: first WS message must be join (violation → close 1002 'expected join'; third connection → 1013 'full'). First joiner = white. On both joined → `welcome` to each with color/opponent/FEN/clocks; clock starts for white at that moment (store `lastMoveAt`). On `move`: reject illegal (close 1002) — validate via parseMove + applyMove; tick the mover's clock by real elapsed (this is the server edge — `Date.now()` is allowed in the DO, never in core), apply increment via applyMove, relay `move` with authoritative clocksMs, schedule/replace a DO alarm at the to-move player's flag time; alarm fires → tickClock to zero → `end` flag. `resign`/disconnect → `end` resign. After `end`, close both sockets 1000.
- [ ] **Step 1:** Failing DO tests in the existing server test harness (study how packages/server tests instantiate DOs): pair-two-joiners; 10s no-opponent; illegal move closes 1002; legal exchange relays with increment applied; resign on disconnect; flag alarm (drive the clock with the harness's time controls — if the harness can't fake time, test tickClock-at-alarm logic through an exported pure helper instead and note it in the ledger).
- [ ] **Step 2:** Implement; run server tests + FULL suite; `npm run build` (server build is tsc --noEmit). DO NOT deploy — deploy is a user-gated release step. Ledger + commit `feat(server): chess lobby + match DOs`.

### Task 8: client scaffold + copied plumbing + board render

**Files:** Create `packages/chess-client/{package.json,tsconfig.json,bin/checkwait.js,src/{main.ts,cliArgs.ts,terminal.ts,caps.ts,claude.ts,share.ts},src/input/{parser.ts,quit.ts},src/board-render.ts}`, `test/{board-render.test.ts,cliArgs.test.ts,share.test.ts}`.

Copy from packages/client with `// copied from packages/client/src/<file> (fragwait) — <date>` headers: parser.ts (verbatim), quit.ts (verbatim), caps.ts (verbatim), claude.ts (verbatim), terminal.ts (drop the OSC 22 crosshair lines — chess wants the normal pointer; keep alt screen, kitty push/pop, mouse ladder, focus reporting, restore mirroring), share.ts (rewrite content, keep the box-drawing pattern; chess card line: `won on time · 23 moves · vs async-pointer` style per spec). cliArgs.ts: flags `--offline --difficulty --name --server --mute`, default difficulty 'easy', default server the fragwait workers.dev URL (same host — chess routes live there).

**Interfaces (Produces):**
```ts
// board-render.ts
export interface RenderOpts {
  state: ChessState; selfColor: Color
  selected: number | null; legalTargets: number[]; lastMove: Move | null
  cursor: number | null           // keyboard-cursor square
  colorMode: 'truecolor' | 'basic'
  cols: number; rows: number
}
export function renderBoard(o: RenderOpts): string  // full-frame ANSI string, home-cursor based
```
Board from selfColor's perspective (black sees the board flipped). 6x3 cells when space allows, 4x2 fallback below 60x22. Truecolor: light `#b58863`-style/dark square pairs (pick and pin), Unicode pieces; basic mode: reverse-video checkering + letters (uppercase white). Highlights: selected square, legal targets (dot/tint), last move, check (king square red-ish). HUD lines under the board: clocks `● 2:41  ○ 2:55` (to-move marked), last 8 SAN moves, opponent handle, status line placeholder for the Claude text.

- [ ] **Step 1:** Failing tests: render string contains both clock strings and a known piece glyph for the start position; flipped orientation for black (a1 bottom-left for white — assert relative row order of two known glyphs); selected/legal-target squares emit their highlight SGR (pin the exact escape you choose); 4x2 fallback kicks in at 59 cols (assert total line width). Share card tests mirror fragwait's (result line, install commands, aligned box). cliArgs tests mirror fragwait's incl. default-easy.
- [ ] **Step 2:** Implement; green + full suite. Ledger + commit `feat(checkwait): client scaffold, copied plumbing, board renderer`.

### Task 9: selection/input + offline game loop

**Files:** Create `packages/chess-client/src/{select.ts,game.ts,offline.ts}`, `test/select.test.ts`.

**Interfaces (Produces):**
```ts
// select.ts — pure state machine, no I/O
export interface SelectState { selected: number | null; cursor: number; pendingPromotion: { from: number; to: number } | null }
export type SelectEvent =
  | { kind: 'click'; square: number } | { kind: 'cursor'; dir: 'up'|'down'|'left'|'right' }
  | { kind: 'enter' } | { kind: 'typed'; text: string } | { kind: 'promo'; piece: 'q'|'r'|'b'|'n' }
export function selectStep(s: ChessState, sel: SelectState, e: SelectEvent, selfColor: Color):
  { sel: SelectState; move: Move | null }
```
Rules: click own piece → select + compute legal targets; click legal target → move (or pendingPromotion when the move set contains promotions — promo event resolves it); click elsewhere → clear/reselect; cursor+enter mirrors click; typed text goes through parseMove (accepts SAN/coordinate; only emits when it's the player's turn and the move is legal). Mouse cell → square mapping lives in game.ts (uses the render geometry; export the mapping fn from board-render.ts and test it).

game.ts: the shared loop — TerminalSession enter, parser feed, selectStep, applyMove locally (offline) with tickClock driven by performance.now deltas, bot reply via bestMove on the bot's turn (compute synchronously; budget keeps it snappy), redraw at 10fps + on input, Claude listener banner, QuitConfirm (label online: resign), end → final position + result line → waitForPress equivalent (copy dismiss.ts too) → restore → share card.

- [ ] **Step 1:** Failing select.test.ts: full click-click move; reselect; promotion via picker; typed 'Nf3' when legal / rejected when opponent's turn; cursor+enter path. Pure tests, no terminal.
- [ ] **Step 2:** Implement select.ts (pure) + game.ts/offline.ts (thin I/O shells around it; the repo pattern is testable-core/thin-shell). Green + full suite; `node packages/chess-client/bin/checkwait.js --offline` must start and render (smoke by the USER later — do not run interactively in agent shells; a `--frames 1` style self-test is NOT required, skip).
- [ ] **Step 3:** Ledger + commit `feat(checkwait): input state machine + offline bot game`.

### Task 10: online flow

**Files:** Create `packages/chess-client/src/{net.ts,online.ts}`, `test/net.test.ts`. Modify main.ts (online default, offline fallback), package.json (add `"ws": "8.21.0"` exact pin, matching fragwait).

Behavior: POST /chess/join (fetch, 12s abort) → `{matchId}` → ws connect → join → welcome (my color, opponent, FEN, clocks) → moves flow both ways (server clocks are authoritative — render server clocksMs, tick locally between msgs for display only); `{noOpponent:true}` or any join failure → announce "no opponent online — playing the bot" in the HUD and run the offline game (single code path via game.ts). End msg → result screen. Quit online = send resign then normal exit path.

- [ ] **Step 1:** Failing net.test.ts against a local `ws` server stub (mirror how packages/client tests fake the fragwait server — read `packages/client/test` for the pattern): join/welcome handshake, move relay, end handling, noOpponent fallback signal.
- [ ] **Step 2:** Implement; green + full suite. Ledger + commit `feat(checkwait): online matchmaking + match flow with bot fallback`.

### Task 11: plugin registry + launcher rotation test + README

**Files:** Modify `plugin/games.json` (append checkwait entry with cmd `npx -y checkwait@0.1.0` — the version that Task 12 publishes), `plugin/test/launcher.test.sh` (two-entry rotation: consecutive launches alternate entries and the rotation file advances 0→1→0), `README.md` (chess section: what it is, controls, `npx -y checkwait`), `plugin/.claude-plugin/plugin.json` version bump (minor: 0.2.0 — new game).

- [ ] **Step 1:** Extend launcher.test.sh FIRST (failing: rotation with 2 entries), then edit games.json; run `bash plugin/test/launcher.test.sh` → all PASS.
- [ ] **Step 2:** Full suite green. Ledger + commit `feat(plugin): checkwait joins the /games rotation`.

### Task 12: release (USER-GATED — stop and hand over)

- [ ] Set versions: checkwait-core 0.1.0, checkwait 0.1.0 (dep pin `"checkwait-core": "0.1.0"`); server package dep pin to 0.1.0. Full suite + build green. Commit `release: checkwait 0.1.0`.
- [ ] USER runs in their terminal (passkey): `npm publish -w checkwait-core` then `npm publish -w checkwait`. Verify `npm view checkwait@0.1.0 version dependencies`.
- [ ] USER says the deploy words → deploy the worker (Node 22 PATH + `env -u CLOUDFLARE_API_TOKEN npx wrangler deploy` from packages/server — includes the DO migration). Health-check `/` and smoke `POST /chess/join` → 10s → noOpponent.
- [ ] USER feel-gates offline chess in iTerm2 (`npx -y checkwait@0.1.0 --offline`) and one online game (two terminals). Iterate on feel verdicts as with fragwait.
- [ ] Tag `checkwait-v0.1.0`, push main + tag. Update the community-marketplace listing later if it's already approved (new game in the description).

## Self-review notes

- Spec coverage: every spec section maps to a task (product→11/12, core→1-6, server→7, client→8-10, plugin→11, testing woven through, out-of-scope respected — no draw offers/adjourn/spectators anywhere above).
- Perft counts and fixture FENs are standard published values; Task 2 Step 2 includes the divide-debug technique for mismatches. The one construction the implementer must verify locally is the Nbd2 disambiguation FEN in Task 4 (flagged inline).
- Type consistency: Move/ChessState/Result/parseMove/toSAN/bestMove signatures are defined once (Tasks 1/2/4/5) and consumed by name in 6-10.
