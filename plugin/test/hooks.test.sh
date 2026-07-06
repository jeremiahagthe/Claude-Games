#!/usr/bin/env bash
# Fixture test for busy.sh + notify.sh. Run from repo root: bash plugin/test/hooks.test.sh
#
# Note: this test invokes busy.sh/notify.sh directly as plain shell scripts, so it
# cannot exercise Claude Code's async hook dispatch (where "async": true hooks run
# fire-and-forget and have their JSON stdout DISCARDED). That's exactly why
# plugin/hooks/hooks.json keeps the notify.sh entries synchronous (no "async": true):
# their stdout carries the terminalSequence OSC-9 desktop-notification payload, which
# would never reach the terminal if dispatched async. busy.sh emits nothing that needs
# applying, so it stays async there.
set -euo pipefail
export HOME=$(mktemp -d)
DIR="$HOME/.fragwait"
FIXTURE='{"session_id":"testsession1","cwd":"/tmp","hook_event_name":"UserPromptSubmit"}'

echo "$FIXTURE" | bash plugin/hooks/busy.sh
[ -f "$DIR/busy-testsession1" ] || { echo "FAIL: busy file not created"; exit 1; }

# fake game client
node -e '
const http = require("http");
const fs = require("fs");
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c).on("end", () => {
    fs.writeFileSync(process.env.HOME + "/received.json", b);
    res.end("ok");
    srv.close();
  });
});
srv.listen(0, "127.0.0.1", () => {
  fs.mkdirSync(process.env.HOME + "/.fragwait", { recursive: true });
  fs.writeFileSync(process.env.HOME + "/.fragwait/client.json", JSON.stringify({ port: srv.address().port, pid: 1 }));
  console.log("ready");
});
setTimeout(() => process.exit(0), 5000);
' &
NODE_PID=$!
sleep 1

OUT=$(echo "$FIXTURE" | bash plugin/hooks/notify.sh done)
sleep 0.5
[ ! -f "$DIR/busy-testsession1" ] || { echo "FAIL: busy file not removed"; exit 1; }
grep -q '"event":"done"' "$HOME/received.json" || { echo "FAIL: client not notified"; exit 1; }
echo "$OUT" | grep -q 'terminalSequence' || { echo "FAIL: no terminalSequence emitted"; exit 1; }
kill $NODE_PID 2>/dev/null || true
echo "PASS: hooks behave"
