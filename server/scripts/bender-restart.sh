#!/bin/bash
# Usage: bender-restart [reason]
#
# Safely restarts the Bender server via pm2, with automatic notification
# to whoever requested the restart once the server is back online.
#
# Writes ~/.bender/restart-notification.json before shutting down so the
# server can announce it's back when it boots.
#
# Reads from environment:
#   BENDER_REPLY_CHANNEL  — Slack channel to notify on restart
#   BENDER_REPLY_THREAD   — Slack thread timestamp
#   SLACK_BOT_TOKEN       — (optional) used to identify requester
#
# The server reads the notification file on startup, posts to Slack, and deletes it.

REASON="${*:-restart requested}"
BENDER_DIR="$HOME/.bender"
NOTIFICATION_FILE="$BENDER_DIR/restart-notification.json"

# Check for busy workers first
BUSY=$(curl -s localhost:3457/status 2>/dev/null | jq -r '.workers[] | select(.busy) | .id' 2>/dev/null)
if [ -n "$BUSY" ]; then
  echo "ERROR: Workers are busy — cannot restart safely." >&2
  echo "Busy workers: $BUSY" >&2
  echo "Wait for them to finish or use 'pm2 restart bender' to force it." >&2
  exit 1
fi

# Write notification file so the server can announce it's back
mkdir -p "$BENDER_DIR"
jq -n \
  --arg channel "${BENDER_REPLY_CHANNEL:-}" \
  --arg thread "${BENDER_REPLY_THREAD:-}" \
  --arg reason "$REASON" \
  --argjson ts "$(date +%s)" \
  '{
    channel: $channel,
    thread_ts: $thread,
    reason: $reason,
    requested_at: $ts
  }' > "$NOTIFICATION_FILE"

echo "Restart notification saved to $NOTIFICATION_FILE"
echo "Reason: $REASON"

# Restart via pm2
echo "Restarting bender..."
pm2 restart bender

echo "Restart issued. Server will notify on boot."
