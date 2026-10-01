#!/usr/bin/env bash
# Supervise the headless panel and the local cloudflared connector.
#
# This host has no systemd (PID 1 is not systemd), so the production unit in
# deploy/systemd/ cannot be the process supervisor here. The script only
# restarts a process that has exited, or a panel port that has stopped
# accepting connections. /panel/readyz returning 503 means the panel is alive
# and the data proxy is down; that must not restart the panel.
#
# Secrets stay in the env file named by KIRO_SUPERVISE_ENV. Do not put the
# tunnel token or admin key in this script.

set -u

ENV_FILE="${KIRO_SUPERVISE_ENV:-$HOME/.config/kiro-supervise/env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少监督配置: $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${KIRO_APP_DIR:?KIRO_APP_DIR 未设置}"
: "${KIRO_DATA_DIR:?KIRO_DATA_DIR 未设置}"
: "${KIRO_PANEL_HOST:=127.0.0.1}"
: "${KIRO_PANEL_PORT:=5590}"
: "${KIRO_TRUSTED_TLS_PROXY_IPS:=127.0.0.1}"
: "${KIRO_ADMIN_KEY:?KIRO_ADMIN_KEY 未设置}"
: "${CLOUDFLARED_TOKEN_FILE:?CLOUDFLARED_TOKEN_FILE 未设置}"
: "${PUBLIC_HEALTH_URL:?PUBLIC_HEALTH_URL 未设置}"
: "${KIRO_SUPERVISE_INTERVAL:=15}"
: "${KIRO_TUNNEL_FAILS_BEFORE_RESTART:=3}"

STATE_DIR="${KIRO_SUPERVISE_STATE:-$HOME/.local/state/kiro-supervise}"
mkdir -p "$STATE_DIR" "$KIRO_DATA_DIR"
chmod 700 "$STATE_DIR" "$KIRO_DATA_DIR"
PANEL_PID_FILE="$STATE_DIR/panel.pid"
TUNNEL_PID_FILE="$STATE_DIR/tunnel.pid"
TUNNEL_FAILS_FILE="$STATE_DIR/tunnel.fails"
PANEL_RESTARTS_FILE="$STATE_DIR/panel.restarts"
LOG_FILE="$STATE_DIR/supervise.log"

export KIRO_DATA_DIR KIRO_PANEL_HOST KIRO_PANEL_PORT KIRO_TRUSTED_TLS_PROXY_IPS KIRO_ADMIN_KEY

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(tr -cd '0-9' <"$file")"
  [[ -n "$pid" ]] || return 1
  printf '%s\n' "$pid"
}

stop_pid() {
  local pid="$1"
  pid_alive "$pid" || return 0
  kill -TERM "$pid" 2>/dev/null || true
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    pid_alive "$pid" || return 0
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
}

panel_http_code() {
  local code
  # curl writes 000 and exits non-zero when the port is closed. Do not append another 000.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'X-Forwarded-For: 127.0.0.1' \
    "http://${KIRO_PANEL_HOST}:${KIRO_PANEL_PORT}/panel/readyz" 2>/dev/null)" || true
  if [[ "$code" =~ ^[0-9]{3}$ ]]; then
    printf '%s\n' "$code"
  else
    printf '000\n'
  fi
}

panel_alive() {
  local code
  code="$(panel_http_code)"
  [[ "$code" == "200" || "$code" == "503" ]]
}

public_reached_origin() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_HEALTH_URL" 2>/dev/null || printf '000')"
  [[ "$code" == "200" || "$code" == "503" ]]
}

recent_restart_burst() {
  local file="$1" now count window_start
  now="$(date +%s)"
  window_start=$((now - 300))
  count=0
  if [[ -f "$file" ]]; then
    local stamp
    while read -r stamp; do
      [[ "$stamp" =~ ^[0-9]+$ ]] || continue
      if ((stamp >= window_start)); then
        count=$((count + 1))
      fi
    done <"$file"
  fi
  ((count >= 5))
}

note_restart() {
  date +%s >>"$1"
}

