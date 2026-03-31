#!/bin/bash
# Usage: bender-track-pr <repo> <pr_number>
# Example: bender-track-pr earthly/lunar-lib 100
#
# Called by Claude after opening a PR to register it on the active session.
# This ensures webhooks for the PR are correctly routed to this session.
# Reads BENDER_TICKET_ID and BENDER_SESSION_DIR from environment.

REPO="$1"
PR_NUMBER="$2"

if [ -z "$REPO" ] || [ -z "$PR_NUMBER" ]; then
  echo "Usage: bender-track-pr <repo> <pr_number>" >&2
  echo "Example: bender-track-pr earthly/lunar-lib 100" >&2
  exit 1
fi

if [ -z "$BENDER_TICKET_ID" ] || [ -z "$BENDER_SESSION_DIR" ]; then
  echo "Missing BENDER_TICKET_ID or BENDER_SESSION_DIR env vars" >&2
  exit 1
fi

SESSION_FILE="$BENDER_SESSION_DIR/$BENDER_TICKET_ID.json"

if [ ! -f "$SESSION_FILE" ]; then
  echo "Session file not found: $SESSION_FILE" >&2
  exit 1
fi

# Update repo, pr_number, advance phase, and clear stale Claude session
# (old session has context for whatever PR was previously linked)
UPDATED=$(jq \
  --arg repo "$REPO" \
  --argjson pr "$PR_NUMBER" \
  '.repo = $repo | .pr_number = $pr | .claude_session_id = null | if .phase == "starting" then .phase = "impl_review" else . end' \
  "$SESSION_FILE")

echo "$UPDATED" > "$SESSION_FILE"
echo "Tracked PR #$PR_NUMBER on $REPO for session $BENDER_TICKET_ID (phase → impl_review)"
