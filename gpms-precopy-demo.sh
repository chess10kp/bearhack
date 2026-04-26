#!/usr/bin/env bash
# CRIU page-server pre-copy live migration demo (Machine A --> Machine B)
#
# Roles:
#   MACHINE_A (this host)  : runs xpra + child app, drives the migration
#   MACHINE_B (remote host): runs gpms-worker + criu page-server, hosts restore
#
# Hardcoded for the hackathon — no service discovery, just env config.
#
# Quick start (two terminals):
#
#   On Machine B:
#     cd worker && npm install && WORKER_HOST=0.0.0.0 npm start
#     # also: open SSH back to Machine A so we can tunnel the page-server port
#
#   On Machine A:
#     export MACHINE_B_HOST=10.0.0.42
#     export MACHINE_B_USER=jac
#     export WORKER_URL=http://${MACHINE_B_HOST}:3400
#     ./gpms-precopy-demo.sh up         # start xpra + child app, wait until ready
#     ./gpms-precopy-demo.sh tunnel     # ssh -L for page-server port
#     ./gpms-precopy-demo.sh migrate    # run the precopy migration
#     ./gpms-precopy-demo.sh attach     # xpra attach to Machine B
#
#     # if the page-server flakes:
#     ./gpms-precopy-demo.sh migrate-fallback

set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-110}"
DISPLAY_ID=":${DISPLAY_NUM}"
CHILD_CMD="${CHILD_CMD:-xterm -e 'while true; do date; sleep 1; done'}"
TCP_PORT="${TCP_PORT:-14600}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"

PAGE_PORT="${PAGE_PORT:-1234}"
MACHINE_B_HOST="${MACHINE_B_HOST:-127.0.0.1}"
MACHINE_B_USER="${MACHINE_B_USER:-$USER}"
WORKER_URL="${WORKER_URL:-http://${MACHINE_B_HOST}:3400}"
WORKER_TOKEN="${WORKER_TOKEN:-}"
ITERATIONS="${ITERATIONS:-3}"
MIGRATION_ID="${MIGRATION_ID:-mig-$(date +%s)}"
LOCAL_PAGE_HOST="${LOCAL_PAGE_HOST:-127.0.0.1}"   # via SSH tunnel
WORKDIR="${WORKDIR:-/tmp/gpms-precopy-demo}"
LOGDIR="${WORKDIR}/logs"
TUNNEL_PIDFILE="${WORKDIR}/tunnel.pid"

mkdir -p "${LOGDIR}"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
require xpra
require ssh
require node
require curl

xpra_info() { xpra info "${DISPLAY_ID}" 2>/dev/null || true; }

session_pid() {
  local pid
  pid="$(xpra_info | awk -F= '/^windows\.[0-9]+\.wm-pid=/{print $2; exit}')"
  if [[ -z "${pid}" ]]; then
    pid="$(xpra_info | awk -F= '/^command\.[0-9]+\.pid=/{print $2; exit}')"
  fi
  echo "${pid}"
}

up() {
  echo "[up] starting xpra ${DISPLAY_ID} with: ${CHILD_CMD}"
  xpra stop "${DISPLAY_ID}" >/dev/null 2>&1 || true
  xpra start "${DISPLAY_ID}" \
    --daemon=yes \
    --start="${CHILD_CMD}" \
    --bind-tcp="${BIND_ADDR}:${TCP_PORT}" \
    --html=on --webcam=no --mdns=no --pulseaudio=no \
    --notifications=no --printing=no --file-transfer=no --dbus=no \
    >"${LOGDIR}/xpra-start.log" 2>&1
  for _ in $(seq 1 30); do
    sleep 1
    [[ -n "$(session_pid)" ]] && break
  done
  local pid
  pid="$(session_pid)"
  if [[ -z "${pid}" ]]; then
    echo "[up] failed: no child pid" >&2
    tail -n 80 "${LOGDIR}/xpra-start.log" >&2 || true
    exit 1
  fi
  echo "[up] xpra ready, child pid=${pid}"
  echo "${pid}" >"${WORKDIR}/child.pid"
}

