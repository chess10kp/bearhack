#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"
CLEAN_STALE="${CLEAN_STALE:-1}"
CONNECT_URI="${CONNECT_URI:-tcp://127.0.0.1:14600/}"
ATTACH_OPENGL="${ATTACH_OPENGL:-force}"

usage() {
  cat <<'USAGE'
Usage:
  gpms-resume.sh [checkpoint_dir] [session]

If checkpoint_dir is omitted, script uses:
  1) /var/tmp/gpms/checkpoints/xpra-<session>-latest
  2) /var/tmp/gpms/checkpoints/latest

Env:
  SESSION=110
  CHECKPOINT_ROOT=/var/tmp/gpms/checkpoints
  CLEAN_STALE=1
  CONNECT_URI=tcp://127.0.0.1:14600/
  ATTACH_OPENGL=force
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

CKPT_DIR="${1:-}"
if [[ -n "${2:-}" ]]; then
  SESSION="$2"
fi

if [[ -z "${CKPT_DIR}" ]]; then
  if [[ -L "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest" || -d "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest" ]]; then
    CKPT_DIR="$(readlink -f "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest")"
  elif [[ -f "${CHECKPOINT_ROOT}/latest" ]]; then
    CKPT_DIR="$(cat "${CHECKPOINT_ROOT}/latest")"
  fi
fi

if [[ -z "${CKPT_DIR}" ]]; then
  echo "error: no checkpoint directory provided and none found in ${CHECKPOINT_ROOT}" >&2
  exit 1
fi

if [[ ! -d "${CKPT_DIR}" ]]; then
  echo "error: checkpoint directory not found: ${CKPT_DIR}" >&2
  exit 1
fi

if [[ ! -s "${CKPT_DIR}/inventory.img" ]]; then
  echo "error: checkpoint is incomplete (missing ${CKPT_DIR}/inventory.img)" >&2
  if [[ -f "${CKPT_DIR}/dump.log" ]]; then
    echo "[resume] dump log tail:" >&2
    run_as_root tail -n 80 "${CKPT_DIR}/dump.log" >&2 || true
  fi
  exit 1
fi

if [[ -f "${CKPT_DIR}/dump.log" ]] && run_as_root grep -q 'Dumping FAILED' "${CKPT_DIR}/dump.log"; then
  echo "error: checkpoint dump failed according to ${CKPT_DIR}/dump.log" >&2
  run_as_root tail -n 80 "${CKPT_DIR}/dump.log" >&2 || true
  exit 1
fi

if [[ "${CLEAN_STALE}" == "1" ]]; then
  echo "[resume] cleaning stale session state for :${SESSION}"
  xpra stop ":${SESSION}" >/dev/null 2>&1 || true
  rm -f "/run/user/${UIDN}/xpra/goobtop-${SESSION}" "${HOME}/.xpra/goobtop-${SESSION}" 2>/dev/null || true
  rm -f "/run/user/${UIDN}/xpra/${SESSION}/socket" 2>/dev/null || true
fi

SESSION_DIR="/run/user/${UIDN}/xpra/${SESSION}"
mkdir -p "${SESSION_DIR}"
if [[ ! -f "${SESSION_DIR}/server.log" ]] && [[ -f "${CKPT_DIR}/server.log.seed" ]]; then
  cp -a "${CKPT_DIR}/server.log.seed" "${SESSION_DIR}/server.log" 2>/dev/null || true
fi

echo "[resume] restoring session=${SESSION} from ${CKPT_DIR}"
set +e
run_as_root env XDG_RUNTIME_DIR="/run/user/${UIDN}" criu restore \
  -D "${CKPT_DIR}" \
  --restore-detached \
  -o restore.log \
  -v4 -j \
  --shell-job \
  --tcp-established \
  --ext-unix-sk \
  --file-locks
RC=$?
set -e

if [[ ${RC} -ne 0 ]]; then
  echo "error: restore failed with code ${RC}" >&2
  if [[ -f "${CKPT_DIR}/restore.log" ]]; then
    echo "[resume] restore log tail:" >&2
    run_as_root tail -n 120 "${CKPT_DIR}/restore.log" >&2 || true
  fi
  exit ${RC}
fi

echo "[resume] done"
echo "[resume] restore log: ${CKPT_DIR}/restore.log"
echo "[resume] attach: xpra attach ${CONNECT_URI} --opengl=${ATTACH_OPENGL} --notifications=no --speaker=off --microphone=off --webcam=no"
