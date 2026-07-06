#!/usr/bin/env bash
# UserPromptSubmit: mark this session busy so the in-game HUD can show wait time.
set -u
DIR="$HOME/.fragwait"
mkdir -p "$DIR"
SESSION_ID=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).session_id||"unknown").replace(/[^a-zA-Z0-9-]/g,""))}catch{process.stdout.write("unknown")}})' 2>/dev/null || echo unknown)
touch "$DIR/busy-${SESSION_ID:-unknown}"
exit 0
