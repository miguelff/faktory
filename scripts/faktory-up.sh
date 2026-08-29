#!/usr/bin/env bash
# Deprecated shim — Faktory now spawns herdr itself (session, window, panes):
#
#   bin/faktory serve --instance <name> [--session <name>]
#
#   scripts/faktory-up.sh [session-name] [instance]     (defaults: faktory, fk)
set -euo pipefail
exec "$(cd "$(dirname "$0")/.." && pwd)/bin/faktory" serve "${2:-fk}" ${1:+--session "$1"}
