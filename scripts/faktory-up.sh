#!/usr/bin/env bash
# faktory-up — open a new terminal window running a dedicated herdr session,
# and start the Faktory board + TUI inside it.
#
#   scripts/faktory-up.sh [session-name] [instance]     (defaults: faktory, fk)
#
# The new herdr session has its own server and socket, fully isolated from your
# main herdr. Faktory dispatch inside it creates worktrees/workspaces there.
set -euo pipefail

SESSION="${1:-faktory}"
INSTANCE="${2:-fk}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${HERDR_ENV:-}" = "1" ]; then
  echo "Run this from a plain terminal (or a fresh window), not inside herdr." >&2
  echo "Tip: herdr sessions nest badly; the new window will run its own server." >&2
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

# 2. Wait for the session's socket to appear.
SOCK=""
for _ in $(seq 1 60); do
  SOCK="$(find "$HOME/.config/herdr" -maxdepth 2 -name "*${SESSION}*.sock" -o -maxdepth 2 -path "*${SESSION}*/herdr.sock" 2>/dev/null | head -1 || true)"
  [ -n "$SOCK" ] && break
  sleep 0.5
done
if [ -z "$SOCK" ]; then
  echo "Could not find the '$SESSION' session socket under ~/.config/herdr." >&2
  echo "Start Faktory manually in the new window:  bin/faktory serve --instance $INSTANCE" >&2
  exit 1
fi
export HERDR_SOCKET_PATH="$SOCK"
echo "⚙ session socket: $SOCK"

# 3. Bootstrap panes: board (serve) on the left, TUI on the right.
sleep 1
ROOT_PANE="$(herdr pane list 2>/dev/null | awk 'NR==1{print $1}')"
ROOT_PANE="${ROOT_PANE:-w1:p1}"
herdr pane split "$ROOT_PANE" --direction right --ratio 0.5 --cwd "$REPO" >/dev/null || true
herdr pane run "$ROOT_PANE" "bin/faktory serve --instance $INSTANCE" || true
NEIGHBOR="$(herdr pane neighbor "$ROOT_PANE" --direction right 2>/dev/null | awk 'NR==1{print $1}')"
[ -n "${NEIGHBOR:-}" ] && herdr pane run "$NEIGHBOR" "bin/faktory tui --instance $INSTANCE" || true

echo "⚙ faktory '$INSTANCE' is coming up inside herdr session '$SESSION'"
echo "   board: http://127.0.0.1:$("$REPO/bin/faktory" config:get --instance "$INSTANCE" port 2>/dev/null || echo 4600)"
