---
name: play
description: Launch a specific game from the arcade by name (e.g. /play blockwait) on a separate terminal surface while Claude works — unlike /games, this never advances the rotation. Run without a name to list the arcade. User-invoked only.
disable-model-invocation: true
argument-hint: "[game]"
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/games-launch" --pick $ARGUMENTS`

The launcher output above either says which game was picked and where it
opened (tmux split, new terminal window, or manual instructions) or lists the
arcade's game names (when no name / an unknown name was given). Relay that to
the user in ONE short sentence and remind them: the game shows a banner the
moment this session finishes, and quitting mid-round never loses banked
progress. Do not run any other tools; do not launch the game again.
