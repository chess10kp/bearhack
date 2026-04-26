#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-110}"
DISPLAY_ID=":${DISPLAY_NUM}"
CHILD_CMD="${CHILD_CMD:-code --new-window --ozone-platform=x11 --disable-gpu --no-sandbox --user-data-dir=/tmp/vscode-xpra-profile}"
WORKDIR="${WORKDIR:-/tmp/gpms-xpra-mvp}"
LOGDIR="${WORKDIR}/logs"
TCP_PORT="${TCP_PORT:-14600}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
START_MODE="${START_MODE:-start}"
EXIT_WITH_CHILDREN="${EXIT_WITH_CHILDREN:-no}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-60}"
STARTUP_POLL_SECONDS="${STARTUP_POLL_SECONDS:-1}"
POST_START_WAIT_SECONDS="${POST_START_WAIT_SECONDS:-0}"
READY_REQUIRE_WINDOWS="${READY_REQUIRE_WINDOWS:-1}"
ATTACH_SECONDS="${ATTACH_SECONDS:-4}"
ATTACH_RETRIES="${ATTACH_RETRIES:-2}"
ATTACH_RETRY_WAIT_SECONDS="${ATTACH_RETRY_WAIT_SECONDS:-1}"
ATTACH_OPENGL="${ATTACH_OPENGL:-force}"
CONNECT_URI="tcp://${BIND_ADDR}:${TCP_PORT}/"

mkdir -p "${LOGDIR}"

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: missing required binary: $1" >&2
    exit 1
  }
}

require_bin xpra
require_bin ps
require_bin awk

