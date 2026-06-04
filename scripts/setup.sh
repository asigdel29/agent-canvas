#!/usr/bin/env bash
#
# setup.sh — one command to make a fresh clone runnable.
#
# Installs dependencies, generates ./.env with random secrets (if it does
# not exist), builds every workspace, and runs database migrations when a
# DATABASE_URL is configured. After this, the only thing left to do is
# fill in ./.env and run `npm start`.
#
# Usage:  ./scripts/setup.sh
#
# Author: asigdel29

set -euo pipefail

# Always operate from the repository root, regardless of where the
# script was invoked.
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;35m[setup]\033[0m %s\n' "$1"; }

# 1. Node version gate — the workspaces require Node >= 22.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 22 ]; then
	echo "agent-canvas needs Node >= 22 (found: $(node -v 2>/dev/null || echo 'none'))." >&2
	echo "Install it from https://nodejs.org or via nvm, then re-run ./scripts/setup.sh." >&2
	exit 1
fi

# 2. Dependencies. Prefer the reproducible `npm ci` when a lockfile is
#    present; fall back to `npm install` otherwise.
step "Installing dependencies"
if [ -f package-lock.json ]; then
	npm ci
else
	npm install
fi

# 3. Environment file with generated secrets (idempotent — never clobbers
#    an existing .env).
step "Preparing ./.env"
if [ -f .env ]; then
	echo "  .env already exists — leaving it untouched."
else
	node scripts/setup-env.mjs
fi

# 4. Build all workspaces (orchestrator dist + canvas dist).
step "Building"
npm run build

# 5. Migrate when a database is configured. Read DATABASE_URL from the
#    environment or from ./.env so the check works before `npm start`.
DB_URL="${DATABASE_URL:-}"
if [ -z "${DB_URL}" ] && [ -f .env ]; then
	DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)"
fi
if [ -n "${DB_URL}" ]; then
	step "Running database migrations"
	npm run migrate
else
	step "Skipping migrations"
	echo "  No DATABASE_URL set. The app will run in-memory (state is lost on"
	echo "  restart). Set DATABASE_URL in ./.env and run 'npm run migrate' for"
	echo "  persistence and real multiplayer."
fi

step "Done"
cat <<'EOF'
  Next:
    1. Open ./.env and set DATABASE_URL (and, for AUTH_MODE=github, the
       two GITHUB_OAUTH_* values). AI keys are bring-your-own — each user
       pastes their Claude key in Settings, or set ANTHROPIC_API_KEY for a
       shared fallback.
    2. Start the app:
         npm start          # production: one server on http://localhost:3000
         npm run dev        # development: hot-reloading canvas + orchestrator
EOF
