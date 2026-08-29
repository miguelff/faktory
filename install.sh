#!/usr/bin/env bash
# Faktory bootstrap installer for macOS.
# Installs everything a fresh machine needs: Homebrew, node, pnpm, herdr, pi
# (plus optional claude/codex), then Faktory's own dependencies.
set -euo pipefail

say()  { printf '\033[1m⚙ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname)" = "Darwin" ] || { echo "This installer targets macOS." >&2; exit 1; }

if ! have brew; then
  say "Installing Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi

have node || { say "Installing node…"; brew install node; }
node -e 'process.exit(process.versions.node.split(".")[0] >= 24 ? 0 : 1)' \
  || { say "Upgrading node to ≥ 24…"; brew upgrade node || brew install node; }

have pnpm  || { say "Installing pnpm…";  brew install pnpm; }
have herdr || { say "Installing herdr…"; brew install herdr || curl -fsSL https://herdr.dev/install.sh | sh; }
have pi    || { say "Installing pi…";    npm install -g @earendil-works/pi-coding-agent; }

# Optional extra harnesses (pi is the default orchestrator kind).
if [ "${FAKTORY_INSTALL_EXTRAS:-1}" = "1" ]; then
  have claude || { say "Installing claude (optional)…"; npm install -g @anthropic-ai/claude-code || true; }
  have codex  || { say "Installing codex (optional)…";  npm install -g @openai/codex || true; }
fi

say "Installing Faktory dependencies…"
cd "$(dirname "$0")"
pnpm install

say "Done. Next steps:"
cat <<'EOF'
  1. Authenticate pi against your provider:    pi   (follow the login flow)
  2. Start herdr and open a pane in this repo: herdr
  3. Create an instance:                       bin/faktory init <name>
  4. Configure the Notion source:              bin/faktory source:set-notion --instance <name> --database <id> --token ntn_…
  5. Serve the board:                          bin/faktory serve --instance <name>
EOF
