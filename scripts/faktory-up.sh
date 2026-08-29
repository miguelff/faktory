#!/usr/bin/env bash
# faktory-up — open a new terminal window running a dedicated herdr session,
# and start the Faktory board + TUI inside it.
#
#   scripts/faktory-up.sh [session-name] [instance]     (defaults: faktory, fk)
#
# The named herdr session has its own server and socket
# (~/.config/herdr/sessions/<name>/herdr.sock), fully isolated from your main
# herdr. Faktory dispatch inside it creates worktrees/workspaces there.
set -euo pipefail

SESSION="${1:-faktory}"
INSTANCE="${2:-fk}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"

if [ "${HERDR_ENV:-}" = "1" ]; then
  echo "Run this from a plain terminal (or a fresh window), not inside herdr." >&2
  exit 1
fi

# 1. Open a new terminal window attached to the named herdr session.
CMD="cd $(printf %q "$REPO") && herdr --session $(printf %q "$SESSION")"
case "${FAKTORY_TERM:-${TERM_PROGRAM:-Terminal}}" in
  ghostty|Ghostty*) open -na Ghostty --args --working-directory="$REPO" -e "herdr --session $SESSION" ;;
  iTerm*)           osascript -e "tell application \"iTerm\" to create window with default profile command \"bash -lc '$CMD'\"" >/dev/null ;;
  *)                osascript -e "tell application \"Terminal\" to do script \"$CMD\"" -e 'tell application "Terminal" to activate' >/dev/null ;;
esac
echo "⚙ opened new terminal window with herdr session '$SESSION'"

# 2. Wait for the session server to be ready (socket + a live pane).
export HERDR_SOCKET_PATH="$SOCK"
first_pane() {
  herdr pane list 2>/dev/null | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['panes'][0]['pane_id'])
except Exception: pass" 2>/dev/null
}
ROOT=""
for _ in $(seq 1 60); do
  [ -S "$SOCK" ] && ROOT="$(first_pane)" && [ -n "$ROOT" ] && break
  sleep 0.5
done
if [ -z "$ROOT" ]; then
  echo "Session '$SESSION' did not come up. In the new window run:" >&2
  echo "  bin/faktory serve --instance $INSTANCE" >&2
  exit 1
fi
echo "⚙ session ready (socket $SOCK, root pane $ROOT)"

# 3. Bootstrap panes: board (serve) on the left, TUI on the right.
NEW="$(herdr pane split "$ROOT" --direction right --ratio 0.5 --cwd "$REPO" | python3 -c "
import json,sys
print(json.load(sys.stdin)['result']['pane']['pane_id'])")"
herdr pane run "$ROOT" "cd $(printf %q "$REPO") && bin/faktory serve --instance $INSTANCE" >/dev/null
herdr pane run "$NEW"  "cd $(printf %q "$REPO") && bin/faktory tui --instance $INSTANCE" >/dev/null

PORT="$("$REPO/bin/faktory" config:get --instance "$INSTANCE" port 2>/dev/null | tail -1)"
echo "⚙ faktory '$INSTANCE' running inside herdr session '$SESSION'"
echo "   board: http://127.0.0.1:${PORT:-4600}"
