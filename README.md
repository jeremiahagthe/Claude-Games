# games

Terminal games for Claude Code wait time. While Claude is working on your
turn, jump into a quick match against other waiting devs — no context
switch, no browser tab, just your terminal. `/games` rotates through a
growing arcade; the moment Claude finishes, a banner lands in-game so you
never miss the handoff.

**Game 1: fragwait** — a terminal FPS deathmatch. CS-style mouse look in
iTerm2, Ghostty, and kitty (with a cursor-aim fallback everywhere else),
bots backfill empty slots so there's always a fight, and frags bank
per-kill so getting interrupted never costs you progress.

```
 node_modules  ⏱ 2:47  ⚙ Claude working 1m32s
 HP ██████████ 100  FRAGS 3  RAIL ✦
 rebased-rustacean ⌫ segfaulting-sensei
┌──────────────────────────────────────────────┐
│                                                │
│        ▓▓▓▓                    ██             │
│        ▓▓▓▓         +          ██             │
│                                                │
└──────────────────────────────────────────────┘
```

## The arcade

- **fragwait** (game 1) — terminal FPS deathmatch, ships today.
- **checkwait** (game 2) — terminal blitz chess, ships today.
- **boomwait** (game 3) — terminal bomber, ships today.
- More games rotate in over time as the plugin updates — `/games` always
  picks the next one in rotation, so repeat plays surface new games
  automatically.

## Install (Claude Code plugin)

```
/plugin marketplace add jeremiahagthe/Claude-Games
/plugin install games@games
```

