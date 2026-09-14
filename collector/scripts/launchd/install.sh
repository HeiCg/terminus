#!/usr/bin/env bash
# Install the Terminus collector as a per-user launchd agent (macOS). Renders the
# plist template with absolute paths for `node` and this repo, then bootstraps it
# under the current GUI session. Requires a build first (`npm run build -w collector`)
# because the agent runs `node dist/main.js`, not tsx.
set -euo pipefail

LABEL="com.terminus.collector"
# scripts/launchd/install.sh -> collector dir is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTOR_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
LOG_DIR="$HOME/Library/Logs/Terminus"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "launchd agents are macOS-only (uname: $(uname))." >&2
  exit 1
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH; install Node >= 20 and retry." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE")"

if [[ ! -f "$COLLECTOR_DIR/dist/main.js" ]]; then
  echo "$COLLECTOR_DIR/dist/main.js is missing; run 'npm run build -w collector' first." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

# Render the template. Paths never contain '|', so it is a safe sed delimiter.
sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__NODE_DIR__|$NODE_DIR|g" \
  -e "s|__COLLECTOR_DIR__|$COLLECTOR_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$PLIST"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST"
fi

# Replace any prior agent, then bootstrap the freshly written plist.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true

echo "installed $LABEL"
echo "  plist: $PLIST"
echo "  logs:  $LOG_DIR/collector.log"
echo "  status: launchctl print gui/$UID/$LABEL | grep state"
echo "  stop/remove: $SCRIPT_DIR/uninstall.sh"
