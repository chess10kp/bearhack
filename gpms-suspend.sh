#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"
XPRA_PID_FILE="${XPRA_PID_FILE:-/run/user/${UIDN}/xpra/${SESSION}/server.pid}"
DETACH_CLIENTS="${DETACH_CLIENTS:-1}"
DETACH_WAIT_SECONDS="${DETACH_WAIT_SECONDS:-10}"
POST_DETACH_SETTLE_SECONDS="${POST_DETACH_SETTLE_SECONDS:-2}"
ALLOW_ACTIVE_CLIENTS="${ALLOW_ACTIVE_CLIENTS:-0}"
TCP_PORT="${TCP_PORT:-14600}"
REQUIRE_NO_TCP_PEERS="${REQUIRE_NO_TCP_PEERS:-1}"
REQUIRE_IN_TREE_CHILD="${REQUIRE_IN_TREE_CHILD:-1}"
PRE_STOP="${PRE_STOP:-0}"
STOP_AFTER_DUMP="${STOP_AFTER_DUMP:-1}"
LEAVE_STOPPED="${LEAVE_STOPPED:-0}"
GHOST_LIMIT="${GHOST_LIMIT:-512M}"
USE_GHOST_FIEMAP="${USE_GHOST_FIEMAP:-1}"

usage() {
  cat <<'USAGE'
Usage:
  gpms-suspend.sh [session]

Env:
  SESSION=110
  CHECKPOINT_ROOT=/var/tmp/gpms/checkpoints
  XPRA_PID_FILE=/run/user/<uid>/xpra/<session>/server.pid
  DETACH_CLIENTS=1
  DETACH_WAIT_SECONDS=10
  POST_DETACH_SETTLE_SECONDS=2
  ALLOW_ACTIVE_CLIENTS=0
  TCP_PORT=14600
  REQUIRE_NO_TCP_PEERS=1
  REQUIRE_IN_TREE_CHILD=1
  PRE_STOP=0
  STOP_AFTER_DUMP=1
  LEAVE_STOPPED=0
  GHOST_LIMIT=512M
  USE_GHOST_FIEMAP=1

Notes:
  - Default flow: dump while running, then freeze after successful dump.
  - This avoids app restarts caused by freeze+failed-dump recovery.
USAGE
}

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

stop_tree() {
  local pid
  pid="$1"
  kill -STOP "${pid}" 2>/dev/null || true
  pkill -STOP -P "${pid}" 2>/dev/null || true
}

resume_tree() {
  local pid
  pid="$1"
  kill -CONT "${pid}" 2>/dev/null || true
  pkill -CONT -P "${pid}" 2>/dev/null || true
}

get_tcp_peer_count() {
  ss -tn state established 2>/dev/null | awk -v p=":${TCP_PORT}" '$4 ~ p"$" {c++} END {print c+0}'
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

if [[ "${REQUIRE_IN_TREE_CHILD}" == "1" ]]; then
  CHILD_PIDS="$(pgrep -P "${XPRA_PID}" || true)"
  APP_CHILD_COUNT=0
  for cpid in ${CHILD_PIDS}; do
    ccomm="$(ps -o comm= -p "${cpid}" 2>/dev/null | tr -d ' ' || true)"
    case "${ccomm}" in
      Xvfb-for-Xpra-*|Xvfb)
        ;;
      "")
        ;;
      *)
        APP_CHILD_COUNT=$((APP_CHILD_COUNT + 1))
        ;;
    esac
  done
  if (( APP_CHILD_COUNT == 0 )); then
    echo "error: no checkpointable app child found under xpra server pid ${XPRA_PID}" >&2
    echo "hint: this usually means the session was started with detached app mode (--start)" >&2
    echo "hint: restart with START_MODE=start-child and CHILD_CMD='code --wait ...'" >&2
    exit 2
  fi
fi

mkdir -p "${CHECKPOINT_ROOT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CKPT_DIR="${CHECKPOINT_ROOT}/xpra-${SESSION}-${STAMP}"
mkdir -p "${CKPT_DIR}"

echo "[suspend] session=${SESSION} pid=${XPRA_PID}"
echo "[suspend] checkpoint=${CKPT_DIR}"

if [[ "${DETACH_CLIENTS}" == "1" ]]; then
  echo "[suspend] detaching active clients"
  xpra detach ":${SESSION}" >/dev/null 2>&1 || true
  sleep "${DETACH_WAIT_SECONDS}"

  if (( POST_DETACH_SETTLE_SECONDS > 0 )); then
    sleep "${POST_DETACH_SETTLE_SECONDS}"
  fi
fi

if [[ "${REQUIRE_NO_TCP_PEERS}" == "1" ]]; then
  peers="$(get_tcp_peer_count)"
  if (( peers > 0 )) && [[ "${ALLOW_ACTIVE_CLIENTS}" != "1" ]]; then
    echo "error: ${peers} active TCP peer connection(s) on port ${TCP_PORT}; refusing to dump" >&2
    echo "tip: wait a few seconds after detach and retry" >&2
    exit 1
  fi
