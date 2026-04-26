#!/usr/bin/env bash
set -euo pipefail

# gpms-resume.sh
#
# Default mode: real resume by sending SIGCONT to the process tree that
#   gpms-suspend.sh recorded into a state directory.
#   - Verifies every still-alive PID returns to a runnable state (S/R/D).
#   - Works for any GUI app, including VSCode/Electron.
#
# Optional mode: MODE=checkpoint runs CRIU restore from a checkpoint dir.

SESSION="${SESSION:-110}"
UIDN="$(id -u)"
MODE="${MODE:-}"

STATE_ROOT="${STATE_ROOT:-/var/tmp/gpms/suspends}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/var/tmp/gpms/checkpoints}"

VERIFY_SECONDS="${VERIFY_SECONDS:-3}"
VERIFY_POLL_SECONDS="${VERIFY_POLL_SECONDS:-0.2}"

# CRIU-restore-only options
CLEAN_STALE="${CLEAN_STALE:-1}"
CONNECT_URI="${CONNECT_URI:-tcp://127.0.0.1:14600/}"
ATTACH_OPENGL="${ATTACH_OPENGL:-force}"
RESTART_APP_IF_NO_WINDOWS="${RESTART_APP_IF_NO_WINDOWS:-1}"
WINDOW_RECHECK_SECONDS="${WINDOW_RECHECK_SECONDS:-5}"

usage() {
  cat <<'USAGE'
Usage:
  gpms-resume.sh [state_or_checkpoint_dir] [session]

If the directory is omitted the script auto-detects:
  1) MODE=freeze     -> /var/tmp/gpms/suspends/xpra-<session>-latest
                    or /var/tmp/gpms/suspends/latest
  2) MODE=checkpoint -> /var/tmp/gpms/checkpoints/xpra-<session>-latest
                    or /var/tmp/gpms/checkpoints/latest

If MODE is unset the script picks MODE based on the dir's metadata.env.

Env:
  SESSION=110
  STATE_ROOT=/var/tmp/gpms/suspends
  CHECKPOINT_ROOT=/var/tmp/gpms/checkpoints
  VERIFY_SECONDS=3
  VERIFY_POLL_SECONDS=0.2
  CLEAN_STALE=1                 (checkpoint mode only)
  CONNECT_URI=tcp://127.0.0.1:14600/
  ATTACH_OPENGL=force
  RESTART_APP_IF_NO_WINDOWS=1
  WINDOW_RECHECK_SECONDS=5

Examples:
  ./gpms-resume.sh                              # auto-detect freeze
  ./gpms-resume.sh /var/tmp/gpms/suspends/...   # explicit dir
  MODE=checkpoint ./gpms-resume.sh              # CRIU restore
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

DIR="${1:-}"
if [[ -n "${2:-}" ]]; then
  SESSION="$2"
fi

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

