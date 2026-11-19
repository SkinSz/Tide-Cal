#!/usr/bin/env bash
# Start the Tide dev environment from the current source, never from stale
# build artifacts.
#
# Why: the dev app runs src-tauri/target/debug/app, which loads its backend
# from a copy (src-tauri/target/debug/dist/sidecar.mjs) made at build time.
# Starting that binary directly (for example from a desktop launcher) runs
# whatever was built last, which can be days older than the checked-out code.
# This script rebuilds the backend bundle, copies it, and lets `tauri dev`
# rebuild the Rust binary and its resource copy before starting the app.
#
# Usage: scripts/dev.sh        (or: npm run dev)
set -euo pipefail
cd "$(dirname "$0")/.."

log() { echo "[tide-dev] $*"; }

log "source: $(git rev-parse --short HEAD 2>/dev/null || echo unknown) ($(git status --porcelain 2>/dev/null | grep -vc '^??' || true) modified tracked files)"

# 1. Another Tide instance holds the sync port: starting a second one fails.
if ss -ltn 2>/dev/null | grep -q ':47471 '; then
  log "port 47471 is in use (another Tide instance is running):"
  ss -ltnp 2>/dev/null | grep ':47471 ' || true
  log "close that instance first, then run this again."
  exit 1
fi

# 2. Backend bundle from the current source.
log "building the backend bundle"
npm run --silent sidecar:build
cp dist/sidecar.mjs src-tauri/resources/sidecar.mjs
cmp -s dist/sidecar.mjs src-tauri/resources/sidecar.mjs
log "backend bundle: $(md5sum src-tauri/resources/sidecar.mjs | cut -c1-12)"

# 3. UI dev server on :5173 (reuse it only if it really serves Tide).
VITE_PID=""
cleanup() { [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null || true; }
trap cleanup EXIT
if curl -s --max-time 2 http://localhost:5173/ | grep -q '<title>Tide</title>'; then
  log "UI dev server already running on :5173"
else
  if ss -ltn 2>/dev/null | grep -q ':5173 '; then
    log "port 5173 is in use by something that is not the Tide UI; stop it first."
    exit 1
  fi
  log "starting the UI dev server"
  npm run --silent ui:dev &
  VITE_PID=$!
  for _ in $(seq 1 60); do
    curl -s --max-time 1 http://localhost:5173/ | grep -q '<title>Tide</title>' && break
    sleep 0.5
  done
  curl -s --max-time 2 http://localhost:5173/ | grep -q '<title>Tide</title>' || { log "UI dev server did not come up"; exit 1; }
fi

# 4. tauri dev rebuilds the Rust binary and copies the resources (including
#    the backend bundle above) into target/debug before starting the app.
log "starting tauri dev"
npx tauri dev
