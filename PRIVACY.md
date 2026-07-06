# Privacy Policy — Claude-Games / fragwait

_Last updated: 2026-07-06_

## What this covers

The `games` Claude Code plugin and the `fragwait` terminal game (npm packages
`fragwait` and `fragwait-core`), plus the multiplayer match server at
`fragwait-server.agthe7.workers.dev`.

## What we collect

**Nothing that identifies you.**

- **No accounts.** There is no sign-up, login, email, or profile.
- **Random handles.** Online players appear under a randomly generated
  gamertag (e.g. `orphaned-stacktrace`) derived from a random seed per match.
  It is not linked to you.
- **Gameplay traffic.** During an online match, your inputs (movement, aim,
  fire) are sent to the match server over WebSocket so the game can be
  simulated. This data is held in memory for the duration of the match and is
  not stored afterwards.
- **Standard infrastructure logs.** The server runs on Cloudflare Workers;
  Cloudflare provides aggregate request analytics (request counts, coarse
  geography) as with any website. We do not store per-player logs.

## What stays on your machine

- Game rotation state (`~/.fragwait/rotation.json`).
- Claude session status shown in the game HUD is read locally from Claude
  Code hooks on your machine; it is never sent to the game server.

## Offline mode

`fragwait --offline` makes no network connections at all.

## Third parties

No analytics SDKs, no trackers, no ads, no data sale. The only network
endpoint is the match server above (plus npm when installing the package).

## Contact

Questions: open an issue at
https://github.com/jeremiahagthe/Claude-Games/issues or email
agthe7@gmail.com.
