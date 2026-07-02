# fragwait — a terminal FPS for Claude Code wait time

**Design spec · 2026-07-02 · status: awaiting user review**

Working title: **fragwait** ("frag while you wait" — naming is an open question, see end).

## 1. Concept

While Claude Code grinds on a long task, the user is dead-waiting. fragwait turns that
wait into a ~3 minute multiplayer deathmatch: a retro raycasted FPS (Wolfenstein-style,
rendered entirely in the terminal with half-block "pixels") against other Claude Code
users who are also waiting, with bots backfilling empty slots. The moment Claude
finishes, a banner drops into the game — one keypress returns you to your terminal,
with your score already banked.

Inspiration: kickbacks.ai proved developers want *something* in the Claude Code wait
moment (5.5M views in 24h) — and its HN dissection proved exactly what the developer
audience will not tolerate. fragwait is the anti-kickbacks: a free MIT toy, no ads, no
telemetry, no monetization, built only on sanctioned Claude Code extension points.

## 2. Goals / non-goals

**Goals**
- Playable round within ~10 seconds of launching, always (bots guarantee it).
- Zero-friction: 2-command plugin install; `npx fragwait` works standalone too.
- Interruption-native: quitting mid-round is a first-class, never-punished action.
- Runs in the terminals Claude Code users actually use (VS Code terminal, iTerm2,
  Ghostty, Windows Terminal, Terminal.app) with graceful degradation.
- Entertaining for a developer audience: fast, funny, dev-culture-flavored.
- Trustworthy: MIT, pinned versions, no auto-update, no telemetry, touches nothing
  outside its own directories.

**Non-goals (YAGNI)**
- No accounts, currency, unlocks, ads, or engagement mechanics. It's a toy.
- No voice/text chat (kill feed is the only social surface). Avoids moderation burden.
- No mobile, no controller support.
- v1 has no browser client, no statusline HUD, no SSH mirror (all phased later).

## 3. Decisions made autonomously (user was AFK — each is revisitable)

| # | Decision | Alternative considered |
|---|----------|------------------------|
| D1 | Game surface: **terminal-rendered** ASCII/half-block FPS | Browser WebGL tab (phase 3) |
| D2 | Stack: **TypeScript end-to-end** (Node client, CF Workers server, shared sim core) | Go/Bubble Tea client + Go server; Rust/ratatui |
| D3 | Hosting: **Cloudflare Workers + Durable Objects** | Colyseus on Fly.io (fallback if DO limits bite) |
| D4 | Distribution: **Claude Code plugin via GitHub marketplace** + `npx` standalone | kickbacks-style VSIX (rejected: trust + scope) |
| D5 | Cold start: **bot backfill** with honest "synth" disclosure | Empty-lobby waiting (rejected: kills first impression) |

Why TypeScript everywhere: Claude Code users are guaranteed to have Node; a raycaster
at terminal resolution is microseconds of JS per frame; and one shared `core` package
runs identically as client prediction and server authority — the single biggest
correctness and effort win available. Go/Rust give nicer input/binaries but force
either two implementations of the sim or hosting without scale-to-zero.

## 4. Architecture

```
┌────────────────────────────── user's machine ──────────────────────────────┐
│                                                                             │
│  Claude Code (owns its TTY)                 game surface (separate TTY)     │
│  ├─ plugin: fragwait                        ┌─────────────────────────────┐ │
│  │   ├─ /fragwait:play  ──launcher──────▶   │ fragwait client (Node)      │ │
│  │   ├─ hooks: UserPromptSubmit (async)     │  ├─ raycaster renderer      │ │
│  │   │         Stop / Notification (async)  │  ├─ input (tiered)          │ │
│  │   │              │                       │  ├─ prediction + interp     │ │
│  │   │              │ POST localhost:port   │  └─ localhost listener ◀────┼─┼─┐
│  │   │              └───────────────────────┼──▶ "Claude finished" banner │ │ │
│  │   └─ OSC 9/777 desktop notification      └──────────────┬──────────────┘ │ │
│  └─ ~/.fragwait/client.json (port, pid) ────────────────────────────────────┼─┘
│                                                             │ WebSocket     │
└─────────────────────────────────────────────────────────────┼───────────────┘
                                                              ▼
                                    ┌──────────────────────────────────────┐
                                    │ Cloudflare Workers (anycast edge)    │
                                    │  ├─ Lobby DO (per continent,        │
                                    │  │   hibernating WebSockets)        │
                                    │  └─ Match DO (per match, 20Hz tick, │
                                    │      authoritative sim, bots)       │
                                    └──────────────────────────────────────┘
```

