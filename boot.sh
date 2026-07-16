#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4310}"
PID_FILE="${NYXID_CHAT_PID_FILE:-${ROOT_DIR}/.nyxid-chat.pid}"
LOG_FILE="${NYXID_CHAT_LOG_FILE:-${ROOT_DIR}/.nyxid-chat.log}"
LAUNCH_LABEL="${NYXID_CHAT_LAUNCH_LABEL:-ai.chrono.nyxid-chat.${UID}.${PORT}}"
USE_LAUNCHD=false

if [[ "$(uname -s)" == "Darwin" && -x /bin/launchctl ]]; then
  USE_LAUNCHD=true
fi

fail() {
  printf 'boot.sh: %s\n' "$*" >&2
  exit 1
}

for command_name in node curl lsof ps; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing required command: ${command_name}"
done

[[ "${PORT}" =~ ^[0-9]+$ ]] || fail "PORT must be numeric: ${PORT}"
(( PORT >= 1 && PORT <= 65535 )) || fail "PORT must be between 1 and 65535"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || fail "Node.js 20 or newer is required"

is_repo_server() {
  local pid="$1"
  local process_cwd process_command

  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  process_cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  process_command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"

  [[ ("${process_cwd}" == "${ROOT_DIR}" && "${process_command}" == *server.mjs*) \
    || "${process_command}" == *"${ROOT_DIR}/server.mjs"* ]]
}

stop_repo_server() {
  local pid="$1"
  local attempts=0

  printf 'Stopping NyxID Chat (pid %s)...\n' "${pid}"
  kill "${pid}" 2>/dev/null || true
  while kill -0 "${pid}" 2>/dev/null && (( attempts < 50 )); do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if kill -0 "${pid}" 2>/dev/null; then
    printf 'Process %s did not stop after 5 seconds; terminating it.\n' "${pid}" >&2
    kill -KILL "${pid}" 2>/dev/null || true
  fi
}

if [[ "${USE_LAUNCHD}" == true ]]; then
  /bin/launchctl remove "${LAUNCH_LABEL}" >/dev/null 2>&1 || true
fi

if [[ -f "${PID_FILE}" ]]; then
  saved_pid="$(sed -n '1p' "${PID_FILE}" 2>/dev/null || true)"
  if is_repo_server "${saved_pid}"; then
    stop_repo_server "${saved_pid}"
  fi
  rm -f "${PID_FILE}"
fi

listener_pids="$(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
for listener_pid in ${listener_pids}; do
  if is_repo_server "${listener_pid}"; then
    stop_repo_server "${listener_pid}"
  else
    listener_command="$(ps -p "${listener_pid}" -o command= 2>/dev/null || true)"
    fail "port ${PORT} is used by another process (pid ${listener_pid}: ${listener_command})"
  fi
done

cd "${ROOT_DIR}"
printf '\n[%s] Starting NyxID Chat on %s:%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${HOST}" "${PORT}" >>"${LOG_FILE}"
server_pid=""
if [[ "${USE_LAUNCHD}" == true ]]; then
  node_path="$(command -v node)"
  /bin/launchctl submit \
    -l "${LAUNCH_LABEL}" \
    -o "${LOG_FILE}" \
    -e "${LOG_FILE}" \
    -- /usr/bin/env HOST="${HOST}" PORT="${PORT}" "${node_path}" "${ROOT_DIR}/server.mjs" \
    || fail "launchd could not start NyxID Chat"
else
  nohup env HOST="${HOST}" PORT="${PORT}" node "${ROOT_DIR}/server.mjs" >>"${LOG_FILE}" 2>&1 </dev/null &
  server_pid=$!
  disown "${server_pid}" 2>/dev/null || true
fi

probe_host="${HOST}"
if [[ "${probe_host}" == "0.0.0.0" || "${probe_host}" == "::" ]]; then
  probe_host="127.0.0.1"
fi
page_url="http://${probe_host}:${PORT}"

for ((attempt = 0; attempt < 40; attempt += 1)); do
  if [[ -n "${server_pid}" ]] && ! kill -0 "${server_pid}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    tail -n 30 "${LOG_FILE}" >&2 || true
    fail "NyxID Chat exited before becoming ready"
  fi
  if curl --silent --fail --max-time 3 "${page_url}/api/demo/config" >/dev/null; then
    server_pid="$(lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [[ -z "${server_pid}" ]] || ! is_repo_server "${server_pid}"; then
      sleep 0.25
      continue
    fi
    printf '%s\n' "${server_pid}" >"${PID_FILE}"
    printf 'NyxID Chat restarted successfully.\n'
    printf 'URL: %s\n' "${page_url}"
    printf 'PID: %s\n' "${server_pid}"
    printf 'Log: %s\n' "${LOG_FILE}"
    if [[ "${USE_LAUNCHD}" == true ]]; then
      printf 'Supervisor: launchd (%s)\n' "${LAUNCH_LABEL}"
    fi
    exit 0
  fi
  sleep 0.25
done

if [[ "${USE_LAUNCHD}" == true ]]; then
  /bin/launchctl remove "${LAUNCH_LABEL}" >/dev/null 2>&1 || true
elif [[ -n "${server_pid}" ]] && is_repo_server "${server_pid}"; then
  stop_repo_server "${server_pid}"
fi
rm -f "${PID_FILE}"
tail -n 30 "${LOG_FILE}" >&2 || true
fail "NyxID Chat did not become ready at ${page_url}"
