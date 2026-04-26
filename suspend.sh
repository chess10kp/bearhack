#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-120}"
TCP_PORT="${TCP_PORT:-14610}"

# For checkpoint mode, ensure no active viewer is connected.
pkill -f "xpra attach tcp://127.0.0.1:${TCP_PORT}/" || true
sleep 1

echo "[precheck] active peers on :${TCP_PORT}"
ss -tnp state established | awk -v p=":${TCP_PORT}" 'NR==1 || $4 ~ p"$"'

SESSION="${SESSION}" TCP_PORT="${TCP_PORT}" MODE=checkpoint DETACH_CLIENTS=0 REQUIRE_NO_TCP_PEERS=1 ./gpms-suspend.sh "${SESSION}"
