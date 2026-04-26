#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"
XPRA_PID_FILE="${XPRA_PID_FILE:-/run/user/${UIDN}/xpra/${SESSION}/server.pid}"

usage() {
  cat <<'USAGE'
Usage:
  gpms-suspend.sh [session]

Env:
  SESSION=110
  CHECKPOINT_ROOT=/var/tmp/gpms/checkpoints
  XPRA_PID_FILE=/run/user/<uid>/xpra/<session>/server.pid

Examples:
  ./gpms-suspend.sh
  SESSION=110 ./gpms-suspend.sh
  ./gpms-suspend.sh 110
USAGE
}

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  SESSION="$1"
  XPRA_PID_FILE="/run/user/${UIDN}/xpra/${SESSION}/server.pid"
fi

if [[ ! -f "${XPRA_PID_FILE}" ]]; then
  echo "error: xpra pid file not found: ${XPRA_PID_FILE}" >&2
  echo "tip: start a session first with ./gpms-xpra-mvp.sh start" >&2
  exit 1
fi

XPRA_PID="$(cat "${XPRA_PID_FILE}")"
if [[ ! "${XPRA_PID}" =~ ^[0-9]+$ ]] || ! ps -p "${XPRA_PID}" >/dev/null 2>&1; then
  echo "error: invalid or dead xpra pid: ${XPRA_PID}" >&2
  exit 1
fi

mkdir -p "${CHECKPOINT_ROOT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CKPT_DIR="${CHECKPOINT_ROOT}/xpra-${SESSION}-${STAMP}"
mkdir -p "${CKPT_DIR}"

echo "[suspend] session=${SESSION} pid=${XPRA_PID}"
echo "[suspend] checkpoint=${CKPT_DIR}"

echo "${CKPT_DIR}" > "${CHECKPOINT_ROOT}/latest"
ln -sfn "${CKPT_DIR}" "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest"

cat > "${CKPT_DIR}/metadata.env" <<META
SESSION=${SESSION}
XPRA_PID=${XPRA_PID}
CREATED_AT=${STAMP}
XPRA_PID_FILE=${XPRA_PID_FILE}
META

run_as_root env XDG_RUNTIME_DIR="/run/user/${UIDN}" criu dump \
  -t "${XPRA_PID}" \
  -D "${CKPT_DIR}" \
  -o dump.log \
  -v4 -j \
  --shell-job \
  --tcp-established \
  --ext-unix-sk \
  --file-locks

echo "[suspend] done"
echo "[suspend] files: ${CKPT_DIR}"
echo "[suspend] dump log: ${CKPT_DIR}/dump.log"
