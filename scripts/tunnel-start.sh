#!/bin/bash

source /Users/dhakornnitipanyawut/nanoclaw/.env

LOG_FILE="/Users/dhakornnitipanyawut/nanoclaw/logs/tunnel.log"
WORKER_DIR="/Users/dhakornnitipanyawut/nanoclaw-webhook/icy-glade-7e94"
WRANGLER_CONFIG="$WORKER_DIR/wrangler.jsonc"

echo "$(date) Starting tunnel..." >> $LOG_FILE

/opt/homebrew/bin/cloudflared tunnel --url localhost:3000 2>&1 | while IFS= read -r line; do
    echo "$(date) $line" >> $LOG_FILE
    if echo "$line" | grep -q "trycloudflare.com"; then
        NEW_URL=$(echo "$line" | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com')
        if [ -n "$NEW_URL" ]; then
            echo "$(date) Got URL: $NEW_URL" >> $LOG_FILE
            sed -i '' "s|\"TUNNEL_URL\": \"[^\"]*\"|\"TUNNEL_URL\": \"$NEW_URL\"|" $WRANGLER_CONFIG
            echo "$(date) Updated wrangler.jsonc" >> $LOG_FILE
            cd $WORKER_DIR
            RESULT=$(npx wrangler deploy 2>&1)
            echo "$(date) Deploy result: $RESULT" >> $LOG_FILE
        fi
    fi
done
