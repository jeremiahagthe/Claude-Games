#!/usr/bin/env bash
# Stop / Notification: clear busy marker, ping the game client, desktop-notify.
set -u
EVENT="${1:-done}"
DIR="$HOME/.fragwait"
STDIN=$(cat)
SESSION_ID=$(printf '%s' "$STDIN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).session_id||"unknown").replace(/[^a-zA-Z0-9-]/g,""))}catch{process.stdout.write("unknown")}})' 2>/dev/null || echo unknown)
rm -f "$DIR/busy-${SESSION_ID:-unknown}" 2>/dev/null

PORT=$(node -e 'try{const p=require(process.env.HOME+"/.fragwait/client.json").port;if(Number.isInteger(p))process.stdout.write(String(p))}catch{}' 2>/dev/null)
if [ -n "${PORT:-}" ]; then
  curl -s -m 1 -X POST "http://127.0.0.1:${PORT}/event" \
    -H 'content-type: application/json' \
    -d "{\"event\":\"${EVENT}\"}" >/dev/null 2>&1 || true
fi

if [ "$EVENT" = "done" ]; then MSG="Claude Code: task finished - return to terminal"; else MSG="Claude Code needs your input"; fi
printf '{"terminalSequence":"\\u001b]0;fragwait: %s\\u0007\\u001b]9;%s\\u0007"}' "$MSG" "$MSG"
exit 0