tunnel() {
  if [[ -f "${TUNNEL_PIDFILE}" ]] && kill -0 "$(cat "${TUNNEL_PIDFILE}")" 2>/dev/null; then
    echo "[tunnel] already running pid=$(cat "${TUNNEL_PIDFILE}")"
    return 0
  fi
  echo "[tunnel] ssh -L ${PAGE_PORT}:127.0.0.1:${PAGE_PORT} ${MACHINE_B_USER}@${MACHINE_B_HOST}"
  ssh -N -L "${PAGE_PORT}:127.0.0.1:${PAGE_PORT}" \
      -o ServerAliveInterval=10 -o ExitOnForwardFailure=yes \
      "${MACHINE_B_USER}@${MACHINE_B_HOST}" \
      >"${LOGDIR}/tunnel.log" 2>&1 &
  echo $! >"${TUNNEL_PIDFILE}"
  sleep 2
  if ! kill -0 "$(cat "${TUNNEL_PIDFILE}")" 2>/dev/null; then
    echo "[tunnel] failed:" >&2
    cat "${LOGDIR}/tunnel.log" >&2 || true
    exit 1
  fi
  echo "[tunnel] up (pid=$(cat "${TUNNEL_PIDFILE}"))"
}

tunnel_down() {
  if [[ -f "${TUNNEL_PIDFILE}" ]]; then
    kill "$(cat "${TUNNEL_PIDFILE}")" 2>/dev/null || true
    rm -f "${TUNNEL_PIDFILE}"
    echo "[tunnel] stopped"
  fi
}

worker_ping() {
  curl -fsS "${WORKER_URL}/health" || { echo "[worker] not reachable at ${WORKER_URL}" >&2; exit 1; }
  echo
}

migrate() {
  worker_ping
  local pid
  pid="$(cat "${WORKDIR}/child.pid" 2>/dev/null || session_pid)"
  if [[ -z "${pid}" ]]; then echo "[migrate] no pid" >&2; exit 1; fi
  echo "[migrate] pid=${pid} migration=${MIGRATION_ID} iter=${ITERATIONS}"
  local t0 t1
  t0=$(date +%s%3N)
  ( cd client && sudo -E node index.js migrate-live \
      --pid "${pid}" \
      --worker "${WORKER_URL}" \
      --page-host "${LOCAL_PAGE_HOST}" \
      --page-port "${PAGE_PORT}" \
      --iterations "${ITERATIONS}" \
      --migration-id "${MIGRATION_ID}" \
      ${WORKER_TOKEN:+--token "${WORKER_TOKEN}"} ) | tee "${LOGDIR}/migrate-${MIGRATION_ID}.json"
  t1=$(date +%s%3N)
  echo "[migrate] total wall time: $(( t1 - t0 )) ms"
}

migrate_fallback() {
  worker_ping
  local pid
  pid="$(cat "${WORKDIR}/child.pid" 2>/dev/null || session_pid)"
  if [[ -z "${pid}" ]]; then echo "[migrate] no pid" >&2; exit 1; fi
  echo "[migrate-fallback] pid=${pid} migration=${MIGRATION_ID}"
  ( cd client && sudo -E node index.js migrate-live \
      --pid "${pid}" \
      --worker "${WORKER_URL}" \
      --page-host "${LOCAL_PAGE_HOST}" \
      --page-port "${PAGE_PORT}" \
      --migration-id "${MIGRATION_ID}" \
      --fallback \
      ${WORKER_TOKEN:+--token "${WORKER_TOKEN}"} ) | tee "${LOGDIR}/migrate-${MIGRATION_ID}.json"
}

attach() {
  echo "[attach] xpra attach tcp://${MACHINE_B_HOST}:${TCP_PORT}/"
  xpra attach "tcp://${MACHINE_B_HOST}:${TCP_PORT}/" \
    --opengl=force --notifications=no --speaker=off --microphone=off --webcam=no
}

down() {
  tunnel_down
  xpra stop "${DISPLAY_ID}" >/dev/null 2>&1 || true
  rm -f "${WORKDIR}/child.pid"
  echo "[down] cleaned up"
}

usage() {
  cat <<USAGE
Usage: $0 <command>

Commands:
  up                start xpra + child on this machine
  tunnel            open ssh -L tunnel for page-server port
  tunnel-down       close tunnel
  migrate           run CRIU page-server pre-copy migration to Machine B
  migrate-fallback  rsync-style fallback (local dump + tar upload + restore)
  attach            xpra attach to Machine B
  down              stop xpra + tunnel

Env:
  MACHINE_B_HOST=$MACHINE_B_HOST
  MACHINE_B_USER=$MACHINE_B_USER
  WORKER_URL=$WORKER_URL
  PAGE_PORT=$PAGE_PORT
  ITERATIONS=$ITERATIONS
  MIGRATION_ID=$MIGRATION_ID
  CHILD_CMD=$CHILD_CMD
USAGE
}

case "${1:-}" in
  up) up ;;
  tunnel) tunnel ;;
  tunnel-down) tunnel_down ;;
  migrate) migrate ;;
  migrate-fallback) migrate_fallback ;;
  attach) attach ;;
  down) down ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown: $1" >&2; usage; exit 2 ;;
esac
