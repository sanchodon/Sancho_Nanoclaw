#!/bin/bash
# NanoClaw ngrok watchdog
# Monitors the ngrok log for heartbeat timeouts.
# When ngrok gets stuck in a "reconnect → immediate heartbeat timeout" loop,
# kills the process so launchd restarts it with a fresh session.

LOG_FILE="/Users/dhakornnitipanyawut/nanoclaw/logs/ngrok.log"
WATCHDOG_LOG="/Users/dhakornnitipanyawut/nanoclaw/logs/ngrok-watchdog.log"
LAST_KILL_FILE="/tmp/.ngrok-watchdog-last-kill"
COOLDOWN=120  # seconds between kills (prevent kill loops)

wlog() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$WATCHDOG_LOG"
  echo "[$(date '+%H:%M:%S')] $1"
}

wlog "=== Watchdog started (PID $$) ==="

# Wait for ngrok log file to appear
until [ -f "$LOG_FILE" ]; do
  wlog "Waiting for $LOG_FILE..."
  sleep 10
done

wlog "Monitoring $LOG_FILE"

tail -F "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
  # Successful session established → clear kill cooldown so next failure gets immediate action
  if echo "$line" | grep -q '"tunnel session started"'; then
    wlog "Tunnel session started OK"
    continue
  fi

  # Heartbeat timeout: ngrok session is dead
  if echo "$line" | grep -q '"heartbeat timeout"'; then
    now=$(date +%s)
    last_kill=$(cat "$LAST_KILL_FILE" 2>/dev/null || echo 0)
    elapsed=$((now - last_kill))

    wlog "Heartbeat timeout detected (${elapsed}s since last kill)"

    if [ "$elapsed" -gt "$COOLDOWN" ]; then
      wlog "Killing ngrok to force fresh restart via launchd..."
      if pkill -f "ngrok http" 2>/dev/null; then
        wlog "ngrok killed — launchd will restart with a fresh session"
        echo "$now" > "$LAST_KILL_FILE"
      else
        wlog "pkill failed (ngrok may have already exited)"
      fi
    else
      wlog "In cooldown (${elapsed}s < ${COOLDOWN}s) — waiting for launchd restart"
    fi
  fi
done
