#!/usr/bin/env bash
# Fixture tests for plugin/bin/games-launch: rotation registry + terminal-surface
# detection. Run from repo root: bash plugin/test/launcher.test.sh
#
# NEVER runs the real game and NEVER opens a real terminal window/split: tmux,
# osascript, open, and uname are all replaced with fake binaries (PATH shims in
# a temp dir) that just record their argv/stdin to files so we can assert on
# them. HOME is also faked per case so rotation state never touches the real
# ~/.fragwait directory.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="$REPO_ROOT/plugin/bin/games-launch"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1"; exit 1; }

# --- shim binaries -----------------------------------------------------
SHIMS="$WORK/shims"
mkdir -p "$SHIMS"

cat > "$SHIMS/tmux" <<'EOF'
#!/usr/bin/env bash
{
  echo "ARGC:$#"
  for a in "$@"; do printf 'ARG:%s\n' "$a"; done
} >> "${TMUX_RECORD_FILE:?TMUX_RECORD_FILE not set}"
exit "${TMUX_EXIT:-0}"
EOF

cat > "$SHIMS/osascript" <<'EOF'
#!/usr/bin/env bash
{
  for a in "$@"; do printf 'ARG:%s\n' "$a"; done
  echo '---STDIN---'
  cat
} >> "${OSASCRIPT_RECORD_FILE:?OSASCRIPT_RECORD_FILE not set}"
for a in "$@"; do
  case "$a" in
    *"id of application"*) exit "${OSASCRIPT_ID_EXIT:-1}" ;;
  esac
done
exit "${OSASCRIPT_EXIT:-0}"
EOF

cat > "$SHIMS/open" <<'EOF'
#!/usr/bin/env bash
{
  for a in "$@"; do printf 'ARG:%s\n' "$a"; done
} >> "${OPEN_RECORD_FILE:?OPEN_RECORD_FILE not set}"
exit 0
EOF

cat > "$SHIMS/uname" <<'EOF'
#!/usr/bin/env bash
echo "${FAKE_UNAME:-Darwin}"
EOF

chmod +x "$SHIMS"/tmux "$SHIMS"/osascript "$SHIMS"/open "$SHIMS"/uname

# ------------------------------------------------------------------------
# Test 1: rotation advance + wraparound with a fake 3-game registry.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cat > "$T_ROOT/games.json" <<'JSON'
{"games":[
  {"id":"alpha","title":"Alpha Game","cmd":"echo alpha"},
  {"id":"bravo","title":"Bravo Game","cmd":"echo bravo"},
  {"id":"charlie","title":"Charlie Game","cmd":"echo charlie"}
]}
JSON

RECORD="$WORK/tmux_rotation.txt"
: > "$RECORD"
declare -a PICKS=()
for i in 1 2 3 4; do
  OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
    PATH="$SHIMS:$PATH" bash "$LAUNCHER")
  PICKS+=("$OUT")
done

echo "${PICKS[0]}" | grep -q "Alpha Game"   || fail "rotation pick 1 expected alpha, got: ${PICKS[0]}"
echo "${PICKS[1]}" | grep -q "Bravo Game"   || fail "rotation pick 2 expected bravo, got: ${PICKS[1]}"
echo "${PICKS[2]}" | grep -q "Charlie Game" || fail "rotation pick 3 expected charlie, got: ${PICKS[2]}"
echo "${PICKS[3]}" | grep -q "Alpha Game"   || fail "rotation pick 4 expected wraparound to alpha, got: ${PICKS[3]}"

STATE=$(cat "$T_HOME/.fragwait/rotation.json")
# next is stored as (picked_index + 1), not a raw call counter, so after the
# 4th call wraps back to index 0 the stored next is 1 again (ready to pick
# index 1 next time) -- the rotation keeps cycling forever without the
# state file's integer growing unboundedly.
echo "$STATE" | grep -q '"next":1' || fail "rotation state after 4 picks unexpected: $STATE"
echo "PASS: rotation advances and wraps around a 3-game registry"

