#!/usr/bin/env bash
# One-time setup for a fresh clone. Safe to re-run.
#
# Three things here are not obvious and are the reason this is a script rather than a paragraph in the README:
#
#   1. Node 22 is a HARD FLOOR. `better-sqlite3` ships a native binary built per ABI, and on Node 20 it does
#      not throw — it SEGFAULTS the process (exit 139). A version check up front is cheaper than that.
#   2. Native modules must be rebuilt after any Node switch (`pnpm rebuild -r`), or the suite fails ~45 tests
#      with NODE_MODULE_VERSION mismatches.
#   3. `packages/contracts-scrypt` is deliberately OUTSIDE the pnpm workspace and is npm-managed, because
#      sCrypt's ts-patch transpiler needs a flat node_modules. Its compiled output is gitignored, so a fresh
#      clone has no engine until it is built here.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Checking Node"
command -v node >/dev/null || die "Node is not installed. Install Node 22 (nvm: \`nvm install\`) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node $(node -v) is too old — this needs Node 22+.
     better-sqlite3's native binary segfaults on Node 20 rather than failing cleanly.
     With nvm:  nvm install && nvm use     (this repo pins $(cat .nvmrc) in .nvmrc)"
fi
echo "  node $(node -v)"

step "Checking pnpm"
if ! command -v pnpm >/dev/null; then
  die "pnpm is not installed. Install it with:  npm install -g pnpm"
fi
echo "  pnpm $(pnpm -v)"

step "Installing workspace dependencies"
pnpm install

step "Rebuilding native modules for this Node ABI"
pnpm rebuild -r

# The sCrypt contract package: its own npm install, its own compile, and its own tsc. The daemon imports the
# compiled engine from dist/, and the compiled contract artifacts are what build the actual transactions.
step "Building the on-chain contract package (npm, outside the workspace — see pnpm-workspace.yaml)"
(
  cd packages/contracts-scrypt
  npm install --no-audit --no-fund
  npm run compile
  npm run build
)

# Git does not clone hooks, so every checkout has to opt in. core.hooksPath points at a directory that IS
# committed, so the gate travels with the repository instead of living on one machine.
step "Installing the pre-push gate"
git rev-parse --git-dir >/dev/null 2>&1 && git config core.hooksPath .githooks && echo "  runs typecheck + tests before a push (override: git push --no-verify)"

step "Verifying"
pnpm -w typecheck
pnpm vitest run --silent >/dev/null && echo "  test suite passes"

cat <<'DONE'

✅ Ready.

  pnpm dev      start the daemon and the web app together, then open http://localhost:5273
  pnpm demo     with `pnpm dev` already running, fill the database with example markets

Nothing above touches a real network. The daemon defaults to PM_NETWORK=local: every transaction is
built and verified against Bitcoin Script exactly as it would be on mainnet, and simply never broadcast.
It costs nothing and needs no keys.
DONE
