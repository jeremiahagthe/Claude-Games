---
name: games
description: Launch a terminal game from the games arcade on a separate terminal surface while Claude works — each play rotates to the next game. User-invoked only.
disable-model-invocation: true
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/games-launch"`

The launcher output above says which game was picked and where it opened
(tmux split, new terminal window, or manual instructions). Relay that game
and location to the user in ONE short sentence and remind them: the game
shows a banner the moment this session finishes, and quitting mid-round
never loses banked frags. Do not run any other tools; do not launch the
game again.