# ------------------------------------------------------------------------
# Test 2: corrupt state file falls back to index 0 (and recovers cleanly).
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cat > "$T_ROOT/games.json" <<'JSON'
{"games":[{"id":"alpha","title":"Alpha Game","cmd":"echo alpha"},{"id":"bravo","title":"Bravo Game","cmd":"echo bravo"}]}
JSON
mkdir -p "$T_HOME/.fragwait"
echo 'not valid json{{{' > "$T_HOME/.fragwait/rotation.json"

RECORD="$WORK/tmux_corrupt.txt"
: > "$RECORD"
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")

echo "$OUT" | grep -q "Alpha Game" || fail "corrupt rotation state did not fall back to index 0: $OUT"
grep -q '"next":1' "$T_HOME/.fragwait/rotation.json" || fail "corrupt-state recovery did not write next:1"
echo "PASS: corrupt rotation state falls back to index 0"

# ------------------------------------------------------------------------
# Test 3: TMUX branch calls tmux split-window with the picked cmd.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cp "$REPO_ROOT/plugin/games.json" "$T_ROOT/games.json"

RECORD="$WORK/tmux_basic.txt"
: > "$RECORD"
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")

grep -q "ARG:split-window" "$RECORD" || fail "tmux shim did not see split-window"
grep -q "ARG:-h" "$RECORD" || fail "tmux shim did not see -h"
grep -qF "ARG:npx -y fragwait@0.1.4" "$RECORD" || fail "tmux shim did not receive the registry cmd"
echo "$OUT" | grep -q "tmux split" || fail "launcher did not report a tmux split: $OUT"
echo "PASS: TMUX branch splits with the picked cmd"

# ------------------------------------------------------------------------
# Test 4: FRAGWAIT_CMD overrides the registry cmd (fragwait entry only).
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cp "$REPO_ROOT/plugin/games.json" "$T_ROOT/games.json"

RECORD="$WORK/tmux_override.txt"
: > "$RECORD"
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  FRAGWAIT_CMD="node /local/build/fragwait.js --offline" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")

grep -qF "ARG:node /local/build/fragwait.js --offline" "$RECORD" || fail "FRAGWAIT_CMD override was not used: $(cat "$RECORD")"
grep -q "npx -y fragwait" "$RECORD" && fail "registry cmd leaked through despite FRAGWAIT_CMD override"
echo "$OUT" | grep -q "fragwait" || fail "override case did not report fragwait: $OUT"
echo "PASS: FRAGWAIT_CMD overrides the registry cmd"

# ------------------------------------------------------------------------
# Test 5: macOS with iTerm2 "installed" -> AppleScript with correctly
# escaped cmd (spaces + an embedded double quote).
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
T_APPS=$(mktemp -d)
mkdir -p "$T_APPS/iTerm.app"
cp "$REPO_ROOT/plugin/games.json" "$T_ROOT/games.json"

RECORD="$WORK/osascript_iterm.txt"
: > "$RECORD"
RAW_CMD='node offline.js --say "hi there" --path C:\game'
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" GAMES_APPS_DIR="$T_APPS" \
  FAKE_UNAME=Darwin FRAGWAIT_CMD="$RAW_CMD" OSASCRIPT_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" env -u TMUX bash "$LAUNCHER")

echo "$OUT" | grep -q "iTerm2" || fail "did not choose the iTerm2 branch: $OUT"
grep -q 'tell application "iTerm"' "$RECORD" || fail "AppleScript missing iTerm tell block"
EXPECTED='write text "node offline.js --say \"hi there\" --path C:\\game"'
grep -qF -- "$EXPECTED" "$RECORD" || fail "escaped cmd not found correctly in AppleScript input: $(cat "$RECORD")"
echo "PASS: iTerm2 branch escapes the cmd correctly"

# ------------------------------------------------------------------------
# Test 6: Terminal.app fallback (no iTerm2/Ghostty/kitty) emits the iTerm2 tip.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
T_APPS=$(mktemp -d)   # empty: nothing "installed"
cp "$REPO_ROOT/plugin/games.json" "$T_ROOT/games.json"

RECORD="$WORK/osascript_fallback.txt"
: > "$RECORD"
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" GAMES_APPS_DIR="$T_APPS" \
  FAKE_UNAME=Darwin OSASCRIPT_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" env -u TMUX bash "$LAUNCHER")

