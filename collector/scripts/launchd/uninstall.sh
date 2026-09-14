#!/usr/bin/env bash
# Stop and remove the Terminus collector launchd agent (macOS). Leaves the log file
# in place so a post-mortem survives an uninstall.
set -euo pipefail

LABEL="com.terminus.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "launchd agents are macOS-only (uname: $(uname))." >&2
  exit 1
fi

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "removed $LABEL"
echo "  logs kept at: $HOME/Library/Logs/Terminus/collector.log"
