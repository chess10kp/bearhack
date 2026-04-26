#!/usr/bin/env bash
set -euo pipefail

# gpms-suspend.sh
#
# Default mode: real suspend via SIGSTOP of the full xpra process tree.
#   - Every process under the xpra server (xpra, Xvfb, app, all descendants)
#     enters kernel T (stopped) state and consumes 0% CPU.
#   - State (PID list + comm + cmdline) is persisted so gpms-resume.sh can
#     verify and SIGCONT the same tree later.
#   - Works for any GUI app, including VSCode/Electron, where CRIU dump fails.
#
# Optional mode: MODE=checkpoint runs CRIU dump (migration-grade snapshot).
#   This is opt-in because CRIU has known limitations on this stack.

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
MODE="${MODE:-freeze}"

STATE_ROOT="${STATE_ROOT:-/var/tmp/gpms/suspends}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"
XPRA_PID_FILE="${XPRA_PID_FILE:-/run/user/${UIDN}/xpra/${SESSION}/server.pid}"

VERIFY_SECONDS="${VERIFY_SECONDS:-3}"
VERIFY_POLL_SECONDS="${VERIFY_POLL_SECONDS:-0.2}"

# --- checkpoint-mode (CRIU) options, ignored in freeze mode ---
DETACH_CLIENTS="${DETACH_CLIENTS:-0}"
DETACH_WAIT_SECONDS="${DETACH_WAIT_SECONDS:-10}"
POST_DETACH_SETTLE_SECONDS="${POST_DETACH_SETTLE_SECONDS:-2}"
ALLOW_ACTIVE_CLIENTS="${ALLOW_ACTIVE_CLIENTS:-0}"
TCP_PORT="${TCP_PORT:-14600}"
REQUIRE_NO_TCP_PEERS="${REQUIRE_NO_TCP_PEERS:-1}"
REQUIRE_IN_TREE_CHILD="${REQUIRE_IN_TREE_CHILD:-1}"
ALLOW_UNSUPPORTED_APP="${ALLOW_UNSUPPORTED_APP:-0}"
LEAVE_STOPPED="${LEAVE_STOPPED:-0}"
GHOST_LIMIT="${GHOST_LIMIT:-512M}"
USE_GHOST_FIEMAP="${USE_GHOST_FIEMAP:-1}"