echo "$OUT" | grep -q "new Terminal window" || fail "did not fall back to Terminal.app: $OUT"
echo "$OUT" | grep -q "tip: install iTerm2" || fail "missing the iTerm2 install tip line: $OUT"
grep -q 'tell application "Terminal"' "$RECORD" || fail "AppleScript missing Terminal tell block"
echo "PASS: Terminal.app fallback emits the iTerm2 tip line"

# ------------------------------------------------------------------------
# Test 7: rotation state does NOT get burned by a failed launch attempt.
# tmux is present (TMUX set) but the shim is made to fail (exit 1), and
# uname is faked to something the case statement doesn't match, so no
# Darwin/Linux/Windows branch fires either -- the run necessarily falls all
# the way through to the manual-instructions fallback. That fallback still
# counts as a "surface chosen" (the user got a runnable command), so the
# rotation slot must advance exactly once, not zero times (old bug: state
# was burned by the failed tmux attempt alone) and not twice (once for the
# failed tmux attempt, once for the fallback).
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cat > "$T_ROOT/games.json" <<'JSON'
{"games":[
  {"id":"alpha","title":"Alpha Game","cmd":"echo alpha"},
  {"id":"bravo","title":"Bravo Game","cmd":"echo bravo"},
  {"id":"charlie","title":"Charlie Game","cmd":"echo charlie"}
]}
JSON

RECORD="$WORK/tmux_fail_fallthrough.txt"
: > "$RECORD"
OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  TMUX_EXIT=1 FAKE_UNAME="PlanNine" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")

grep -q "ARG:split-window" "$RECORD" || fail "tmux shim (rigged to fail) was never invoked: $(cat "$RECORD")"
echo "$OUT" | grep -q "could not open a terminal automatically" || fail "expected fall-through to manual fallback, got: $OUT"
STATE=$(cat "$T_HOME/.fragwait/rotation.json")
echo "$STATE" | grep -q '"next":1' || fail "rotation state should have advanced by exactly 1 despite failed tmux attempt: $STATE"
echo "PASS: failed tmux launch falls through and rotation still advances exactly +1 (no double-advance, no burn)"

# ------------------------------------------------------------------------
# Test 8: genuinely no-advance path -- a picked registry entry with no cmd
# exits before any launch surface is even attempted, so rotation.json must
# be left completely untouched (not just "advanced by 0" -- literally
# unwritten). This is the one pre-launch guard that can't reach a launch
# surface at all, unlike every post-pick launch path, which all eventually
# terminate in the always-succeeding manual-instructions fallback.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cat > "$T_ROOT/games.json" <<'JSON'
{"games":[
  {"id":"alpha","title":"Alpha Game"},
  {"id":"bravo","title":"Bravo Game","cmd":"echo bravo"}
]}
JSON
mkdir -p "$T_HOME/.fragwait"
echo '{"next":0}' > "$T_HOME/.fragwait/rotation.json"

OUT=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$WORK/tmux_nocmd.txt" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")

echo "$OUT" | grep -q "nothing to launch" || fail "expected the no-cmd guard message, got: $OUT"
STATE=$(cat "$T_HOME/.fragwait/rotation.json")
[ "$STATE" = '{"next":0}' ] || fail "rotation state must be untouched when the picked entry has no cmd, got: $STATE"
echo "PASS: registry entry with no cmd leaves rotation state completely untouched"

# ------------------------------------------------------------------------
# Test 9: real three-entry registry (fragwait + checkwait + boomwait) cycles
# on consecutive launches. Stored "next" is (picked_index + 1), not modded to
# the registry length, so it climbs 1 -> 2 -> 3 -> 1 (idx wraps at read time
# via next % games.length) rather than 0 -> 1 -> 2 -> 0 -- see the
# wraparound comment on the synthetic 3-game rotation test above for why
# this is intentional.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cp "$REPO_ROOT/plugin/games.json" "$T_ROOT/games.json"

