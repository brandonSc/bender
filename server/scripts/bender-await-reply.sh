#!/bin/bash
# Usage: bender-await-reply "Your question or message to the user"
#
# Called by inner Claude when it needs user input before continuing.
# Posts the message to the Slack thread with an instruction footer,
# and writes a waiting-state file so the server routes the reply
# back to handleSlackWork instead of the chat classifier.
#
# Reads from environment:
#   BENDER_REPLY_CHANNEL  — Slack channel to post in
#   BENDER_REPLY_THREAD   — Slack thread timestamp
#   BENDER_TICKET_ID      — Session ticket ID
#   BENDER_SESSION_DIR    — Path to sessions directory
#   SLACK_BOT_TOKEN       — Slack API token

MESSAGE="$*"

if [ -z "$MESSAGE" ]; then
  echo "Usage: bender-await-reply \"Your question here\"" >&2
  exit 1
fi

if [ -z "$BENDER_REPLY_CHANNEL" ] || [ -z "$BENDER_REPLY_THREAD" ] || [ -z "$SLACK_BOT_TOKEN" ]; then
  echo "Missing BENDER_REPLY_CHANNEL, BENDER_REPLY_THREAD, or SLACK_BOT_TOKEN" >&2
  exit 1
fi

FOOTER="_Reply here to answer the worker. Say_ \`bender: your message\` _to talk to parent Bender directly instead._"
FULL_MESSAGE="${MESSAGE}

${FOOTER}"

# Post to Slack
RESULT=$(curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg channel "$BENDER_REPLY_CHANNEL" \
    --arg thread "$BENDER_REPLY_THREAD" \
    --arg text "$FULL_MESSAGE" \
    '{channel: $channel, thread_ts: $thread, text: $text}')")

OK=$(echo "$RESULT" | jq -r '.ok')
if [ "$OK" != "true" ]; then
  echo "Slack post failed: $(echo "$RESULT" | jq -r '.error')" >&2
  exit 1
fi

# Write waiting state file
if [ -n "$BENDER_SESSION_DIR" ]; then
  WAIT_DIR="$BENDER_SESSION_DIR/../waiting"
  mkdir -p "$WAIT_DIR"
  WAIT_KEY="${BENDER_REPLY_CHANNEL}:${BENDER_REPLY_THREAD}"
  SAFE_KEY=$(echo "$WAIT_KEY" | tr '/:' '_')

  jq -n \
    --arg channel "$BENDER_REPLY_CHANNEL" \
    --arg thread "$BENDER_REPLY_THREAD" \
    --arg ticket "$BENDER_TICKET_ID" \
    --arg question "$MESSAGE" \
    --argjson ts "$(date +%s)" \
    '{channel: $channel, thread_ts: $thread, ticket_id: $ticket, question: $question, created_at: $ts}' \
    > "$WAIT_DIR/$SAFE_KEY.json"

  echo "Waiting for reply in thread $BENDER_REPLY_THREAD"
else
  echo "Warning: BENDER_SESSION_DIR not set, waiting state not persisted" >&2
fi
