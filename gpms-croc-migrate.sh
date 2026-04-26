#!/usr/bin/env bash
# Croc-based CRIU process migration (bidirectional).
#
# Same script on both machines. Flow:
#   Machine A:  ./gpms-croc-migrate.sh send <pid>
#   Machine B:  ./gpms-croc-migrate.sh receive
#               # process resumes on B with a new PID, gets past the hang
#   Machine B:  ./gpms-croc-migrate.sh send <new-pid>
#   Machine A:  ./gpms-croc-migrate.sh receive
#
# Croc handles transport (NAT-traversing relay; no logins, no IPs).
# A shared CODE pairs sender + receiver — hardcode it for the demo.

set -euo pipefail

CRIU_BIN="${CRIU_BIN:-/usr/sbin/criu}"
WORKDIR="${WORKDIR:-/tmp/gpms-croc}"
CODE="${CODE:-gpms-bearhack-demo}"
RESTORE_TIMEOUT="${RESTORE_TIMEOUT:-60}"

mkdir -p "${WORKDIR}"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
require croc
require tar
require zstd
[[ -x "${CRIU_BIN}" ]] || { echo "missing CRIU at ${CRIU_BIN}" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 <command> [args]

Commands:
  send <pid> [migration-id]      Checkpoint the pid tree, tar, croc send
                                 (CRIU kills the original on this host)
  send-running <pid> [id]        Same but --leave-running (testing only;
                                 you'll have two copies running)
  receive [migration-id]         croc receive, untar, criu restore
  clean                          rm -rf ${WORKDIR}

Env:
  CODE=${CODE}             croc code phrase (must match on both sides)
  WORKDIR=${WORKDIR}
  CRIU_BIN=${CRIU_BIN}
  RESTORE_TIMEOUT=${RESTORE_TIMEOUT}   seconds to wait for criu restore
EOF
}

dump_and_send() {
  local pid="${1:?pid required}"
  local id="${2:-mig-$(date +%s)}"
  local leave_running="${3:-no}"
  local dir="${WORKDIR}/${id}"

  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "[send] pid ${pid} not alive" >&2
    exit 1
  fi

  rm -rf "${dir}"
  mkdir -p "${dir}"

  echo "[send] dump migration=${id} pid=${pid} -> ${dir}"
  local args=(dump -t "${pid}" -D "${dir}" --shell-job
              --log-file dump.log -v4)
  [[ "${leave_running}" == "yes" ]] && args+=(--leave-running)

  local t0 t1
  t0=$(date +%s%3N)
  if ! sudo "${CRIU_BIN}" "${args[@]}"; then
    echo "[send] criu dump failed; tail of log:" >&2
    sudo tail -n 80 "${dir}/dump.log" >&2 || true
    exit 1
  fi
  t1=$(date +%s%3N)
  echo "[send] dump ok ($((t1 - t0)) ms)"

  local tar="${WORKDIR}/${id}.tar.zst"
  rm -f "${tar}"
  echo "[send] compressing -> ${tar}"
  sudo tar --use-compress-program='zstd -T0 -3' \
    -cf "${tar}" -C "${WORKDIR}" "${id}"
  sudo chown "${USER}:${USER}" "${tar}"
  local size
  size=$(stat -c%s "${tar}")
  echo "[send] tar size: $((size / 1024)) KiB"

  echo "[send] croc send (code=${CODE})"
  croc --yes send --code "${CODE}" "${tar}"
  echo "[send] migration ${id} sent"
}

receive_and_restore() {
  local want_id="${1:-}"

  echo "[recv] croc receive (code=${CODE}) -> ${WORKDIR}"
  ( cd "${WORKDIR}" && croc --yes --overwrite "${CODE}" )

  local tar
  if [[ -n "${want_id}" && -f "${WORKDIR}/${want_id}.tar.zst" ]]; then
    tar="${WORKDIR}/${want_id}.tar.zst"
  else
    tar=$(ls -1t "${WORKDIR}"/*.tar.zst 2>/dev/null | head -n1 || true)
  fi
  [[ -n "${tar}" ]] || { echo "[recv] no tar in ${WORKDIR}" >&2; exit 1; }
  echo "[recv] received: ${tar}"

  local id
  id=$(basename "${tar}" .tar.zst)
  local dir="${WORKDIR}/${id}"
  sudo rm -rf "${dir}"
  sudo tar --use-compress-program=zstd -xf "${tar}" -C "${WORKDIR}"
  echo "[recv] extracted -> ${dir}"

  echo "[recv] criu restore (detached)"
  # Detach so the restored process outlives this script.
  sudo setsid -f "${CRIU_BIN}" restore -D "${dir}" --shell-job \
    --log-file restore.log -v4 \
    </dev/null >/dev/null 2>&1 &
  disown || true

  local i new_pid=""
  for i in $(seq 1 "${RESTORE_TIMEOUT}"); do
    sleep 1
    if sudo grep -qE 'Restored .* with pid' "${dir}/restore.log" 2>/dev/null; then
      new_pid=$(sudo grep -oE 'with pid[[:space:]]+[0-9]+' "${dir}/restore.log" \
                | tail -n1 | awk '{print $NF}')
      break
    fi
    if sudo grep -qE 'Error|FATAL' "${dir}/restore.log" 2>/dev/null; then
      echo "[recv] restore failed; tail of log:" >&2
      sudo tail -n 80 "${dir}/restore.log" >&2 || true
      exit 1
    fi
  done

  if [[ -z "${new_pid}" ]]; then
    echo "[recv] restore did not report success in ${RESTORE_TIMEOUT}s" >&2
    sudo tail -n 80 "${dir}/restore.log" >&2 || true
    exit 1
  fi

  echo "[recv] restored migration=${id} new_pid=${new_pid}"
  echo "[recv] to migrate back: $0 send ${new_pid}"
}

case "${1:-}" in
  send)         shift; dump_and_send "${1:-}" "${2:-}" no ;;
  send-running) shift; dump_and_send "${1:-}" "${2:-}" yes ;;
  receive|recv) shift; receive_and_restore "${1:-}" ;;
  clean) rm -rf "${WORKDIR}"; echo "cleaned ${WORKDIR}" ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown: $1" >&2; usage; exit 2 ;;
esac
