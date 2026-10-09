#!/usr/bin/env bash
# Install the Terminus collector as a systemd --user service (Linux). Renders the
# unit template with absolute paths for `node` and this repo, then enables and
# (re)starts it under the current user's systemd instance. Requires a build first
# (`npm run build -w collector`) because the service runs `node dist/main.js`, not tsx.
set -euo pipefail

UNIT="terminus-collector.service"
# scripts/systemd/install.sh -> collector dir is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTOR_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/$UNIT.template"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"
ENV_DIR="$CONFIG_HOME/terminus"
ENV_FILE="$ENV_DIR/collector.env"

if [[ "$(uname)" != "Linux" ]]; then
  echo "systemd user services are Linux-only (uname: $(uname)); on macOS use scripts/launchd/install.sh." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; this script needs systemd." >&2
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

mkdir -p "$UNIT_DIR" "$ENV_DIR"

# Render the template. Paths never contain '|', so it is a safe sed delimiter.
sed \
  -e "s|__NODE__|$NODE|g" \
  -e "s|__NODE_DIR__|$NODE_DIR|g" \
  -e "s|__COLLECTOR_DIR__|$COLLECTOR_DIR|g" \
  -e "s|__ENV_FILE__|$ENV_FILE|g" \
  "$TEMPLATE" > "$UNIT_FILE"

# Seed a commented env file once; never overwrite the operator's settings.
if [[ ! -e "$ENV_FILE" ]]; then
  (
    umask 077
    cat > "$ENV_FILE" <<'ENV'
# Environment for the Terminus collector systemd --user service, one VAR=value per
# line. See the Configuration table in collector/README.md. After editing:
#   systemctl --user restart terminus-collector
#TERMINUS_PORT=8787
#TERMINUS_SAN_INTERFACES=eth0
#TERMINUS_PAIRING_HOST=192.168.1.10
ENV
  )
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$UNIT_FILE" || echo "warning: systemd-analyze reported issues with $UNIT_FILE" >&2
fi

# Replace any prior instance: reload units, enable at login, and restart so a
# reinstall picks up the new unit and build.
systemctl --user daemon-reload
systemctl --user enable "$UNIT"
systemctl --user restart "$UNIT"

echo "installed $UNIT"
echo "  unit:   $UNIT_FILE"
echo "  env:    $ENV_FILE"
echo "  logs:   journalctl --user -u terminus-collector -f"
echo "  status: systemctl --user status terminus-collector"
echo "  stop/remove: $SCRIPT_DIR/uninstall.sh"

# A user service stops when the user's last session ends unless lingering is on.
LINGER="$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || true)"
if [[ "$LINGER" != "yes" ]]; then
  echo "  note: to keep the collector running after logout and start it at boot, run:"
  echo "        loginctl enable-linger $(id -un)"
fi
