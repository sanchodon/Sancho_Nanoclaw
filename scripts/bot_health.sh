#!/bin/bash

NGROK_API="http://localhost:4040/api/tunnels"
LOG="$HOME/nanoclaw/logs/bot_health.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

STATUS=$(curl -s --max-time 5 "$NGROK_API" | grep -c "public_url")

if [ "$STATUS" -eq 0 ]; then
  echo "[$TIMESTAMP] ngrok is down - restarting..." >> "$LOG"
  launchctl kickstart -k gui/$(id -u)/com.ngrok >> "$LOG" 2>&1
else
  echo "[$TIMESTAMP] ngrok OK" >> "$LOG"
fi