proc_state() {
  local pid="$1"
  awk '/^State:/{print $2; exit}' "/proc/${pid}/status" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Resolve dir + mode
# ---------------------------------------------------------------------------
resolve_dir_for_mode() {
  local m="$1"
  local root link latest
  if [[ "${m}" == "freeze" ]]; then
    root="${STATE_ROOT}"
  else
    root="${CHECKPOINT_ROOT}"
  fi
  link="${root}/xpra-${SESSION}-latest"
  latest="${root}/latest"
  if [[ -L "${link}" || -d "${link}" ]]; then
    readlink -f "${link}"
    return 0
  fi
  if [[ -f "${latest}" ]]; then
    cat "${latest}"
    return 0
  fi
  return 1
}

if [[ -z "${DIR}" ]]; then
  if [[ -n "${MODE}" ]]; then
    DIR="$(resolve_dir_for_mode "${MODE}" || true)"
  else
    DIR="$(resolve_dir_for_mode freeze || true)"
    if [[ -z "${DIR}" ]]; then
      DIR="$(resolve_dir_for_mode checkpoint || true)"
    fi
  fi
fi

if [[ -z "${DIR}" ]]; then
  echo "error: no state/checkpoint dir provided and none found" >&2
  echo "       searched: ${STATE_ROOT}/xpra-${SESSION}-latest, ${STATE_ROOT}/latest" >&2
  echo "                 ${CHECKPOINT_ROOT}/xpra-${SESSION}-latest, ${CHECKPOINT_ROOT}/latest" >&2
  exit 1
fi

if [[ ! -d "${DIR}" ]]; then
  echo "error: directory not found: ${DIR}" >&2
  exit 1
fi

# Pull MODE from metadata.env if not explicit.
if [[ -z "${MODE}" ]]; then
  if [[ -f "${DIR}/metadata.env" ]]; then
    MODE="$(awk -F= '/^MODE=/{print $2; exit}' "${DIR}/metadata.env")"
  fi
  MODE="${MODE:-freeze}"
fi

# Pull session from metadata if user did not override.
if [[ "${SESSION}" == "110" && -f "${DIR}/metadata.env" ]]; then
  meta_session="$(awk -F= '/^SESSION=/{print $2; exit}' "${DIR}/metadata.env" || true)"
  if [[ -n "${meta_session:-}" ]]; then
    SESSION="${meta_session}"
  fi
fi

# ---------------------------------------------------------------------------
# Mode: freeze (real resume via SIGCONT)
# ---------------------------------------------------------------------------
do_freeze_resume() {
  local state_file="${DIR}/pids.txt"
  if [[ ! -s "${state_file}" ]]; then
    echo "error: state file not found or empty: ${state_file}" >&2
    exit 1
  fi

  local pids=()
  local pid _rest
  while IFS=$'\t' read -r pid _rest; do
    [[ -z "${pid}" ]] && continue
    pids+=("${pid}")
  done <"${state_file}"

  if ((${#pids[@]} == 0)); then
    echo "error: no pids recorded in ${state_file}" >&2
    exit 1
  fi

  echo "[resume] mode=freeze session=${SESSION} state=${DIR}"
  echo "[resume] tree size=${#pids[@]} pids"

  # Sanity-check at least one of the captured pids still exists.
  local alive=0
  for pid in "${pids[@]}"; do
    if [[ -d "/proc/${pid}" ]]; then
      alive=$((alive + 1))
    fi
  done
  if (( alive == 0 )); then
    echo "error: none of the recorded pids are alive; tree is gone" >&2
    echo "       this state file cannot be resumed" >&2
    exit 2
  fi
  echo "[resume] ${alive}/${#pids[@]} captured pids still alive"

  # Continue children-first (reverse) so parents do not race ahead of
  # signal delivery to descendants.
  local i
  for ((i=${#pids[@]}-1; i>=0; i--)); do
    kill -CONT "${pids[i]}" 2>/dev/null || true
  done

  # Verify: every still-alive pid is no longer T/t.
  local waited=0 ok all_running=1 stuck=()
  ok=0
  while awk -v w="${waited}" -v lim="${VERIFY_SECONDS}" 'BEGIN{exit !(w<lim)}'; do
    all_running=1
    stuck=()
    for pid in "${pids[@]}"; do
      [[ ! -d "/proc/${pid}" ]] && continue
      st="$(proc_state "${pid}")"
      case "${st}" in
        T|t)
          all_running=0
          stuck+=("${pid}:${st}")
          ;;
      esac
    done
    if (( all_running == 1 )); then
      ok=1
      break
    fi
    sleep "${VERIFY_POLL_SECONDS}"
    waited="$(awk -v w="${waited}" -v p="${VERIFY_POLL_SECONDS}" 'BEGIN{print w+p}')"
  done

  {
    echo "# post-resume states"
    for pid in "${pids[@]}"; do
      st="$(proc_state "${pid}" || true)"
      printf '%s\t%s\n' "${pid}" "${st:-gone}"
    done
  } >"${DIR}/post-resume-states.txt"

  if (( ok != 1 )); then
    echo "error: pids still in T/t state after ${VERIFY_SECONDS}s: ${stuck[*]}" >&2
    exit 1
  fi

  echo "[resume] all alive processes are running again"
  echo "[resume] state log: ${DIR}/post-resume-states.txt"

  local windows app_cmd
  windows="$(xpra info ":${SESSION}" 2>/dev/null | awk -F= '/^state\.windows=/{w=$2} END{print w+0}' || true)"
  windows="${windows:-0}"
  if [[ "${windows}" == "0" ]]; then
    echo "[resume] warning: session has 0 windows after resume"
    app_cmd=""
    if [[ -f "${DIR}/metadata.env" ]]; then
      app_cmd="$(awk -F= '/^APP_CMD=/{print substr($0, index($0, "=")+1)}' "${DIR}/metadata.env" || true)"
    fi
    app_cmd="${app_cmd:-unknown}"
    if [[ "${RESTART_APP_IF_NO_WINDOWS}" == "1" ]] && [[ "${app_cmd}" != "unknown" ]]; then
      echo "[resume] attempting to relaunch app: ${app_cmd}"
      xpra control ":${SESSION}" start-child "${app_cmd}" >/dev/null 2>&1 || true
      sleep "${WINDOW_RECHECK_SECONDS}"
      windows="$(xpra info ":${SESSION}" 2>/dev/null | awk -F= '/^state\.windows=/{w=$2} END{print w+0}' || true)"
      windows="${windows:-0}"
      echo "[resume] state.windows=${windows}"
      if [[ "${windows}" == "0" ]]; then
        echo "[resume] hint: manual relaunch: xpra control :${SESSION} start-child '${app_cmd}'"
      fi
    else
      echo "[resume] hint: relaunch app: xpra control :${SESSION} start-child '${app_cmd}'"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Mode: checkpoint (CRIU restore)
# ---------------------------------------------------------------------------
do_criu_restore() {
  if [[ ! -s "${DIR}/inventory.img" ]]; then
    echo "error: checkpoint is incomplete (missing ${DIR}/inventory.img)" >&2
    if [[ -f "${DIR}/dump.log" ]]; then
      echo "[resume] dump log tail:" >&2
      run_as_root tail -n 80 "${DIR}/dump.log" >&2 || true
    fi
    exit 1
  fi

  if [[ -f "${DIR}/dump.log" ]] \
       && run_as_root grep -q 'Dumping FAILED' "${DIR}/dump.log"; then
    echo "error: checkpoint dump failed according to ${DIR}/dump.log" >&2
    run_as_root tail -n 80 "${DIR}/dump.log" >&2 || true
    exit 1
  fi

  if [[ "${CLEAN_STALE}" == "1" ]]; then
    echo "[resume] cleaning stale session state for :${SESSION}"
    xpra stop ":${SESSION}" >/dev/null 2>&1 || true
    rm -f "/run/user/${UIDN}/xpra/goobtop-${SESSION}" \
          "${HOME}/.xpra/goobtop-${SESSION}" 2>/dev/null || true
    rm -f "/run/user/${UIDN}/xpra/${SESSION}/socket" 2>/dev/null || true
  fi

  local session_dir="/run/user/${UIDN}/xpra/${SESSION}"
  mkdir -p "${session_dir}"
  if [[ ! -f "${session_dir}/server.log" ]] \
       && [[ -f "${DIR}/server.log.seed" ]]; then
    cp -a "${DIR}/server.log.seed" "${session_dir}/server.log" 2>/dev/null || true
  fi

  echo "[resume] mode=checkpoint session=${SESSION} from ${DIR}"
  set +e
  run_as_root env XDG_RUNTIME_DIR="/run/user/${UIDN}" criu restore \
    -D "${DIR}" \
    --restore-detached \
    -o restore.log \
    -v4 -j \
    --shell-job \
    --tcp-established \
    --ext-unix-sk \
    --file-locks
  local rc=$?
  set -e

  if (( rc != 0 )); then
    echo "error: CRIU restore failed with code ${rc}" >&2
    if [[ -f "${DIR}/restore.log" ]]; then
      echo "[resume] restore log tail:" >&2
      run_as_root tail -n 120 "${DIR}/restore.log" >&2 || true
    fi
    exit "${rc}"
  fi

  echo "[resume] done"
  echo "[resume] restore log: ${DIR}/restore.log"
  echo "[resume] attach: xpra attach ${CONNECT_URI} --opengl=${ATTACH_OPENGL} --notifications=no --speaker=off --microphone=off --webcam=no --printing=no --reconnect=no"
}

case "${MODE}" in
  freeze) do_freeze_resume ;;
  checkpoint) do_criu_restore ;;
  *)
    echo "error: unknown MODE='${MODE}' (expected freeze|checkpoint)" >&2
    exit 2
    ;;
esac