display_paths_cleanup() {
  local user_run
  user_run="/run/user/$(id -u)/xpra"
  rm -f "${HOME}/.xpra"/*-"${DISPLAY_NUM}" 2>/dev/null || true
  rm -f "${user_run}"/*-"${DISPLAY_NUM}" 2>/dev/null || true
  rm -rf "${user_run}/${DISPLAY_NUM}" 2>/dev/null || true
}

session_info() {
  xpra info "${DISPLAY_ID}" 2>/dev/null || return 1
}

server_log_path() {
  echo "/run/user/$(id -u)/xpra/${DISPLAY_NUM}/server.log"
}

wait_for_session_ready() {
  local waited info_file windows
  waited=0
  info_file="${LOGDIR}/info-${DISPLAY_NUM}.tmp"
  echo "[start] waiting up to ${STARTUP_TIMEOUT}s for xpra session to be ready"

  while (( waited < STARTUP_TIMEOUT )); do
    if session_info >"${info_file}"; then
      windows="$(awk -F= '/^state\.windows=/{print $2; exit}' "${info_file}")"
      windows="${windows:-0}"
      if [[ "${READY_REQUIRE_WINDOWS}" == "1" ]]; then
        if [[ "${windows}" =~ ^[0-9]+$ ]] && (( windows > 0 )); then
          rm -f "${info_file}"
          return 0
        fi
      else
        if grep -q '^command\.[0-9]\+\.dead=False' "${info_file}" || { [[ "${windows}" =~ ^[0-9]+$ ]] && (( windows > 0 )); }; then
          rm -f "${info_file}"
          return 0
        fi
      fi
    fi
    sleep "${STARTUP_POLL_SECONDS}"
    waited=$((waited + STARTUP_POLL_SECONDS))
  done

  rm -f "${info_file}"
  echo "[start] error: xpra session did not become ready within ${STARTUP_TIMEOUT}s" >&2
  if [[ -f "$(server_log_path)" ]]; then
    echo "[start] tail of server log:"
    tail -n 120 "$(server_log_path)" || true
  fi
  return 1
}

get_target_pid() {
  local info_file pid
  info_file="${LOGDIR}/pid-${DISPLAY_NUM}.tmp"
  if ! session_info >"${info_file}"; then
    rm -f "${info_file}"
    return 1
  fi

  while IFS= read -r pid; do
    if [[ "${pid}" =~ ^[0-9]+$ ]] && ps -p "${pid}" >/dev/null 2>&1; then
      echo "${pid}"
      rm -f "${info_file}"
      return 0
    fi
  done < <(awk -F= '/^windows\.[0-9]+\.wm-pid=/{print $2}' "${info_file}")

  while IFS= read -r pid; do
    if [[ "${pid}" =~ ^[0-9]+$ ]] && ps -p "${pid}" >/dev/null 2>&1; then
      echo "${pid}"
      rm -f "${info_file}"
      return 0
    fi
  done < <(awk -F= '/^command\.[0-9]+\.pid=/{print $2}' "${info_file}")

  rm -f "${info_file}"
  return 1
}

start_session() {
  local start_flag
  echo "[start] stopping stale session on ${DISPLAY_ID} (if any)"
  xpra stop "${DISPLAY_ID}" >"${LOGDIR}/stop-${DISPLAY_NUM}.log" 2>&1 || true
  display_paths_cleanup

  if [[ "${START_MODE}" == "start-child" ]]; then
    start_flag="--start-child=${CHILD_CMD}"
  else
    start_flag="--start=${CHILD_CMD}"
  fi

  echo "[start] starting xpra on ${DISPLAY_ID} with ${START_MODE}: ${CHILD_CMD}"
  xpra start "${DISPLAY_ID}" \
    --daemon=yes \
    --exit-with-children="${EXIT_WITH_CHILDREN}" \
    "${start_flag}" \
    --bind-tcp="${BIND_ADDR}:${TCP_PORT}" \
    --html=on \
    --webcam=no \
    --mdns=no \
    --pulseaudio=no \
    --notifications=no \
    --printing=no \
    --file-transfer=no \
    --dbus=no \
    >"${LOGDIR}/start-${DISPLAY_NUM}.log" 2>&1

  wait_for_session_ready
  if (( POST_START_WAIT_SECONDS > 0 )); then
    sleep "${POST_START_WAIT_SECONDS}"
  fi
  echo "[start] session summary:"
  session_info | egrep 'state.windows|command.[0-9]+.pid|command.[0-9]+.dead|clients=' || true
  echo "[start] HTML5 client: http://${BIND_ADDR}:${TCP_PORT}/"
  echo "[start] native attach: xpra attach ${CONNECT_URI} --opengl=${ATTACH_OPENGL} --notifications=no --speaker=off --microphone=off --webcam=no"
}

status_session() {
  echo "[status] ${DISPLAY_ID}"
  session_info | egrep 'state.windows|command.[0-9]+.pid|command.[0-9]+.dead|clients=' || {
    echo "[status] session not reachable" >&2
    exit 1
  }
}

attach_once() {
  local sec rc
  sec="${1:-${ATTACH_SECONDS}}"
  echo "[attach] connecting for ${sec}s"
  set +e
  timeout "${sec}"s xpra attach "${CONNECT_URI}" --opengl="${ATTACH_OPENGL}" --notifications=no --speaker=off --microphone=off --webcam=no \
    >"${LOGDIR}/attach-${DISPLAY_NUM}-$(date +%s).log" 2>&1
  rc=$?
  set -e
  if [[ ${rc} -eq 0 || ${rc} -eq 124 ]]; then
    return 0
  fi
  echo "[attach] warning: attach failed with code ${rc}" >&2
  return ${rc}
}

resume_test() {
  local i ok
  echo "[resume-test] attach -> disconnect -> attach"

  ok=0
  for i in $(seq 1 "${ATTACH_RETRIES}"); do
    if attach_once "${ATTACH_SECONDS}"; then
      ok=1
      break
    fi
    sleep "${ATTACH_RETRY_WAIT_SECONDS}"
  done
  if [[ ${ok} -ne 1 ]]; then
    echo "[resume-test] error: failed first attach phase" >&2
    return 1
  fi

  ok=0
  for i in $(seq 1 "${ATTACH_RETRIES}"); do
    if attach_once "${ATTACH_SECONDS}"; then
      ok=1
      break
    fi
    sleep "${ATTACH_RETRY_WAIT_SECONDS}"
  done
  if [[ ${ok} -ne 1 ]]; then
    echo "[resume-test] error: failed second attach phase" >&2
    return 1
  fi

  status_session
}

freeze_test() {
  local pid state1 state2
  pid="$(get_target_pid || true)"
  if [[ -z "${pid}" ]]; then
    echo "[freeze-test] unable to find target pid" >&2
    exit 1
  fi

  echo "[freeze-test] target pid=${pid}"
  kill -STOP "${pid}"
  sleep 1
  state1="$(ps -o stat= -p "${pid}" | tr -d ' ')"
  echo "[freeze-test] state_after_stop=${state1}"

  kill -CONT "${pid}"
  sleep 1
  state2="$(ps -o stat= -p "${pid}" | tr -d ' ')"
  echo "[freeze-test] state_after_cont=${state2}"

  status_session
}

stop_session() {
  echo "[stop] stopping ${DISPLAY_ID}"
  xpra stop "${DISPLAY_ID}" >"${LOGDIR}/stop-${DISPLAY_NUM}.log" 2>&1 || true
  display_paths_cleanup
  echo "[stop] done"
}

full_test() {
  start_session
  resume_test
  freeze_test
  echo "[full-test] PASS"
}

usage() {
  cat <<'USAGE'
Usage:
  gpms-xpra-mvp.sh start
  gpms-xpra-mvp.sh status
  gpms-xpra-mvp.sh resume-test
  gpms-xpra-mvp.sh freeze-test
  gpms-xpra-mvp.sh full-test
  gpms-xpra-mvp.sh stop

Env overrides:
  DISPLAY_NUM=110
  CHILD_CMD='code'
  START_MODE=start            Use 'start' for apps that daemonize (eg vscode), 'start-child' otherwise
  EXIT_WITH_CHILDREN=no       Use 'yes' when using start-child and you want server to exit with app
  TCP_PORT=14600
  BIND_ADDR=127.0.0.1
  ATTACH_OPENGL=force

Recommended for VSCode:
  CHILD_CMD='code --new-window --ozone-platform=x11 --disable-gpu --no-sandbox --user-data-dir=/tmp/vscode-xpra-profile' START_MODE=start EXIT_WITH_CHILDREN=no ./gpms-xpra-mvp.sh start
USAGE
}

main() {
  local cmd
  cmd="${1:-}"
  case "${cmd}" in
    start) start_session ;;
    status) status_session ;;
    resume-test) resume_test ;;
    freeze-test) freeze_test ;;
    full-test) full_test ;;
    stop) stop_session ;;
    -h|--help|help|"") usage ;;
    *)
      echo "error: unknown command: ${cmd}" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