Monorepo layout:

```
fragwait/
  packages/core/      # shared: sim, maps, protocol types, name generator (zero deps)
  packages/client/    # terminal client — published to npm as `fragwait`
  packages/server/    # CF Worker + Lobby DO + Match DO
  plugin/             # Claude Code plugin (plugin.json, hooks, skills, launcher)
  docs/
```

### 4.1 `packages/core` — shared simulation (the load-bearing unit)

- **What it does:** deterministic game rules — 2D grid world, player movement
  (position, velocity, heading), collision vs map grid, weapon fire resolution,
  damage/respawn, scoring. Plus the wire protocol types and 3 built-in maps
  (ASCII text grids, 24×24).
- **Interface:** `simulate(state, inputs[], dtTicks) -> state`; pure functions,
  no I/O, no `Date.now()` (tick counter only).
- **Depends on:** nothing. This is what lets client prediction and server authority
  never disagree, and enables a fully offline bot match when the network is down.

### 4.2 `packages/client` — terminal client

- **Renderer:** column raycaster over the 2D grid → half-block cells (▀ with
  truecolor fg/bg = 2 square pixels per cell), ~160×50 cells typical, 24–30 fps,
  diff-based redraw (only changed cells emitted). Fallback ladder detected at start:
  truecolor → 256-color (Terminal.app) → plain ASCII shading (`░▒▓█`). Sprites
  (players, pickups) are billboarded columns with depth buffer.