start_panel() {
  if recent_restart_burst "$PANEL_RESTARTS_FILE"; then
    log "面板 5 分钟内已重启 5 次，暂停拉起，请查看 $STATE_DIR/panel.log"
    return 1
  fi
  local old
  old="$(read_pid "$PANEL_PID_FILE" || true)"
  if [[ -n "${old}" ]]; then
    stop_pid "$old"
  fi
  note_restart "$PANEL_RESTARTS_FILE"
  (
    cd "$KIRO_APP_DIR"
    exec node --enable-source-maps out/server/index.js
  ) >>"$STATE_DIR/panel.log" 2>&1 9>&- &
  local pid=$!
  printf '%s\n' "$pid" >"$PANEL_PID_FILE"
  log "已拉起面板 pid=$pid"
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if panel_alive; then
      log "面板端口已应答"
      return 0
    fi
    pid_alive "$pid" || {
      log "面板进程退出，见 $STATE_DIR/panel.log"
      return 1
    }
    sleep 0.5
  done
  log "面板已启动但端口尚未应答，下一轮再检查"
  return 0
}

start_tunnel() {
  if [[ ! -f "$CLOUDFLARED_TOKEN_FILE" ]]; then
    log "找不到隧道 token 文件"
    return 1
  fi
  local old
  old="$(read_pid "$TUNNEL_PID_FILE" || true)"
  if [[ -n "${old}" ]]; then
    stop_pid "$old"
  fi
  cloudflared tunnel --no-autoupdate run --token-file "$CLOUDFLARED_TOKEN_FILE" \
    >>"$STATE_DIR/tunnel.log" 2>&1 9>&- &
  local pid=$!
  printf '%s\n' "$pid" >"$TUNNEL_PID_FILE"
  printf '0\n' >"$TUNNEL_FAILS_FILE"
  log "已拉起 cloudflared pid=$pid"
}

ensure_panel() {
  local pid
  pid="$(read_pid "$PANEL_PID_FILE" || true)"
  if [[ -n "${pid}" ]] && pid_alive "$pid" && panel_alive; then
    return 0
  fi
  if [[ -n "${pid}" ]] && pid_alive "$pid"; then
    log "面板进程还在，但 5590 不再应答，重新拉起"
  else
    log "面板进程不在，重新拉起"
  fi
  start_panel
}

ensure_tunnel() {
  local pid fails
  pid="$(read_pid "$TUNNEL_PID_FILE" || true)"
  if [[ -z "${pid}" ]] || ! pid_alive "$pid"; then
    log "cloudflared 进程不在，重新拉起"
    start_tunnel
    return 0
  fi
  if ! panel_alive; then
    return 0
  fi
  if public_reached_origin; then
    printf '0\n' >"$TUNNEL_FAILS_FILE"
    return 0
  fi
  fails=0
  [[ -f "$TUNNEL_FAILS_FILE" ]] && fails="$(tr -cd '0-9' <"$TUNNEL_FAILS_FILE")"
  fails=$((fails + 1))
  printf '%s\n' "$fails" >"$TUNNEL_FAILS_FILE"
  log "公网健康检查失败 ${fails}/${KIRO_TUNNEL_FAILS_BEFORE_RESTART}"
  if ((fails >= KIRO_TUNNEL_FAILS_BEFORE_RESTART)); then
    log "隧道连续失败，重新拉起 cloudflared"
    start_tunnel
  fi
}

cmd_status() {
  local panel_pid tunnel_pid code
  panel_pid="$(read_pid "$PANEL_PID_FILE" || true)"
  tunnel_pid="$(read_pid "$TUNNEL_PID_FILE" || true)"
  code="$(panel_http_code)"
  printf 'panel_pid=%s alive=%s local_readyz=%s\n' "${panel_pid:-none}" \
    "$(pid_alive "${panel_pid:-}" && echo yes || echo no)" "$code"
  printf 'tunnel_pid=%s alive=%s\n' "${tunnel_pid:-none}" \
    "$(pid_alive "${tunnel_pid:-}" && echo yes || echo no)"
  if public_reached_origin; then
    echo "public=reachable"
  else
    echo "public=unreachable"
  fi
}

cmd_once() {
  ensure_panel || true
  ensure_tunnel || true
}

cmd_run() {
  exec 9>"$STATE_DIR/supervise.lock"
  if ! flock -n 9; then
    echo "监督进程已在运行" >&2
    exit 0
  fi
  log "监督开始 interval=${KIRO_SUPERVISE_INTERVAL}s"
  while true; do
    ensure_panel || true
    ensure_tunnel || true
    sleep "$KIRO_SUPERVISE_INTERVAL"
  done
}

case "${1:-run}" in
  run) cmd_run ;;
  once) cmd_once ;;
  status) cmd_status ;;
  *)
    echo "用法: $0 run|once|status" >&2
    exit 2
    ;;
esac