Then run `/games` any time you're waiting on a turn. The launcher opens
the picked game in a tmux split (if you're in tmux), a new terminal window
(iTerm2 / Ghostty / kitty / Terminal.app / Windows Terminal), or prints a
manual command to run yourself if none of those are available.

## Standalone play

No plugin needed — fragwait also runs directly:

```
npx fragwait
```

Add `--offline` to skip the multiplayer server and play a local match
against bots only, `--difficulty easy|normal|hard` to tune the bots,
`--name <handle>` to set your display name, `--mute` to silence sound
effects, and `fragwait doctor` to print a terminal-capability report
(color mode, mouse protocol tier, key-repeat timings). Point at a
self-hosted server with `--server <url>` or the `FRAGWAIT_SERVER` env var.

## fragwait controls

| Input | Action |
|---|---|
| Move mouse | Aim (mouse-look, pointer-locked in iTerm2/Ghostty/kitty; cursor-aim elsewhere) |
| `W` / hold right mouse button | Walk forward |
| `S` | Move backward |
| `A` / `D` | Strafe left / right |
| `←` / `→` | Turn left / right |
| Click or `Space` | Fire |
| `M` | Toggle mouse-lock (pointer-lock vs cursor-aim) |
| `Tab` (hold) | Scoreboard |
| `Q` / `Esc` / `Ctrl-C` | Quit |

## checkwait — terminal blitz chess

**Game 2: checkwait** — 3+2 blitz (3 minutes on the clock, +2s per move) you
play while Claude works, the same 3–6 minute session shape as a fragwait
match. Online PvP via matchmaking by default — if no opponent shows up
within ~10s, it falls back to a local bot automatically (announced in
scrollback: "no opponent online — playing the bot"), so there's always a game.

Unicode pieces on a checkered board, with an ASCII/letters fallback on
low-color terminals. Both clocks and a running SAN move list stay in the
HUD alongside the Claude status line and finish banner — same integration
as fragwait, described below.

### Standalone play

```
npx -y checkwait
```

Add `--offline` to skip matchmaking and play a local bot-only match,
`--difficulty easy|normal|hard` to tune the bot (default `easy`), `--name
<handle>` to set your display name, and `--server <url>` to point at a
self-hosted worker (checkwait's matchmaking and fragwait's deathmatch share
the same Cloudflare Worker deployment).

### checkwait controls

| Input | Action |
|---|---|
| Click a piece, then click a destination | Move (legal destinations highlight after the first click) |
| Type a move + `Enter` | Move via coordinate (`e2e4`) or SAN (`Nf3`, `O-O`) |
| Arrow keys, then `Enter` | Move a board cursor and confirm, for mouse-free play |
| `q` / `r` / `b` / `n` (on promotion) | Pick the promotion piece |
| `Q` / `Esc` | Quit (requires a second press to confirm — online, this resigns the game) |

## boomwait — terminal bomber

**Game 3: boomwait** — 4-player last-man-standing bomberman on a 13×11 grid,
the same 3–6 minute session shape as a fragwait or checkwait match. Online
PvP via matchmaking by default — the lobby gathers players for ~10s and bots
always backfill any empty slots, so a match is never short of four players.
Offline play drops you straight into a match against 3 bots instead.

### Standalone play

```
npx -y boomwait
```

Add `--offline` to skip matchmaking and play a local match against 3 bots
only, `--difficulty easy|normal|hard` to tune the bots (default `easy`),
`--name <handle>` to set your display name, and `--server <url>` to point at
a self-hosted worker (boomwait's matchmaking shares the same Cloudflare
Worker deployment as fragwait's deathmatch and checkwait's matchmaking).

### boomwait controls

| Input | Action |
|---|---|
| `W`/`↑`, `A`/`←`, `S`/`↓`, `D`/`→` | Move (latched — a direction holds until you tap the opposite one to stop, or a new direction to turn) |
| `Space` | Drop a bomb |
| `Q` / `Esc` | Quit (requires a second press to confirm) |
| `Ctrl-C` | Quit instantly |

## How the Claude integration works

`/games` is user-invoked only (`disable-model-invocation: true` — Claude
can never launch a game on its own). Once a match is running, three hooks
keep it in sync with your Claude Code session:

- **`UserPromptSubmit`** — touches `~/.fragwait/busy-<session_id>` so the
  in-game HUD can show "Claude working 1m32s".
- **`Stop`** and **`Notification`** (`idle_prompt` / `permission_prompt`
  matchers) — POST a `done`/`attention` event to whichever game client is
  running (read from `~/.fragwait/client.json`) and emit a desktop
  notification, so a banner lands in-game the moment your turn is ready.

**Full transparency — files this plugin writes, and nothing else:**

- `~/.fragwait/client.json` — the running game client's local port, so
  hooks know where to POST.
- `~/.fragwait/busy-*` — one empty marker file per active session, used to
  compute elapsed "Claude working" time.
- `~/.fragwait/rotation.json` — which arcade game `/games` picks next.

No telemetry. No network calls except the game server you connect to
(default: the hosted fragwait server, or your own via `FRAGWAIT_SERVER`).
No files written outside `~/.fragwait/`. Nothing in `~/.claude/settings.json`
is ever touched. MIT licensed.

## Development

```
npm install
npm test           # vitest across core/client/server
npm run build       # tsc build for all workspaces
```

Plugin-side tests (hooks + launcher rotation/terminal-surface detection,
no real terminal windows or games are ever launched):

```
bash plugin/test/hooks.test.sh
bash plugin/test/launcher.test.sh
```

Run the server locally with `npm run dev -w @fragwait/server` (wrangler
dev), or point a client at it with `FRAGWAIT_SERVER=http://localhost:8787`.

## Server self-hosting

The hosted server is a Cloudflare Worker; deploying your own is one
command:

```
npm run deploy -w @fragwait/server   # wrangler deploy
```

Then point clients at it with `FRAGWAIT_SERVER=https://your-worker.workers.dev`
(env var, or the `--server` flag).

## Publishing

`fragwait` and `fragwait-core` are npm workspaces, versioned together
(currently `0.1.4`). `fragwait-core` publishes as an unscoped package —
no npm org is required. Publishing itself (`npm publish`) is a manual,
account-holder decision — this repo only ships dry-run-verified tarballs.

## License

MIT — see [LICENSE](LICENSE).
