#!/usr/bin/env bash
# Stop and remove the Terminus collector systemd --user service (Linux). Leaves the
# env file and the journal in place so settings and a post-mortem survive an
# uninstall.
set -euo pipefail

UNIT="terminus-collector.service"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT"
ENV_FILE="$CONFIG_HOME/terminus/collector.env"

if [[ "$(uname)" != "Linux" ]]; then
  echo "systemd user services are Linux-only (uname: $(uname)); on macOS use scripts/launchd/uninstall.sh." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; this script needs systemd." >&2
  exit 1
fi

systemctl --user disable --now "$UNIT" 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user reset-failed "$UNIT" 2>/dev/null || true

echo "removed $UNIT"
echo "  env file kept at: $ENV_FILE"
echo "  logs kept in the journal: journalctl --user -u terminus-collector"
