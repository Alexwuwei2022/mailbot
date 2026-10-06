#!/usr/bin/env bash
# Mailbot launcher (macOS / Linux).
#
#   chmod +x start.sh && ./start.sh
#
# Keep this script deliberately thin: every check and every user-facing message
# lives in `node cli.js start`, so Windows / macOS / Linux all behave the same
# and there is only one place to maintain.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [ERROR] Node.js was not found on this computer."
  echo "  Please install Node.js 20 or newer: https://nodejs.org/en/download"
  echo
  exit 1
fi

exec node cli.js start "$@"
