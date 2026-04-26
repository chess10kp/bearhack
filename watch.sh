#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="${DEMO_DIR:-/tmp/gpms-demo}"
COMPILE_LOG="${DEMO_DIR}/compile.log"
GCC_LOG="${DEMO_DIR}/gcc.log"

mkdir -p "${DEMO_DIR}"
touch "${COMPILE_LOG}" "${GCC_LOG}"

echo "Watching: ${COMPILE_LOG} and ${GCC_LOG}"
echo "(Ctrl-C to stop)"
tail -n 40 -F "${COMPILE_LOG}" "${GCC_LOG}"
