#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"
CLEAN_STALE="${CLEAN_STALE:-1}"

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

Examples:
  ./gpms-resume.sh
  ./gpms-resume.sh /var/tmp/gpms/checkpoints/xpra-110-20260426-001500
  SESSION=110 ./gpms-resume.sh
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

if [[ "${CLEAN_STALE}" == "1" ]]; then
  echo "[resume] cleaning stale session state for :${SESSION}"
  xpra stop ":${SESSION}" >/dev/null 2>&1 || true
  rm -rf "/run/user/${UIDN}/xpra/${SESSION}" "${HOME}/.xpra"/*-"${SESSION}" 2>/dev/null || true
fi

echo "[resume] restoring session=${SESSION} from ${CKPT_DIR}"
run_as_root env XDG_RUNTIME_DIR="/run/user/${UIDN}" criu restore \
  -D "${CKPT_DIR}" \
  -o restore.log \
  -v4 -j \
  --shell-job \
  --tcp-established \
  --ext-unix-sk \
  --file-locks

echo "[resume] done"
echo "[resume] restore log: ${CKPT_DIR}/restore.log"
echo "[resume] attach: xpra attach tcp://127.0.0.1:14600/ --opengl=force --notifications=no --speaker=off --microphone=off --webcam=no"