usage() {
  cat <<'USAGE'
Usage:
  gpms-suspend.sh [session]

Modes (env MODE=...):
  freeze       (default) SIGSTOP whole xpra process tree. Truly suspends.
  checkpoint   CRIU dump for migration. Opt-in; fails for Electron/VSCode.

Common env:
  SESSION=110
  STATE_ROOT=/var/tmp/gpms/suspends
  CHECKPOINT_ROOT=/var/tmp/gpms/checkpoints
  XPRA_PID_FILE=/run/user/<uid>/xpra/<session>/server.pid
  VERIFY_SECONDS=3
  VERIFY_POLL_SECONDS=0.2

Checkpoint-only env:
  DETACH_CLIENTS=0
  ALLOW_ACTIVE_CLIENTS=0
  TCP_PORT=14600
  REQUIRE_NO_TCP_PEERS=1
  REQUIRE_IN_TREE_CHILD=1
  ALLOW_UNSUPPORTED_APP=0
  LEAVE_STOPPED=0
  GHOST_LIMIT=512M
  USE_GHOST_FIEMAP=1

Examples:
  ./gpms-suspend.sh 110                    # real freeze (default)
  MODE=checkpoint ./gpms-suspend.sh 110    # CRIU dump (migration)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  SESSION="$1"
  XPRA_PID_FILE="/run/user/${UIDN}/xpra/${SESSION}/server.pid"
fi

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

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

APP_CMD="$(xpra info ":${SESSION}" 2>/dev/null \
  | awk -F= '/^command\.0\.name=/ && !seen {print substr($0, index($0, "=")+1); seen=1}' \
  || true)"
APP_CMD="${APP_CMD:-unknown}"

# Walk descendant tree of XPRA_PID using /proc, breadth-first.
# Output one PID per line, parents before children.
collect_tree_pids() {
  local root="$1"
  local queue=("${root}")
  local seen_re=" ${root} "
  local out=("${root}")
  local cur

  while ((${#queue[@]} > 0)); do
    cur="${queue[0]}"
    queue=("${queue[@]:1}")
    while IFS= read -r child; do
      [[ -z "${child}" ]] && continue
      if [[ "${seen_re}" != *" ${child} "* ]]; then
        seen_re+=" ${child} "
        out+=("${child}")
        queue+=("${child}")
      fi
    done < <(pgrep -P "${cur}" 2>/dev/null || true)
  done

  printf '%s\n' "${out[@]}"
}

proc_state() {
  local pid="$1"
  awk '/^State:/{print $2; exit}' "/proc/${pid}/status" 2>/dev/null
}

proc_comm() {
  local pid="$1"
  cat "/proc/${pid}/comm" 2>/dev/null | tr -d '\n'
}

proc_cmdline() {
  local pid="$1"
  tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | sed 's/ *$//'
}

# ---------------------------------------------------------------------------
# Mode: freeze (real suspend via SIGSTOP)
# ---------------------------------------------------------------------------
do_freeze() {
  mkdir -p "${STATE_ROOT}"
  local stamp dir state_file pids
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="${STATE_ROOT}/xpra-${SESSION}-${stamp}"
  mkdir -p "${dir}"

  echo "[suspend] mode=freeze session=${SESSION} xpra_pid=${XPRA_PID}"
  echo "[suspend] app=${APP_CMD}"
  echo "[suspend] state=${dir}"

  mapfile -t pids < <(collect_tree_pids "${XPRA_PID}")
  if ((${#pids[@]} == 0)); then
    echo "error: no processes found under xpra pid ${XPRA_PID}" >&2
    exit 1
  fi
  echo "[suspend] tree size=${#pids[@]} pids"

  state_file="${dir}/pids.txt"
  : >"${state_file}"
  local pid st cm cl
  for pid in "${pids[@]}"; do
    st="$(proc_state "${pid}")"
    cm="$(proc_comm "${pid}")"
    cl="$(proc_cmdline "${pid}")"
    printf '%s\t%s\t%s\t%s\n' "${pid}" "${st:-?}" "${cm:-?}" "${cl:-?}" >>"${state_file}"
  done

  cat >"${dir}/metadata.env" <<META
SESSION=${SESSION}
XPRA_PID=${XPRA_PID}
APP_CMD=${APP_CMD}
MODE=freeze
CREATED_AT=${stamp}
XPRA_PID_FILE=${XPRA_PID_FILE}
TREE_SIZE=${#pids[@]}
META

  echo "${dir}" >"${STATE_ROOT}/latest"
  ln -sfn "${dir}" "${STATE_ROOT}/xpra-${SESSION}-latest"

  # Stop top-down (parent first) so the parent cannot fork during the freeze.
  local rc=0 pid_failed=0
  for pid in "${pids[@]}"; do
    if ! kill -STOP "${pid}" 2>/dev/null; then
      pid_failed=$((pid_failed + 1))
    fi
  done

  # Verify: every captured pid that is still alive must be in T or t state.
  local waited=0 ok all_t failed_pids
  ok=0
  while awk -v w="${waited}" -v lim="${VERIFY_SECONDS}" 'BEGIN{exit !(w<lim)}'; do
    all_t=1
    failed_pids=()
    for pid in "${pids[@]}"; do
      if [[ ! -d "/proc/${pid}" ]]; then
        continue
      fi
      st="$(proc_state "${pid}")"
      case "${st}" in
        T|t) ;;
        Z|"") ;;
        *)
          all_t=0
          failed_pids+=("${pid}:${st}")
          ;;
      esac
    done
    if (( all_t == 1 )); then
      ok=1
      break
    fi
    sleep "${VERIFY_POLL_SECONDS}"
    waited="$(awk -v w="${waited}" -v p="${VERIFY_POLL_SECONDS}" 'BEGIN{print w+p}')"
  done

  if (( ok != 1 )); then
    echo "error: not all processes entered stopped state within ${VERIFY_SECONDS}s" >&2
    echo "       offenders: ${failed_pids[*]}" >&2
    rc=1
  fi

  # Snapshot post-stop states for the audit trail.
  {
    echo "# post-stop states"
    for pid in "${pids[@]}"; do
      st="$(proc_state "${pid}")"
      printf '%s\t%s\n' "${pid}" "${st:-gone}"
    done
  } >"${dir}/post-stop-states.txt"

  if (( rc == 0 )); then
    echo "[suspend] all ${#pids[@]} processes are now stopped (T/t)"
    echo "[suspend] resume with: ./gpms-resume.sh ${dir} ${SESSION}"
    echo "[suspend] or just:     ./gpms-resume.sh"
  fi
  exit "${rc}"
}

# ---------------------------------------------------------------------------
# Mode: checkpoint (CRIU dump)
# ---------------------------------------------------------------------------
get_tcp_peer_count() {
  ss -tn state established 2>/dev/null \
    | awk -v p=":${TCP_PORT}" '$4 ~ p"$" {c++} END {print c+0}'
}

stop_tree() {
  local root="$1"
  while IFS= read -r p; do
    kill -STOP "${p}" 2>/dev/null || true
  done < <(collect_tree_pids "${root}")
}

resume_tree() {
  local root="$1"
  local pids=()
  while IFS= read -r p; do
    pids+=("${p}")
  done < <(collect_tree_pids "${root}")
  local i
  for ((i=${#pids[@]}-1; i>=0; i--)); do
    kill -CONT "${pids[i]}" 2>/dev/null || true
  done
}

do_checkpoint() {
  if [[ "${ALLOW_UNSUPPORTED_APP}" != "1" ]] \
       && echo "${APP_CMD}" | grep -qiE '(^|[ /])code([[:space:]]|$)|electron'; then
    echo "error: refusing CRIU checkpoint for app '${APP_CMD}'" >&2
    echo "hint: VSCode/Electron is not checkpointable on this CRIU/xpra stack." >&2
    echo "hint: use MODE=freeze (default) for a real suspend, or" >&2
    echo "      ALLOW_UNSUPPORTED_APP=1 MODE=checkpoint to force a CRIU attempt." >&2
    exit 3
  fi

  if [[ "${REQUIRE_IN_TREE_CHILD}" == "1" ]]; then
    local child_pids cpid ccomm app_count=0
    child_pids="$(pgrep -P "${XPRA_PID}" || true)"
    for cpid in ${child_pids}; do
      ccomm="$(ps -o comm= -p "${cpid}" 2>/dev/null | tr -d ' ' || true)"
      case "${ccomm}" in
        Xvfb-for-Xpra-*|Xvfb|"") ;;
        *) app_count=$((app_count + 1)) ;;
      esac
    done
    if (( app_count == 0 )); then
      echo "error: no checkpointable app child found under xpra pid ${XPRA_PID}" >&2
      echo "hint: restart with START_MODE=start-child" >&2
      exit 2
    fi
  fi

  mkdir -p "${CHECKPOINT_ROOT}"
  local stamp dir
  stamp="$(date +%Y%m%d-%H%M%S)"
  dir="${CHECKPOINT_ROOT}/xpra-${SESSION}-${stamp}"
  mkdir -p "${dir}"

  echo "[suspend] mode=checkpoint session=${SESSION} xpra_pid=${XPRA_PID}"
  echo "[suspend] app=${APP_CMD}"
  echo "[suspend] checkpoint=${dir}"

  if [[ "${DETACH_CLIENTS}" == "1" ]]; then
    echo "[suspend] detaching active clients"
    xpra detach ":${SESSION}" >/dev/null 2>&1 || true
    sleep "${DETACH_WAIT_SECONDS}"
    if (( POST_DETACH_SETTLE_SECONDS > 0 )); then
      sleep "${POST_DETACH_SETTLE_SECONDS}"
    fi
  fi

  if [[ "${REQUIRE_NO_TCP_PEERS}" == "1" ]]; then
    local peers
    peers="$(get_tcp_peer_count)"
    if (( peers > 0 )) && [[ "${ALLOW_ACTIVE_CLIENTS}" != "1" ]]; then
      echo "error: ${peers} active TCP peer(s) on port ${TCP_PORT}; refusing dump" >&2
      exit 1
    fi
  fi

  echo "${dir}" >"${CHECKPOINT_ROOT}/latest"
  ln -sfn "${dir}" "${CHECKPOINT_ROOT}/xpra-${SESSION}-latest"

  cat >"${dir}/metadata.env" <<META
SESSION=${SESSION}
XPRA_PID=${XPRA_PID}
APP_CMD=${APP_CMD}
MODE=checkpoint
CREATED_AT=${stamp}
XPRA_PID_FILE=${XPRA_PID_FILE}
DETACH_CLIENTS=${DETACH_CLIENTS}
ALLOW_ACTIVE_CLIENTS=${ALLOW_ACTIVE_CLIENTS}
TCP_PORT=${TCP_PORT}
ALLOW_UNSUPPORTED_APP=${ALLOW_UNSUPPORTED_APP}
LEAVE_STOPPED=${LEAVE_STOPPED}
GHOST_LIMIT=${GHOST_LIMIT}
USE_GHOST_FIEMAP=${USE_GHOST_FIEMAP}
META

  local server_log
  server_log="/run/user/${UIDN}/xpra/${SESSION}/server.log"
  if [[ -f "${server_log}" ]]; then
    cp -a "${server_log}" "${dir}/server.log.seed" 2>/dev/null || true
  fi

  local criu_args=(
    env "XDG_RUNTIME_DIR=/run/user/${UIDN}" criu dump
    -t "${XPRA_PID}"
    -D "${dir}"
    -o dump.log
    -v4 -j
    --shell-job
    --tcp-established
    --ext-unix-sk
    --file-locks
    --ghost-limit "${GHOST_LIMIT}"
  )
  if [[ "${USE_GHOST_FIEMAP}" == "1" ]]; then
    criu_args+=(--ghost-fiemap)
  fi
  if [[ "${LEAVE_STOPPED}" == "1" ]]; then
    criu_args+=(--leave-stopped)
  fi

  set +e
  run_as_root "${criu_args[@]}"
  local rc=$?
  set -e

  if (( rc != 0 )); then
    echo "error: CRIU dump failed with code ${rc}" >&2
    if [[ -f "${dir}/dump.log" ]]; then
      if run_as_root grep -q 'skqueue: Control messages in queue, not supported' "${dir}/dump.log"; then
        echo "[suspend] hint: unix-socket control-message queues; common for Electron/VSCode." >&2
        echo "[suspend] hint: use MODE=freeze (default) for real suspend." >&2
      elif run_as_root grep -q "Can't dump half of stream unix connection" "${dir}/dump.log"; then
        echo "[suspend] hint: unix stream peer outside checkpoint tree." >&2
      elif run_as_root grep -q 'anon_inode:\[io_uring\]' "${dir}/dump.log"; then
        echo "[suspend] hint: io_uring mappings present; set kernel.io_uring_disabled=2 first." >&2
      fi
      echo "[suspend] dump log tail:" >&2
      run_as_root tail -n 60 "${dir}/dump.log" >&2 || true
    fi
    exit "${rc}"
  fi

  if [[ ! -s "${dir}/inventory.img" ]]; then
    echo "error: checkpoint missing inventory.img (incomplete)" >&2
    exit 1
  fi

  echo "[suspend] CRIU dump complete; stopping process tree"
  stop_tree "${XPRA_PID}"

  echo "[suspend] done"
  echo "[suspend] files: ${dir}"
}

case "${MODE}" in
  freeze) do_freeze ;;
  checkpoint) do_checkpoint ;;
  *)
    echo "error: unknown MODE='${MODE}' (expected freeze|checkpoint)" >&2
    exit 2
    ;;
esac
