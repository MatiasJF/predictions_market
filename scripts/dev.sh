#!/usr/bin/env bash
# Run the daemon and the web app together, and stop both together.
#
# `trap` on EXIT matters: without it, Ctrl-C leaves the daemon holding port 8787, the next start dies with
# EADDRINUSE, and — because the old process is still answering — the health check passes and everything looks
# fine while you are talking to a stale build. That has cost this project real time more than once.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PM_PORT:-8787}"
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "✗ Port $PORT is already in use — something else is running (age: $(ps -o etime= -p "$(lsof -ti "tcp:$PORT" | head -1)" | tr -d ' '))." >&2
  echo "  Stop it first, or run with a different port:  PM_PORT=8788 pnpm dev" >&2
  exit 1
fi

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

pnpm --filter @pm/daemon dev & pids+=($!)
pnpm --filter @pm/web dev    & pids+=($!)

cat <<'BANNER'

  daemon  http://127.0.0.1:8787
  app     http://localhost:5273     ← open this one

  Note: the dev server binds IPv6, so http://127.0.0.1:5273 will look dead while localhost works.
  Ctrl-C stops both.

BANNER
wait
