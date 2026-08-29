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

# Strip inherited herdr env so the new window is NOT treated as nested herdr.
# (This script may be launched from within a herdr pane.)
HERDR_LAUNCH="env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID -u HERDR_PANE_ID herdr"

# `herdr --session <name>` both creates the session (if new) and attaches (if
# it already exists), so this handles the "window was closed, server still up"
# case too.
CMD="cd $(printf %q "$REPO") && $HERDR_LAUNCH --session $(printf %q "$SESSION")"
case "${FAKTORY_TERM:-${TERM_PROGRAM:-Terminal}}" in
  ghostty|Ghostty*) open -na Ghostty --args --working-directory="$REPO" -e $HERDR_LAUNCH --session "$SESSION" ;;
  iTerm*)           osascript -e "tell application \"iTerm\" to create window with default profile command \"bash -lc '$CMD'\"" >/dev/null ;;
  *)                osascript -e "tell application \"Terminal\" to do script \"$CMD\"" -e 'tell application "Terminal" to activate' >/dev/null ;;
esac
echo "⚙ opened new terminal window with herdr session '$SESSION'"

# If the session server is already running, its panes persist across window
# close; don't re-split an existing layout.
if [ -S "$SOCK" ] && env -u HERDR_ENV HERDR_SOCKET_PATH="$SOCK" herdr pane list >/dev/null 2>&1; then
  echo "⚙ reattached to existing session '$SESSION' (panes preserved)"
  exit 0
fi

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
