#!/usr/bin/env bash
# Run the daemon and the web app together, and stop both together.
#
# `trap` on EXIT matters: without it, Ctrl-C leaves the daemon holding its port, the next start dies with
# EADDRINUSE, and — because the old process is still answering — the health check passes and everything looks
# fine while you are talking to a stale build. That has cost this project real time more than once.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${PM_PORT:-8787}"
WEB_PORT="${PM_WEB_PORT:-5273}"

# BOTH ports are checked up front. The web server runs with `strictPort`, so a taken port kills it outright
# rather than sliding to the next one — and if only the daemon were checked, that failure would arrive after
# the daemon had already started, looking like the app was broken rather than the port being busy.
check_port() {
  local port="$1" what="$2"
  local pid; pid="$(lsof -ti "tcp:$port" 2>/dev/null | head -1 || true)"
  [ -z "$pid" ] && return 0
  echo "✗ Port $port ($what) is already in use." >&2
  echo "    process $pid, running for $(ps -o etime= -p "$pid" | tr -d ' ')" >&2
  echo "    $(ps -o command= -p "$pid" | cut -c1-70)" >&2
  echo "  Stop it, or pick another port:  PM_PORT=8788 PM_WEB_PORT=5274 pnpm dev" >&2
  return 1
}
failed=0
check_port "$API_PORT" "daemon" || failed=1
check_port "$WEB_PORT" "web app" || failed=1
[ "$failed" -eq 0 ] || exit 1

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

PM_PORT="$API_PORT" pnpm --filter @pm/daemon dev & pids+=($!)
# The app talks to the daemon over HTTP, so it has to be told when the daemon is not on the default port.
PM_WEB_PORT="$WEB_PORT" VITE_PM_API="http://127.0.0.1:$API_PORT" pnpm --filter @pm/web dev & pids+=($!)

cat <<BANNER

  daemon  http://127.0.0.1:$API_PORT
  app     http://localhost:$WEB_PORT     ← open this one

  Note: the dev server binds IPv6, so http://127.0.0.1:$WEB_PORT will look dead while localhost works.
  Ctrl-C stops both.

BANNER
wait
