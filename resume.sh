#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-120}"
TCP_PORT="${TCP_PORT:-14610}"
DEMO_DIR="${DEMO_DIR:-/tmp/gpms-demo}"

CKPT="${1:-$(cat /var/tmp/gpms/checkpoints/latest)}"
echo "checkpoint=${CKPT}"
ls -lah "${CKPT}" | egrep 'inventory.img|dump.log|metadata.env'

SESSION="${SESSION}" MODE=checkpoint CONNECT_URI="tcp://127.0.0.1:${TCP_PORT}/" ./gpms-resume.sh "${CKPT}" "${SESSION}"

echo "[post-resume] compile log tail (${DEMO_DIR}/compile.log)"
tail -n 5 "${DEMO_DIR}/compile.log" || true