RECORD="$WORK/tmux_three_entry.txt"
: > "$RECORD"
OUT1=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT1" | grep -q "fragwait" || fail "three-entry rotation pick 1 expected fragwait, got: $OUT1"
grep -q '"next":1' "$T_HOME/.fragwait/rotation.json" || fail "three-entry rotation state after pick 1 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT2=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT2" | grep -q "checkwait" || fail "three-entry rotation pick 2 expected checkwait, got: $OUT2"
grep -q '"next":2' "$T_HOME/.fragwait/rotation.json" || fail "three-entry rotation state after pick 2 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT3=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT3" | grep -q "boomwait" || fail "three-entry rotation pick 3 expected boomwait, got: $OUT3"
grep -q '"next":3' "$T_HOME/.fragwait/rotation.json" || fail "three-entry rotation state after pick 3 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT4=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT4" | grep -q "fragwait" || fail "three-entry rotation pick 4 expected fragwait again, got: $OUT4"
grep -q '"next":1' "$T_HOME/.fragwait/rotation.json" || fail "three-entry rotation state after pick 4 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"
echo "PASS: real fragwait/checkwait/boomwait registry cycles on consecutive launches"

# ------------------------------------------------------------------------
# Test 10: four-entry registry (fragwait + checkwait + boomwait + snakewait,
# the shape games.json will have once snakewait ships in Task 12) cycles
# 1 -> 2 -> 3 -> 4 -> 1 on consecutive launches, and the snakewait pick's
# cmd (npx -y snakewait@X.Y.Z) passes through to the tmux shim untouched.
# games.json itself is NOT touched by this task -- this is a synthetic
# fixture standing in for the post-release registry.
# ------------------------------------------------------------------------
T_HOME=$(mktemp -d)
T_ROOT=$(mktemp -d)
cat > "$T_ROOT/games.json" <<'JSON'
{"games":[
  {"id":"fragwait","title":"fragwait — terminal FPS deathmatch","cmd":"npx -y fragwait@0.1.4"},
  {"id":"checkwait","title":"checkwait — terminal blitz chess","cmd":"npx -y checkwait@0.1.7"},
  {"id":"boomwait","title":"boomwait — terminal bomber","cmd":"npx -y boomwait@0.1.2"},
  {"id":"snakewait","title":"snakewait — terminal snake battle","cmd":"npx -y snakewait@0.1.0"}
]}
JSON

RECORD="$WORK/tmux_four_entry.txt"
: > "$RECORD"
OUT1=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT1" | grep -q "fragwait" || fail "four-entry rotation pick 1 expected fragwait, got: $OUT1"
grep -q '"next":1' "$T_HOME/.fragwait/rotation.json" || fail "four-entry rotation state after pick 1 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT2=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT2" | grep -q "checkwait" || fail "four-entry rotation pick 2 expected checkwait, got: $OUT2"
grep -q '"next":2' "$T_HOME/.fragwait/rotation.json" || fail "four-entry rotation state after pick 2 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT3=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT3" | grep -q "boomwait" || fail "four-entry rotation pick 3 expected boomwait, got: $OUT3"
grep -q '"next":3' "$T_HOME/.fragwait/rotation.json" || fail "four-entry rotation state after pick 3 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"

OUT4=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT4" | grep -q "snakewait" || fail "four-entry rotation pick 4 expected snakewait, got: $OUT4"
grep -q '"next":4' "$T_HOME/.fragwait/rotation.json" || fail "four-entry rotation state after pick 4 unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"
grep -qF "ARG:npx -y snakewait@0.1.0" "$RECORD" || fail "tmux shim did not receive the snakewait registry cmd: $(cat "$RECORD")"

OUT5=$(HOME="$T_HOME" CLAUDE_PLUGIN_ROOT="$T_ROOT" TMUX="fake" TMUX_RECORD_FILE="$RECORD" \
  PATH="$SHIMS:$PATH" bash "$LAUNCHER")
echo "$OUT5" | grep -q "fragwait" || fail "four-entry rotation pick 5 expected wraparound to fragwait, got: $OUT5"
grep -q '"next":1' "$T_HOME/.fragwait/rotation.json" || fail "four-entry rotation state after pick 5 (wraparound) unexpected: $(cat "$T_HOME/.fragwait/rotation.json")"
echo "PASS: synthetic fragwait/checkwait/boomwait/snakewait four-game registry cycles 1->2->3->4->1 with snakewait cmd passthrough"

echo "PASS: games-launch rotation + terminal-surface detection all behave"