fi

if [[ "${PRE_STOP}" == "1" ]]; then
  echo "[suspend] pre-stopping xpra process tree"
  stop_tree "${XPRA_PID}"
fi

echo "${CKPT_DIR}" > "${CHECKPOINT_ROOT}/latest"
ln -sfn "${CKPT_DIR}" "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest"

cat > "${CKPT_DIR}/metadata.env" <<META
SESSION=${SESSION}
XPRA_PID=${XPRA_PID}
CREATED_AT=${STAMP}
XPRA_PID_FILE=${XPRA_PID_FILE}
DETACH_CLIENTS=${DETACH_CLIENTS}
DETACH_WAIT_SECONDS=${DETACH_WAIT_SECONDS}
POST_DETACH_SETTLE_SECONDS=${POST_DETACH_SETTLE_SECONDS}
ALLOW_ACTIVE_CLIENTS=${ALLOW_ACTIVE_CLIENTS}
TCP_PORT=${TCP_PORT}
REQUIRE_NO_TCP_PEERS=${REQUIRE_NO_TCP_PEERS}
REQUIRE_IN_TREE_CHILD=${REQUIRE_IN_TREE_CHILD}
PRE_STOP=${PRE_STOP}
STOP_AFTER_DUMP=${STOP_AFTER_DUMP}
LEAVE_STOPPED=${LEAVE_STOPPED}
GHOST_LIMIT=${GHOST_LIMIT}
USE_GHOST_FIEMAP=${USE_GHOST_FIEMAP}
META

SERVER_LOG_PATH="/run/user/${UIDN}/xpra/${SESSION}/server.log"
if [[ -f "${SERVER_LOG_PATH}" ]]; then
  cp -a "${SERVER_LOG_PATH}" "${CKPT_DIR}/server.log.seed" 2>/dev/null || true
fi

CRIU_ARGS=(
  env "XDG_RUNTIME_DIR=/run/user/${UIDN}" criu dump
  -t "${XPRA_PID}"
  -D "${CKPT_DIR}"
  -o dump.log
  -v4 -j
  --shell-job
  --tcp-established
  --ext-unix-sk
  --file-locks
  --ghost-limit "${GHOST_LIMIT}"
)

if [[ "${USE_GHOST_FIEMAP}" == "1" ]]; then
  CRIU_ARGS+=(--ghost-fiemap)
fi
if [[ "${LEAVE_STOPPED}" == "1" ]]; then
  CRIU_ARGS+=(--leave-stopped)
fi

set +e
run_as_root "${CRIU_ARGS[@]}"
RC=$?
set -e

if [[ ${RC} -ne 0 ]]; then
  echo "error: dump failed with code ${RC}" >&2
  if [[ "${PRE_STOP}" == "1" ]]; then
    echo "[suspend] resuming process tree after failed dump" >&2
    resume_tree "${XPRA_PID}"
  fi
  if [[ -f "${CKPT_DIR}/dump.log" ]]; then
    if run_as_root grep -q 'skqueue: Control messages in queue, not supported' "${CKPT_DIR}/dump.log"; then
      echo "[suspend] hint: CRIU cannot checkpoint this app right now due unix socket control-message queues." >&2
      echo "[suspend] hint: VSCode/Electron often triggers this; use a simpler app (eg xclock/xterm) to validate migration pipeline." >&2
    elif run_as_root grep -q "Can't dump half of stream unix connection" "${CKPT_DIR}/dump.log"; then
      echo "[suspend] hint: there is still an active unix stream peer outside the checkpoint tree." >&2
      echo "[suspend] hint: start with START_MODE=start-child and a checkpoint-friendly child process to keep peers in-tree." >&2
    elif run_as_root grep -q 'anon_inode:\[io_uring\]' "${CKPT_DIR}/dump.log"; then
      echo "[suspend] hint: io_uring mappings are present; temporarily set kernel.io_uring_disabled=2 before starting the app." >&2
    elif run_as_root grep -q 'SysVIPC shmem map' "${CKPT_DIR}/dump.log"; then
      echo "[suspend] hint: Xvfb shared memory mapping issue; ensure MIT-SHM is disabled in XVFB_CMD." >&2
    fi
  fi
  if [[ -f "${CKPT_DIR}/dump.log" ]]; then
    echo "[suspend] dump log tail:" >&2
    run_as_root tail -n 100 "${CKPT_DIR}/dump.log" >&2 || true
  fi
  exit ${RC}
fi

if [[ ! -s "${CKPT_DIR}/inventory.img" ]]; then
  echo "error: checkpoint missing inventory.img (dump incomplete)" >&2
  exit 1
fi

if [[ "${STOP_AFTER_DUMP}" == "1" ]]; then
  echo "[suspend] stopping xpra process tree after successful dump"
  stop_tree "${XPRA_PID}"
fi

echo "[suspend] done"
echo "[suspend] files: ${CKPT_DIR}"
echo "[suspend] dump log: ${CKPT_DIR}/dump.log"