- **Input (tiered, per research):**
  - Tier 2 = **default**: decay-timer held-key emulation (a key counts as held for
    N ms after its last press/repeat event — doom-ascii's `-kpsmooth` pattern),
    because stock VS Code terminal has no key-release events.
  - Tier 1 = progressive enhancement: kitty keyboard protocol `REPORT_EVENT_TYPES`
    (real press/release) when the terminal supports it (iTerm2, Ghostty, kitty,
    Alacritty, WezTerm, Windows Terminal ≥1.25 Preview, VS Code ≥1.109 with
    `terminal.integrated.enableKittyKeyboardProtocol` — docs tell users to flip it).
  - Both tiers reduce to the same per-tick intent struct `{move, strafe, turn, fire}`.
  - Controls: WASD move/strafe, ←/→ or J/L turn, Space fire, Tab scoreboard,
    Q/Esc quit. Optional mouse-aim via SGR mouse capture (horizontal only).
  - **Terminal hygiene:** kitty flags popped, cursor restored, alt-screen exited on
    every exit path — normal quit, SIGINT, SIGTERM, uncaught exception (known
    flag-leak bug class in other tools; we treat restore as a hard invariant).
- **Netcode (client half):** predict local movement (apply input immediately,
  reconcile against server snapshots); interpolate remote players 100–150 ms in the
  past; terminal cell quantization hides all sub-cell error. Input sampled at 30 Hz,
  **batched into 10 Hz packets** (Durable Objects bill incoming messages — batching
  keeps small-scale usage inside the free tier).
- **Claude integration (client half):** on start, writes `~/.fragwait/client.json`
  `{port, pid}` and listens on that localhost port. On `{"event":"stop"}` → banner:
  `✔ Claude is done — [Enter] quit & return · [Esc] keep playing`. Score is banked
  per-frag, so quitting costs nothing.
- **Offline mode:** if the server is unreachable, spin up an in-process match vs
  bots using the same `core` sim. Waiting time is still fun with no internet.

### 4.3 `packages/server` — Cloudflare Workers + Durable Objects

- **Lobby DO** (one per continent, auto-placed by CF anycast + `request.cf.continent`):
  hibernating WebSockets, no timers while idle (stays free). Guarantees match start
  ≤10 s: creates a Match DO immediately, fills to minimum 4 combatants with bots.
  Maintains backfill tickets: every bot slot is claimable by a joining human.
- **Match DO** (one per match): authoritative sim at **20 Hz** via `core`, snapshot
  broadcast to clients each tick (~300–400 B JSON), generous server-side hitboxes
  instead of lag-compensation rewind (v1). Bots run inside the tick loop and consume
  the exact same input interface as humans (they double as the load-test harness).
  **Rooms with zero humans terminate** rather than idle (DO CPU-budget eviction trap
  confirmed by research). Match length 3 min; drop-in/drop-out; instant respawn with
  2 s spawn protection.
- **Protocol:** WebSocket, compact JSON at v1 (debuggability > bytes at ~8 kB/s per
  client); msgpack reserved as a later optimization.
- **Cost:** $0 on free tier for roughly the first ~30–300 matches/day depending on
  input batching efficiency; Workers Paid $5/mo covers ~10k matches/month. Budget
  ceiling year one: $10/mo. Fallback if DO constraints bite in practice: Colyseus
  (MIT) on Fly.io, ~$6/mo — second-best, not bad.

### 4.4 `plugin/` — Claude Code plugin

Distributed via `/plugin marketplace add <owner>/fragwait` + `/plugin install
fragwait@<owner>` (later: submit to the community marketplace for 1-command install).

- **`skills/play/SKILL.md`** → `/fragwait:play` with `disable-model-invocation: true`
  (Claude can never spontaneously start a deathmatch). Its `` !`launcher` ``
  preprocessing line runs synchronously — works even while a turn is queued.
- **Launcher** (surface detection, in order):
  1. `$TMUX` set → `tmux split-window -h "npx fragwait"` (best UX: game and Claude
     side by side).
  2. macOS → `osascript` new Terminal.app/iTerm window; Windows → `wt.exe new-tab`;
     Linux → `x-terminal-emulator -e`.
  3. Fallback → print "run `npx fragwait` in another terminal".
- **`hooks/hooks.json`** (all `async: true`, exit instantly, never delay Claude):
  - `UserPromptSubmit` → touch `~/.fragwait/busy-<session_id>` (lets the client show
    "Claude is still working… 2m 14s" in the HUD).
  - `Stop` + `Notification` (matchers `idle_prompt`, `permission_prompt`) → POST
    `{"event":"stop"|"attention"}` to the port in `~/.fragwait/client.json`, emit
    OSC 9/777 desktop notification via `terminalSequence`, retitle Claude's terminal
    window ("✔ DONE — return to Claude"). Note: hooks *cannot* emit OSC 8 clickable
    links (allowlist), hence POST + notification, not links.
  - Hook processes have a 600 s timeout, so nothing long-running lives in a hook —
    anything persistent is spawned detached (`nohup`) and idempotent. v1 needs no
    persistent daemon at all (the game client itself is the listener).
- **Trust posture (the kickbacks lessons, as hard requirements):** MIT from day one;
  no auto-update (plugin versions pinned, updates ship as releases); no telemetry;
  no network calls except the game server the user launches; writes only under
  `~/.fragwait/` and its own plugin dir; never patches Claude Code files or settings.
  The one exception — the optional phase-2 `/fragwait:setup` statusline HUD — edits
  `~/.claude/settings.json` only with explicit consent, chain-wraps any existing
  statusline with a timeout, and keeps a backup.

## 5. Game design ("simple but entertaining")

- **Mode:** free-for-all deathmatch, 2–8 players, 3-minute rounds, most frags wins.
  Scores bank per-frag (leaderboard-friendly + interruption-friendly).
- **Movement:** brisk Wolfenstein feel — smooth-held turning, strafing, no jumping.
  Fights are decided by positioning, not twitch aim (150 ms ping must not decide
  duels — quantized world helps here).
- **Weapons:** blaster (hitscan, 25 dmg, 4-shots-to-kill, cooldown-limited, infinite
  ammo) + **railgun pickup** (100 dmg one-shot, spawns center-map every 30 s) —
  one contested objective creates map flow with minimal design surface.
- **Maps:** 3 hand-authored 24×24 grids with dev-culture names and layouts:
  `node_modules` (a hedge maze), `legacy_monolith` (one big central arena),
  `microservices` (many small rooms, too many corridors).
- **Identity:** stable anonymous handle derived from a machine-id hash through an
  embedded ~60-line adjective+dev-noun generator (`rebased-rustacean`,
  `segfaulting-sensei`) — copied into `core` with a source comment per supply-chain
  policy, not a dependency. `--name` flag to override. Bots draw from the same
  generator, displayed with a dim `·synth` glyph (honest, subtle), tuned to lose
  slightly more than they win.
- **Flavor:** kill feed does the comedy ("rebased-rustacean force-pushed
  dangling-pointer"), death screen shows a mock stack trace, respawn is
  "rehydrating…". The HUD shows Claude's elapsed working time — the game winks at
  why you're here.

## 6. Error handling

| Failure | Behavior |
|---|---|
| Server unreachable / offline | Local bot match via in-process `core` sim; banner explains |
| WebSocket drops mid-match | 5 s reconnect window w/ resume token; then rejoin as new player (score kept locally for session) |
| Terminal lacks truecolor / kitty protocol | Detected at start; degrade per ladder; `fragwait doctor` prints capability report |
| Claude finishes while user in menu/queue | Same banner path — listener is process-wide, not match-scoped |
| Hook fires with no game running | POST fails silently (async hook, exit 0); desktop notification still emitted by Claude Code natively |
| Crash / SIGINT | Terminal state restore is unconditional (single restore routine on all exit paths) |

## 7. Testing

- **core:** property-based tests (movement never clips walls, damage math, sim
  determinism: same inputs ⇒ same state on client and server builds).
- **client input:** unit tests replaying recorded escape-sequence byte streams for
  both tiers; decay-timer behavior under jittery repeat rates.
- **netcode:** integration test with simulated 0/80/200 ms latency and 1% loss —
  assert prediction error stays sub-cell.
- **server:** bot-vs-bot soak matches on a real DO (doubles as load/cost test —
  verifies the free-tier request math empirically before launch).
- **plugin:** hook scripts exercised with fixture JSON on stdin; launcher tested on
  macOS/tmux at minimum (Windows/Linux launcher paths behind CI where possible).
- **Feel gate (milestone 1):** single-player-vs-bots must be *fun in VS Code's
  default terminal* (worst-case input tier) before any netcode work proceeds.

## 8. Phasing

- **Phase 1 (MVP):** `core` + terminal client vs bots offline → CF server + real
  multiplayer → plugin (launch + stop-notify). Ship.
- **Phase 2 (polish):** global leaderboard (per-handle), spectate-while-queued,
  optional statusline lobby HUD (`/fragwait:setup`, consent flow), themed
  `spinnerVerbs` easter egg, community-marketplace submission.
- **Phase 3 (reach):** browser WebGL client (three.js `games_fps` skeleton +
  Q1K3-scope aesthetic + nickyvanurk ws-netcode reference — all MIT) speaking the
  same protocol to the same Match DOs; possible read-only `ssh play.<domain>`
  spectator mirror (charmbracelet/wish, MIT) as a marketing hook.

## 9. Risks

1. **Input feel on the worst tier** (VS Code default, decay-timer) is the existential
   risk — hence the milestone-1 feel gate before netcode investment.
2. **DO free-tier math** may still surprise (critic found the original estimate 10×
   off before batching); bot soak test verifies empirically; $5/mo Paid is the
   accepted mitigation, Colyseus/Fly the architectural escape hatch.
3. **Cold start** (nobody online) is fully absorbed by bots, but bots must be good
   enough to be fun and honest enough not to feel like a scam — the `·synth` glyph
   and slight-loser tuning are deliberate.
4. **Terminal zoo:** the capability ladder + `fragwait doctor` bound the support
   matrix; Terminal.app (256-color, no kitty input) is the explicit floor.
5. **Name/trademark:** avoid "claude" in the product name (unofficial project);
   "fragwait" is a working title.

## 10. Rejected alternatives (summary)

- **Browser-first WebGL FPS:** richer visuals, but pulls users out of the terminal,
  needs a hosted web app on day one, and abandons the terminal-native charm that is
  the whole point. Deferred to phase 3 on shared protocol.
- **Go/Bubble Tea v2 + wish (SSH):** beautiful stack, real key-release support, but
  server-side rendering forbids client prediction (sshtron's own bar: RTT < 40 ms),
  splits the codebase from a TS server, and forces always-on hosting. SSH mirror
  deferred to phase 3 as spectator-only.
- **Forking a terminal DOOM port:** every one is GPL-contaminated (doomgeneric);
  raycaster is written fresh under MIT (it's ~400 LOC; doom-ascii and CommandLineFPS
  serve as technique references only, no code copied).
- **Vercel WebSockets (June 2026 beta):** 300–800 s max connection duration and no
  reconnect-to-instance affinity make in-memory rooms impossible without external
  state; rejected for the game server.

## Open questions for the user

1. **Name:** `fragwait`? Other candidates: `deathmatch.md`, `spinnerfrag`, `afkfps`.
2. **Scope check:** happy with terminal-first (D1) and TypeScript (D2), or do you
   want the browser client promoted to phase 1?
3. **Railgun pickup in v1** or blaster-only for an even smaller MVP?
4. **Hosting account:** Cloudflare account available/acceptable? (Fly.io fallback
   otherwise.)
5. **Public repo from day one** (the trust posture assumes open development)?
