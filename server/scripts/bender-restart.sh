#!/bin/bash
# Usage: bender-restart [--force] [reason]
#
# Safely restarts the Bender server with automatic notification
# to whoever requested the restart once the server is back online.
#
# By default, checks for active workers and ABORTS if any are busy.
# Use --force to restart even with active workers (kills them mid-task).
#
# Writes ~/.bender/restart-notification.json before shutting down so the
# server can announce it's back when it boots.
#
# Reads from environment:
#   BENDER_REPLY_CHANNEL  — Slack channel to notify on restart
#   BENDER_REPLY_THREAD   — Slack thread timestamp
#   BENDER_SERVER_PORT    — Server port (default: 3000)
#
# The server reads the notification file on startup, posts to Slack, and deletes it.

FORCE=false
ARGS=()

for arg in "$@"; do
  case "$arg" in
    --force|-f)
      FORCE=true
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

REASON="${ARGS[*]:-restart requested}"
BENDER_DIR="$HOME/.bender"
NOTIFICATION_FILE="$BENDER_DIR/restart-notification.json"
PORT="${BENDER_SERVER_PORT:-3000}"

# Check for busy workers
STATUS_JSON=$(curl -s "localhost:${PORT}/status" 2>/dev/null)
if [ -z "$STATUS_JSON" ]; then
  echo "WARNING: Could not reach server on port ${PORT}. Proceeding anyway." >&2
else
  BUSY_WORKERS=$(echo "$STATUS_JSON" | jq -r '[.workers[] | select(.busy)] | length' 2>/dev/null)
  BUSY_DETAILS=$(echo "$STATUS_JSON" | jq -r '.workers[] | select(.busy) | "  Worker \(.id): \(.current_description // .current_ticket // "unknown task")"' 2>/dev/null)

  if [ "$BUSY_WORKERS" != "0" ] && [ -n "$BUSY_WORKERS" ]; then
    echo "⚠️  ${BUSY_WORKERS} worker(s) currently active:" >&2
    echo "$BUSY_DETAILS" >&2
    echo "" >&2

    if [ "$FORCE" = true ]; then
      echo "--force specified. Restarting anyway (active workers will be killed)." >&2
    else
      echo "Restart ABORTED. Active workers would be killed mid-task." >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  • Wait for workers to finish, then try again" >&2
      echo "  • Use 'bender-restart --force [reason]' to restart anyway" >&2
      exit 1
    fi
  else
    echo "All workers idle. Safe to restart."
  fi
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

echo "Restart notification saved."
echo "Reason: $REASON"

# Restart via systemd
echo "Restarting bender..."
sudo systemctl restart bender

echo "Restart issued. Server will notify on boot."
